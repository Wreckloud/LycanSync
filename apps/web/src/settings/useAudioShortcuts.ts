import { onScopeDispose, ref, watch } from 'vue';

export type AudioShortcutAction = 'microphone' | 'listening';
export type AudioShortcutBindings = Record<AudioShortcutAction, string>;

export function shortcutFromKey(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  if (event.metaKey) throw new Error('Windows 键组合由系统保留，请使用其他组合');
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
    : /^F(?:[1-9]|10|11)$/.test(event.code) ? event.code : '';
  if (!key || (!/^F(?:[1-9]|10|11)$/.test(key) && !event.ctrlKey && !event.altKey)) throw new Error('请使用 Ctrl／Alt 加字母或数字，或 F1–F11');
  if (key === 'F4' && event.altKey && !event.ctrlKey && !event.shiftKey) throw new Error('Alt+F4 用于关闭窗口，请使用其他组合');
  return [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+');
}

export function useAudioShortcuts(userId: string, options: {
  roomId: () => string | null;
  microphone: () => Promise<void>;
  listening: () => Promise<void>;
}, bridge = window.lycanAudioShortcuts, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const bindings = ref<AudioShortcutBindings>({ microphone: '', listening: '' });
  const error = ref('');
  const ready = ref(false);
  const busy = ref(false);
  const capturing = ref<AudioShortcutAction | null>(null);
  const storageKey = `lycansync.audio-shortcuts.v1.${userId}`;
  let owner: string | undefined;
  let disposed = false;
  let captureVersion = 0;
  let activationVersion = 0;
  let actionPending = false;
  const failure = '快捷键无法生效，可能已被其他程序占用。请修改或重新启用。';
  try {
    const stored = storage.getItem(storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      const pattern = /^(?:(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:F[1-9]|F10|F11)|(?:(?:Ctrl\+)(?:Alt\+)?(?:Shift\+)?|Alt\+(?:Shift\+)?)[A-Z0-9])$/;
      if (!parsed || ['microphone', 'listening'].some(action => typeof parsed[action] !== 'string'
          || (parsed[action] !== '' && !pattern.test(parsed[action])))
          || (parsed.microphone && parsed.microphone === parsed.listening)) throw new Error('invalid shortcut preferences');
      bindings.value = { microphone: parsed.microphone, listening: parsed.listening };
    }
  } catch { error.value = '无法读取快捷键偏好，本次不启用；请重新设置。'; }

  const initialized = (async () => {
    if (!bridge) return;
    try {
      const token = await bridge.begin();
      if (disposed) { await bridge.end(token); return; }
      owner = token;
      await bridge.configure(token, bindings.value);
      if (!disposed) await bridge.activate(token, options.roomId());
    } catch { if (!disposed) error.value = failure; }
    finally { if (!disposed) ready.value = true; }
  })();

  const removeAction = bridge?.onAction(event => {
    if (disposed || event.owner !== owner || !event.roomId || event.roomId !== options.roomId()
        || capturing.value || busy.value || actionPending || !['microphone', 'listening'].includes(event.action)) return;
    actionPending = true;
    void options[event.action]().catch(() => { if (!disposed) error.value = '音频操作未完成，请查看通话状态后重试。'; })
      .finally(() => { actionPending = false; });
  });
  const removeError = bridge?.onError(event => { if (!disposed && event.owner === owner) error.value = event.message; });

  async function activate() {
    const version = ++activationVersion;
    await initialized;
    if (disposed || !bridge || !owner) return;
    try { await bridge.activate(owner, options.roomId()); }
    catch { if (!disposed && version === activationVersion) error.value = failure; }
  }
  watch(options.roomId, () => { void activate(); });

  async function startCapture(action: AudioShortcutAction) {
    if (!bridge || !owner || !ready.value || busy.value) return;
    const version = ++captureVersion;
    capturing.value = action;
    busy.value = true;
    try {
      await bridge.capture(owner, true);
      if (!disposed && version === captureVersion) { capturing.value = action; error.value = ''; }
      else await bridge.capture(owner, false);
    } catch { if (!disposed) { capturing.value = null; error.value = failure; } }
    finally { busy.value = false; }
  }

  async function cancelCapture() {
    if (!capturing.value) return;
    captureVersion++;
    capturing.value = null;
    if (!bridge || !owner || disposed) return;
    try { await bridge.capture(owner, false); }
    catch { error.value = failure; }
  }

  async function setBinding(action: AudioShortcutAction, binding: string) {
    if (!bridge || !owner || !ready.value || busy.value) return;
    const next = { ...bindings.value, [action]: binding };
    if (binding && next.microphone === next.listening) { error.value = '两个动作不能使用同一快捷键'; return; }
    busy.value = true;
    try {
      await bridge.configure(owner, next);
      if (disposed) return;
      bindings.value = next;
      error.value = '';
      try { storage.setItem(storageKey, JSON.stringify(next)); }
      catch { error.value = '快捷键本次已生效，但无法保存到本机。'; }
    } catch { if (!disposed) error.value = failure; }
    finally { capturing.value = null; busy.value = false; }
  }

  async function retry() {
    if (!bridge || busy.value || disposed) return;
    busy.value = true;
    try {
      if (!owner) {
        const token = await bridge.begin();
        if (disposed) { await bridge.end(token); return; }
        owner = token;
      }
      await bridge.configure(owner, bindings.value);
      if (!disposed) { await bridge.activate(owner, options.roomId()); error.value = ''; }
    }
    catch { error.value = failure; }
    finally { busy.value = false; }
  }

  onScopeDispose(() => {
    disposed = true;
    removeAction?.(); removeError?.();
    if (owner) void bridge?.end(owner).catch(() => console.warn('audio shortcut cleanup failed'));
  });
  return { supported: Boolean(bridge), bindings, error, ready, busy, capturing, startCapture, cancelCapture, setBinding, retry };
}

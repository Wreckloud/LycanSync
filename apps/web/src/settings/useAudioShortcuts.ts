import { onScopeDispose, ref, watch } from 'vue';

export type AudioShortcutAction = 'microphone' | 'listening' | 'pushToTalk';
export type VoiceMode = 'voice' | 'pushToTalk';
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
  modeChanged: (mode: VoiceMode) => void;
  transmissionChanged: (held: boolean) => void;
}, bridge = window.lycanAudioShortcuts, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const bindings = ref<AudioShortcutBindings>({ microphone: '', listening: '', pushToTalk: '' });
  const voiceMode = ref<VoiceMode>('voice');
  const held = ref(false);
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
  let holdVersion = 0;
  let holdSequence = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdResponseTimer: ReturnType<typeof setTimeout> | undefined;
  const failure = '快捷键无法生效，可能已被其他程序占用。请修改或重新启用。';
  try {
    const stored = storage.getItem(storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      const pattern = /^(?:(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:F[1-9]|F10|F11)|(?:(?:Ctrl\+)(?:Alt\+)?(?:Shift\+)?|Alt\+(?:Shift\+)?)[A-Z0-9])$/;
      if (!parsed || ['microphone', 'listening'].some(action => typeof parsed[action] !== 'string'
          || (parsed[action] !== '' && !pattern.test(parsed[action])))
          || (parsed.microphone && parsed.microphone === parsed.listening)) throw new Error('invalid shortcut preferences');
      const pushToTalk = parsed.pushToTalk ?? '';
      const mode = parsed.voiceMode ?? 'voice';
      if (typeof pushToTalk !== 'string' || (pushToTalk && !pattern.test(pushToTalk))
          || !['voice', 'pushToTalk'].includes(mode)
          || (pushToTalk && [parsed.microphone, parsed.listening].includes(pushToTalk))) throw new Error('invalid speech preferences');
      bindings.value = { microphone: parsed.microphone, listening: parsed.listening, pushToTalk };
      voiceMode.value = mode;
    }
  } catch { voiceMode.value = 'pushToTalk'; error.value = '无法读取发言偏好，本次停止发声，请重新选择发言模式。'; }
  options.modeChanged(voiceMode.value);

  function stopHold() {
    holdVersion++;
    clearTimeout(holdTimer); holdTimer = undefined;
    clearTimeout(holdResponseTimer); holdResponseTimer = undefined;
    held.value = false;
    options.transmissionChanged(false);
  }
  function save() {
    try { storage.setItem(storageKey, JSON.stringify({ ...bindings.value, voiceMode: voiceMode.value })); }
    catch { error.value = '本次设置已生效，但无法保存到本机。'; }
  }
  async function pollHold(sequence: number, version: number) {
    if (!bridge || !owner || disposed || version !== holdVersion) return;
    const roomId = options.roomId();
    if (!roomId) { stopHold(); return; }
    const requestedAt = performance.now();
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        responseTimer = setTimeout(() => reject(new Error('pushToTalkTimedOut')), 150);
        holdResponseTimer = responseTimer;
      });
      const pressed = await Promise.race([bridge.readHold(owner, roomId, sequence), timeout]);
      if (disposed || version !== holdVersion || options.roomId() !== roomId) return;
      // 迟到消息须重新确认真实按键；旧回复不能续期已经关闭的音频。
      if (!pressed || performance.now() - requestedAt > 150) { stopHold(); return; }
      held.value = true;
      options.transmissionChanged(true);
      holdTimer = setTimeout(() => { void pollHold(sequence, version); }, 40);
    } catch {
      if (!disposed && version === holdVersion) { stopHold(); error.value = '按键说话响应中断，请松开按键后重试。'; }
    } finally {
      clearTimeout(responseTimer);
      if (holdResponseTimer === responseTimer) holdResponseTimer = undefined;
    }
  }

  const initialized = (async () => {
    if (!bridge) return;
    try {
      const token = await bridge.begin();
      if (disposed) { await bridge.end(token); return; }
      owner = token;
      await bridge.configure(token, bindings.value, voiceMode.value === 'pushToTalk');
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
  const removeHold = bridge?.onHold(event => {
    if (disposed || event.owner !== owner || event.roomId !== options.roomId()
        || !Number.isSafeInteger(event.sequence) || event.sequence <= holdSequence) return;
    holdSequence = event.sequence;
    stopHold();
    if (event.held && voiceMode.value === 'pushToTalk' && !capturing.value && !busy.value) {
      void pollHold(event.sequence, holdVersion);
    }
  });
  const removeError = bridge?.onError(event => { if (!disposed && event.owner === owner) { stopHold(); error.value = event.message; } });

  async function activate() {
    const version = ++activationVersion;
    await initialized;
    if (disposed || !bridge || !owner) return;
    try { await bridge.activate(owner, options.roomId()); }
    catch { if (!disposed && version === activationVersion) error.value = failure; }
  }
  watch(options.roomId, () => { stopHold(); void activate(); }, { flush: 'sync' });

  async function startCapture(action: AudioShortcutAction) {
    if (!bridge || !owner || !ready.value || busy.value) return;
    const version = ++captureVersion;
    stopHold();
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
    const used = Object.values(next).filter(Boolean);
    if (new Set(used).size !== used.length) { error.value = '动作不能使用同一快捷键'; return; }
    stopHold();
    busy.value = true;
    try {
      await bridge.configure(owner, next, voiceMode.value === 'pushToTalk');
      if (disposed) return;
      bindings.value = next;
      error.value = '';
      save();
    } catch { if (!disposed) error.value = failure; }
    finally { capturing.value = null; busy.value = false; }
  }

  async function setVoiceMode(mode: VoiceMode) {
    if (disposed || busy.value || !['voice', 'pushToTalk'].includes(mode)) return;
    if (mode === 'pushToTalk' && !bridge) { error.value = '全局按键说话仅支持 Windows 桌面客户端。'; return; }
    stopHold();
    voiceMode.value = mode;
    options.modeChanged(mode);
    error.value = '';
    save();
    if (!bridge || !owner) return;
    busy.value = true;
    try { await bridge.configure(owner, bindings.value, mode === 'pushToTalk'); }
    catch { if (!disposed) error.value = failure; }
    finally { busy.value = false; }
  }

  async function retry() {
    if (!bridge || busy.value || disposed) return;
    busy.value = true;
    try {
      if (!owner) {
        const token = await bridge.begin();
        if (disposed) { await bridge.end(token); return; }
        owner = token;
        holdSequence = 0;
      }
      stopHold();
      await bridge.configure(owner, bindings.value, voiceMode.value === 'pushToTalk');
      if (!disposed) { await bridge.activate(owner, options.roomId()); error.value = ''; }
    }
    catch { error.value = failure; }
    finally { busy.value = false; }
  }

  onScopeDispose(() => {
    disposed = true;
    stopHold();
    removeAction?.(); removeError?.(); removeHold?.();
    if (owner) void bridge?.end(owner).catch(() => console.warn('audio shortcut cleanup failed'));
  });
  return { supported: Boolean(bridge), bindings, voiceMode, held, error, ready, busy, capturing,
    startCapture, cancelCapture, setBinding, setVoiceMode, retry };
}

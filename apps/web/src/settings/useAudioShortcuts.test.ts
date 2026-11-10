import { effectScope, isProxy, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { shortcutFromKey, useAudioShortcuts } from './useAudioShortcuts';

async function settle() { for (let index = 0; index < 8; index++) await nextTick(); }
afterEach(() => vi.useRealTimers());
function fixture(begin: () => Promise<string> = async () => 'owner', stored: string | null = null) {
  const scope = effectScope();
  const room = ref<string | null>(null);
  let action!: Parameters<NonNullable<Window['lycanAudioShortcuts']>['onAction']>[0];
  let hold!: Parameters<NonNullable<Window['lycanAudioShortcuts']>['onHold']>[0];
  const bridge = { begin: vi.fn(begin), configure: vi.fn(async (_owner: string, bindings: unknown) => {
    expect(isProxy(bindings)).toBe(false);
    structuredClone(bindings);
  }), activate: vi.fn(async () => {}),
    capture: vi.fn(async () => {}), end: vi.fn(async () => {}),
    readHold: vi.fn(async () => false), onHold: (callback: typeof hold) => { hold = callback; return vi.fn(); },
    onAction: (callback: typeof action) => { action = callback; return vi.fn(); }, onError: () => vi.fn() };
  const microphone = vi.fn(async () => {}), listening = vi.fn(async () => {}), replay = vi.fn(async () => {});
  const replayId = ref<string | null>(null);
  const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const modeChanged = vi.fn(), transmissionChanged = vi.fn();
  const shortcuts = scope.run(() => useAudioShortcuts('self', { roomId: () => room.value,
    microphone, listening, replay, replayId: () => replayId.value, modeChanged, transmissionChanged }, bridge, storage))!;
  return { scope, room, bridge, microphone, listening, replay, replayId, storage, shortcuts, modeChanged, transmissionChanged,
    replayAction: (id: string) => action({ owner: 'owner', roomId: null, action: 'replay', replayId: id }),
    hold: (sequence: number, held: boolean, roomId = room.value!) => hold({ owner: 'owner', roomId, sequence, held }),
    action: (roomId: string) => action({ roomId, owner: 'owner', action: 'microphone' }) };
}

it('保存回放绑定当前缓存身份，不依赖通话，慢保存不阻挡麦克风快捷键', async () => {
  const f = fixture();
  try {
    await settle();
    f.replayId.value = 'buffer-new';
    f.replayAction('buffer-old'); expect(f.replay).not.toHaveBeenCalled();
    let finish!: () => void;
    f.replay.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.replayAction('buffer-new'); f.replayAction('buffer-new');
    expect(f.replay).toHaveBeenCalledTimes(1);
    f.room.value = 'room'; await settle();
    f.action('room'); await settle();
    expect(f.microphone).toHaveBeenCalledTimes(1);
    finish(); await settle();
    f.replayId.value = null;
    f.replayAction('buffer-new'); expect(f.replay).toHaveBeenCalledTimes(1);
  } finally { f.scope.stop(); }
});

it('录入字母、数字、符号单键及组合键，仍拒绝系统保留键', () => {
  const event = { code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
  expect(shortcutFromKey(event)).toBe('Ctrl+Shift+M');
  expect(shortcutFromKey({ ...event, code: 'KeyF', ctrlKey: false })).toBe('Shift+F');
  expect(shortcutFromKey({ ...event, code: 'Digit9', ctrlKey: false, shiftKey: false })).toBe('9');
  for (const [code, key] of Object.entries({ Semicolon: ';', Equal: '=', Comma: ',', Minus: '-', Period: '.',
    Slash: '/', Backquote: '`', BracketLeft: '[', Backslash: '\\', BracketRight: ']', Quote: "'" })) {
    expect(shortcutFromKey({ ...event, code, ctrlKey: false, shiftKey: false })).toBe(key);
    expect(shortcutFromKey({ ...event, code, shiftKey: false })).toBe(`Ctrl+${key}`);
  }
  expect(() => shortcutFromKey({ ...event, code: 'F12' })).toThrow();
  expect(() => shortcutFromKey({ ...event, metaKey: true })).toThrow();
});

it('单键和符号保存后可重新载入，与原组合键兼容', async () => {
  for (const key of ['M', '9', ';', '=', ',', '-', '.', '/', '`', '[', '\\', ']', "'", 'Shift+;', 'Ctrl+Alt+Shift+/']) {
    const bindings = { microphone: 'Ctrl+M', listening: 'Alt+L', pushToTalk: key, replay: 'F2' };
    const f = fixture(undefined, JSON.stringify({ ...bindings, voiceMode: 'pushToTalk' }));
    try {
      await settle();
      expect(f.shortcuts.error.value).toBe('');
      expect(f.shortcuts.voiceMode.value).toBe('pushToTalk');
      expect(f.shortcuts.bindings.value).toEqual(bindings);
      expect(f.bridge.configure).toHaveBeenLastCalledWith('owner', bindings, true);
      await f.shortcuts.setBinding('pushToTalk', key);
      expect(JSON.parse(f.storage.setItem.mock.calls.at(-1)![1]).pushToTalk).toBe(key);
    } finally { f.scope.stop(); }
  }
});

it('初始化、切换发言模式及重试均传递可克隆配置并激活当前房间', async () => {
  const f = fixture();
  try {
    await settle();
    expect(f.shortcuts.error.value).toBe('');
    expect(f.bridge.activate).toHaveBeenCalledWith('owner', null);
    await f.shortcuts.setBinding('pushToTalk', 'F2');
    await f.shortcuts.setVoiceMode('pushToTalk');
    expect(f.shortcuts.error.value).toBe('');
    f.room.value = 'room'; await settle();
    await f.shortcuts.retry();
    expect(f.shortcuts.error.value).toBe('');
    expect(f.bridge.configure).toHaveBeenLastCalledWith('owner', {
      microphone: '', listening: '', pushToTalk: 'F2', replay: '',
    }, true);
    expect(f.bridge.activate).toHaveBeenLastCalledWith('owner', 'room');
  } finally { f.scope.stop(); }
});

it('按住后确认当前键状态才续期，松开停止查询，不切换手动静音意愿', async () => {
  const f = fixture(); await settle();
  vi.useFakeTimers();
  await f.shortcuts.setBinding('pushToTalk', 'F2');
  await f.shortcuts.setVoiceMode('pushToTalk');
  f.room.value = 'room'; await settle();
  f.bridge.readHold.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  f.hold(1, true); await settle();
  expect(f.transmissionChanged).toHaveBeenLastCalledWith(true);
  expect(f.shortcuts.held.value).toBe(true);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.transmissionChanged).toHaveBeenLastCalledWith(false);
  expect(f.shortcuts.held.value).toBe(false);
  const calls = f.bridge.readHold.mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(f.bridge.readHold).toHaveBeenCalledTimes(calls);
  expect(f.microphone).not.toHaveBeenCalled();
  expect(f.modeChanged).toHaveBeenLastCalledWith('pushToTalk');
  f.scope.stop();
});

it('迟到的查询和旧房间事件不能开口，主进程不回复时关闭并提示', async () => {
  const f = fixture(); await settle();
  vi.useFakeTimers();
  await f.shortcuts.setVoiceMode('pushToTalk');
  f.room.value = 'room'; await settle();
  let complete!: (held: boolean) => void;
  f.bridge.readHold.mockImplementationOnce(() => new Promise<boolean>(resolve => { complete = resolve; }));
  f.hold(1, true); await settle();
  await vi.advanceTimersByTimeAsync(160);
  expect(f.shortcuts.error.value).toContain('响应中断');
  expect(f.shortcuts.held.value).toBe(false);
  complete(true); await settle();
  expect(f.transmissionChanged).not.toHaveBeenLastCalledWith(true);
  f.room.value = 'new'; await settle();
  f.hold(2, true, 'room'); await settle();
  expect(f.bridge.readHold).toHaveBeenCalledOnce();
  f.scope.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('模式意愿先关闭自由发送，注册失败也保存按键模式，不能悄悄恢复自由发言', async () => {
  const f = fixture(); await settle();
  f.bridge.configure.mockRejectedValueOnce(new Error('occupied'));
  await f.shortcuts.setVoiceMode('pushToTalk');
  expect(f.shortcuts.voiceMode.value).toBe('pushToTalk');
  expect(f.modeChanged).toHaveBeenLastCalledWith('pushToTalk');
  expect(f.shortcuts.error.value).toContain('占用');
  expect(JSON.parse(f.storage.setItem.mock.calls.at(-1)![1]).voiceMode).toBe('pushToTalk');
  f.scope.stop();
});

it('全局事件只操作当前房间，录入期间不触发，释放后恢复且偏好只在成功时保存', async () => {
  const f = fixture();
  await settle();
  expect(f.shortcuts.ready.value).toBe(true);
  f.room.value = 'room'; await settle();
  f.action('old'); expect(f.microphone).not.toHaveBeenCalled();
  await f.shortcuts.startCapture('microphone');
  f.action('room'); expect(f.microphone).not.toHaveBeenCalled();
  await f.shortcuts.setBinding('microphone', 'Ctrl+M');
  expect(f.storage.setItem).toHaveBeenCalledOnce();
  f.action('room'); await settle();
  expect(f.microphone).toHaveBeenCalledOnce();
  f.bridge.configure.mockRejectedValueOnce(new Error('occupied'));
  await f.shortcuts.setBinding('microphone', 'Ctrl+K');
  expect(f.shortcuts.bindings.value.microphone).toBe('Ctrl+M');
  expect(f.storage.setItem).toHaveBeenCalledOnce();
  expect(f.shortcuts.error.value).toContain('占用');
  f.scope.stop(); await settle();
  expect(f.bridge.end).toHaveBeenCalledWith('owner');
});

it('录入未准备完成就离开时恢复原绑定', async () => {
  const f = fixture(); await settle();
  let complete!: () => void;
  f.bridge.capture.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const capturing = f.shortcuts.startCapture('microphone');
  await f.shortcuts.cancelCapture();
  complete(); await capturing;
  expect(f.shortcuts.capturing.value).toBeNull();
  expect(f.bridge.capture).toHaveBeenLastCalledWith('owner', false);
  f.scope.stop();
});

it('销毁后迟到的初始化只释放会话，不再注册或启用快捷键', async () => {
  let complete!: (owner: string) => void;
  const f = fixture(() => new Promise<string>(resolve => { complete = resolve; }));
  f.scope.stop();
  complete('late-owner'); await settle();
  expect(f.bridge.end).toHaveBeenCalledWith('late-owner');
  expect(f.bridge.configure).not.toHaveBeenCalled();
  expect(f.bridge.activate).not.toHaveBeenCalled();
});

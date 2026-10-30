import { effectScope, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { shortcutFromKey, useAudioShortcuts } from './useAudioShortcuts';

async function settle() { for (let index = 0; index < 8; index++) await nextTick(); }
function fixture(begin: () => Promise<string> = async () => 'owner') {
  const scope = effectScope();
  const room = ref<string | null>(null);
  let action!: Parameters<NonNullable<Window['lycanAudioShortcuts']>['onAction']>[0];
  const bridge = { begin: vi.fn(begin), configure: vi.fn(async () => {}), activate: vi.fn(async () => {}),
    capture: vi.fn(async () => {}), end: vi.fn(async () => {}),
    onAction: (callback: typeof action) => { action = callback; return vi.fn(); }, onError: () => vi.fn() };
  const microphone = vi.fn(async () => {}), listening = vi.fn(async () => {});
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const shortcuts = scope.run(() => useAudioShortcuts('self', { roomId: () => room.value, microphone, listening }, bridge, storage))!;
  return { scope, room, bridge, microphone, listening, storage, shortcuts,
    action: (roomId: string) => action({ roomId, owner: 'owner', action: 'microphone' }) };
}

it('录入组合不接受普通字母、系统保留键或 F12', () => {
  const event = { code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
  expect(shortcutFromKey(event)).toBe('Ctrl+Shift+M');
  expect(() => shortcutFromKey({ ...event, code: 'KeyF', ctrlKey: false })).toThrow();
  expect(() => shortcutFromKey({ ...event, code: 'F12' })).toThrow();
  expect(() => shortcutFromKey({ ...event, metaKey: true })).toThrow();
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

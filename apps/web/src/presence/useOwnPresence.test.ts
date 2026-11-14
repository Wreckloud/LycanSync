import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useOwnPresence } from './useOwnPresence';
import { usePresencePreference, type PresenceMode } from './usePresencePreference';
import { sendPresenceHeartbeat } from './presenceApi';

vi.mock('./presenceApi', async original => ({ ...await original<object>(), sendPresenceHeartbeat: vi.fn(async () => {}) }));
vi.mock('./usePresencePreference', () => ({ usePresencePreference: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 4; turn++) await nextTick(); }

function setup() {
  let clock = 0;
  class TestElement { closest() { return this; } }
  class TestKeyboardEvent { repeat = false; key = 'a'; }
  const listeners = new Map<string, (event: Event) => void>();
  vi.stubGlobal('performance', { now: () => clock });
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('KeyboardEvent', TestKeyboardEvent);
  vi.stubGlobal('document', { visibilityState: 'visible',
    addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name) });
  const scope = effectScope();
  const initialActivity = deferred<DetectedActivity | null>();
  const removeActivityListener = vi.fn();
  let activityListener!: (activity: DetectedActivity | null) => void;
  const desktop = { getCurrentActivity: vi.fn(() => initialActivity.promise),
    getSystemIdleState: vi.fn(async (): Promise<{ state: 'active' | 'idle' | 'locked' | 'unknown'; idleSeconds: number }> => ({ state: 'active', idleSeconds: 0 })),
    getServerSettings: vi.fn(),
    onActivityChange: vi.fn((listener: typeof activityListener) => { activityListener = listener; return removeActivityListener; }) };
  const visibility = { showActivity: ref(true), showLastOnline: ref(true) };
  const mode = ref<PresenceMode>('online');
  const preference = { mode, ready: ref(true), error: ref(''), loaded: Promise.resolve(), setMode: (next: PresenceMode) => { mode.value = next; } };
  vi.mocked(usePresencePreference).mockReturnValue(preference);
  vi.mocked(sendPresenceHeartbeat).mockReset().mockResolvedValue(undefined);
  const app = scope.run(() => useOwnPresence('self', visibility, desktop))!;
  const state = { ...app, ...visibility, presencePreference: preference, sendPresenceHeartbeat: vi.mocked(sendPresenceHeartbeat) };
  return { app, state, desktop, initialActivity, scope, listeners, removeActivityListener,
    advanceClock: (ms: number) => { clock += ms; },
    interact: (trusted = true) => listeners.get('click')!({ isTrusted: trusted, target: new TestElement() } as unknown as Event),
    notifyActivity: (activity: DetectedActivity | null) => activityListener(activity), stop: () => scope.stop() };
}

it('重复启动只创建一组计时器，销毁移除输入及活动监听并停止同步', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = setup();
  try {
    f.app.startPresenceHeartbeat(); f.app.startPresenceHeartbeat(); await settle();
    expect(vi.getTimerCount()).toBe(2);
    expect(f.listeners.size).toBe(2);
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledTimes(2);
    f.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.listeners.size).toBe(0);
    expect(f.removeActivityListener).toHaveBeenCalledOnce();
    f.app.startPresenceHeartbeat(); await f.app.sendHeartbeat();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledTimes(2);
  } finally { f.stop(); }
});

it('关闭时撤销在途心跳及排队状态，旧请求结束后不能重新公开在线', async () => {
  const f = setup(); const pending = deferred<void>();
  f.state.sendPresenceHeartbeat.mockReturnValueOnce(pending.promise);
  try {
    const sending = f.app.sendHeartbeat(); await settle();
    const signal = f.state.sendPresenceHeartbeat.mock.calls[0][2]!;
    const hiding = f.app.changePresenceMode('invisible');
    await f.app.reportOfflineBeforeClose();
    expect(signal.aborted).toBe(true);
    expect(f.app.stopped).toBe(true);
    pending.resolve(); await Promise.all([sending, hiding]);
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledTimes(2);
    expect(f.state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal),
      { showActivity: true, showLastOnline: true });
  } finally { f.stop(); }
});

it('游戏快捷共享的本机窗口身份不会进入公开心跳', async () => {
  const f = setup();
  try {
    f.notifyActivity({ type: 'GAME', name: '游戏', startedAt: '2026-11-08T00:00:00Z', windowIds: ['123'] });
    await settle();
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledWith('ONLINE', { type: 'GAME', name: '游戏' },
      expect.any(AbortSignal), { showActivity: true, showLastOnline: true });
  } finally { f.stop(); }
});

it('关闭前取消待发在线心跳，离线请求带上本次尚未同步的隐私选择', async () => {
  const { state, app, stop } = setup();
  try {
    state.showActivity.value = false;
    state.showLastOnline.value = false;
    await app.reportOfflineBeforeClose();
    expect(app.stopped).toBe(true);
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal),
      { showActivity: false, showLastOnline: false });
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('闲置五分钟或锁屏判离开，持续输入确认后判在线，查询失败保留原状态', async () => {
  const { state, app, desktop, stop, advanceClock } = setup();
  try {
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'active', idleSeconds: 300 });
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
    desktop.getSystemIdleState.mockRejectedValueOnce(new Error('system unavailable'));
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'unknown', idleSeconds: 0 });
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
    advanceClock(2000); await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('ONLINE');
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'locked', idleSeconds: 0 });
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
  } finally { stop(); }
});

it('初始旧活动快照不覆盖新事件，关闭隐私只上报空活动并保留本机检测', async () => {
  const { state, initialActivity, notifyActivity, stop } = setup();
  try {
    const current: DetectedActivity = { type: 'GAME', name: '当前游戏', startedAt: '2026-10-15T00:00:00Z' };
    notifyActivity(current);
    initialActivity.resolve({ ...current, name: '旧游戏' });
    await settle();
    expect(state.currentActivity.value?.name).toBe('当前游戏');
    state.showActivity.value = false;
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    expect(state.currentActivity.value?.name).toBe('当前游戏');
  } finally { stop(); }
});

it('停止后迟到闲置和活动结果不能重开心跳或覆盖当前展示', async () => {
  const { state, app, desktop, initialActivity, stop } = setup();
  const idle = deferred<{ state: 'locked'; idleSeconds: number }>();
  desktop.getSystemIdleState.mockReturnValueOnce(idle.promise);
  const reading = app.updateOwnPresenceStatus();
  stop();
  idle.resolve({ state: 'locked', idleSeconds: 600 });
  initialActivity.resolve({ type: 'GAME', name: '迟到游戏', startedAt: '2026-10-15T00:00:00Z' });
  await reading;
  await settle();
  expect(state.currentPresenceStatus.value).toBe('ONLINE');
  expect(state.currentActivity.value).toBeNull();
  expect(state.sendPresenceHeartbeat).not.toHaveBeenCalled();
});

it('音乐沿用同一公开开关，只上报类型和名称，不附带窗口或进程信息', async () => {
  const { state, notifyActivity, stop } = setup();
  try {
    notifyActivity({ type: 'MUSIC', name: '歌曲', startedAt: '2026-10-15T00:00:00Z' });
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', { type: 'MUSIC', name: '歌曲' }, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    state.showActivity.value = false;
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    expect(state.currentActivity.value?.name).toBe('歌曲');
  } finally { stop(); }
});

it('旧在线心跳未完成时合并隐身请求，完成后只发送最新离线状态', async () => {
  const { state, app, notifyActivity, stop } = setup();
  const first = deferred<void>();
  state.sendPresenceHeartbeat.mockReturnValueOnce(first.promise);
  try {
    const sending = app.sendHeartbeat();
    await settle();
    const hiding = app.changePresenceMode('invisible');
    notifyActivity({ type: 'GAME', name: '仍在游戏', startedAt: '2026-10-30T04:00:00Z' });
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenCalledOnce();
    first.resolve();
    await Promise.all([sending, hiding]);
    expect(state.sendPresenceHeartbeat).toHaveBeenCalledTimes(2);
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    expect(state.currentActivity.value?.name).toBe('仍在游戏');
  } finally { stop(); }
});

it('首次心跳等待偏好，恢复隐身后活动与闲置变化不能公开在线', async () => {
  const { state, app, notifyActivity, desktop, stop } = setup();
  const reading = deferred<void>();
  state.presencePreference.loaded = reading.promise;
  try {
    const sending = app.sendHeartbeat();
    await settle();
    expect(state.sendPresenceHeartbeat).not.toHaveBeenCalled();
    state.presenceMode.value = 'invisible';
    notifyActivity({ type: 'MUSIC', name: '歌曲', startedAt: '2026-10-30T04:00:00Z' });
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'locked', idleSeconds: 600 });
    await app.updateOwnPresenceStatus();
    reading.resolve();
    await sending;
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    state.currentPresenceStatus.value = 'ONLINE';
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'active', idleSeconds: 0 });
    await app.changePresenceMode('online');
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', { type: 'MUSIC', name: '歌曲' }, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    state.showActivity.value = false;
    await app.changePresenceMode('invisible');
    await app.changePresenceMode('online');
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
  } finally { stop(); }
});

it('同步失败保留隐身意愿并显示未确认，下次成功清除提示', async () => {
  const { state, app, stop } = setup();
  state.sendPresenceHeartbeat.mockRejectedValueOnce(new Error('network'));
  try {
    await app.changePresenceMode('invisible');
    expect(state.presenceMode.value).toBe('invisible');
    expect(state.presenceSyncError.value).toContain('尚未同步');
    await app.sendHeartbeat();
    expect(state.presenceSyncError.value).toBe('');
  } finally { stop(); }
});

it('停止期间仍在读取偏好时，迟到读取不能再发送心跳', async () => {
  const { state, app, stop } = setup();
  const reading = deferred<void>();
  state.presencePreference.loaded = reading.promise;
  const sending = app.sendHeartbeat();
  stop();
  reading.resolve();
  await sending;
  expect(state.sendPresenceHeartbeat).not.toHaveBeenCalled();
});

it('切回在线沿用当前闲置，迟到的在线选择不能覆盖更新的隐身操作', async () => {
  const { state, app, desktop, stop } = setup();
  try {
    await app.changePresenceMode('invisible');
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'locked', idleSeconds: 600 });
    await app.changePresenceMode('online');
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('AWAY', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
    const reading = deferred<{ state: 'active'; idleSeconds: number }>();
    desktop.getSystemIdleState.mockReturnValueOnce(reading.promise);
    const online = app.changePresenceMode('online');
    await app.changePresenceMode('invisible');
    reading.resolve({ state: 'active', idleSeconds: 0 });
    await online;
    expect(state.presenceMode.value).toBe('invisible');
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal), { showActivity: state.showActivity.value, showLastOnline: state.showLastOnline.value });
  } finally { stop(); }
});

it('单次误触后等待不会恢复在线，连续采样同一次输入也不累计', async () => {
  const f = setup();
  try {
    f.state.currentPresenceStatus.value = 'AWAY';
    await f.app.updateOwnPresenceStatus();
    for (let seconds = 1; seconds <= 8; seconds++) {
      f.advanceClock(1000);
      f.desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'active', idleSeconds: seconds });
      await f.app.updateOwnPresenceStatus();
    }
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    expect(f.state.sendPresenceHeartbeat).not.toHaveBeenCalled();
  } finally { f.stop(); }
});

it('两次正常轮询确认持续输入后立即上报在线，不再等待六秒', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = setup();
  try {
    f.desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'locked', idleSeconds: 600 });
    f.app.startPresenceHeartbeat(); await settle();
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.state.sendPresenceHeartbeat.mockClear();
    f.advanceClock(2000); await vi.advanceTimersByTimeAsync(2000);
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.advanceClock(2000); await vi.advanceTimersByTimeAsync(2000);
    expect(f.state.currentPresenceStatus.value).toBe('ONLINE');
    expect(f.state.sendPresenceHeartbeat).toHaveBeenCalledOnce();
    expect(f.state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal), expect.any(Object));
  } finally { f.stop(); }
});

it('恢复期间额外查询不会延长确认时间，隐身也不会被持续输入解除', async () => {
  const f = setup();
  try {
    f.state.currentPresenceStatus.value = 'AWAY';
    f.state.presenceMode.value = 'invisible';
    await f.app.updateOwnPresenceStatus();
    f.advanceClock(1100); await f.app.updateOwnPresenceStatus();
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.advanceClock(900); await f.app.updateOwnPresenceStatus(); await settle();
    expect(f.state.currentPresenceStatus.value).toBe('ONLINE');
    expect(f.state.publicPresenceStatus.value).toBe('OFFLINE');
    expect(f.state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal), expect.any(Object));
  } finally { f.stop(); }
});

it('取整误差、停顿和系统查询失败不能凑出持续操作', async () => {
  const f = setup();
  try {
    f.state.currentPresenceStatus.value = 'AWAY';
    await f.app.updateOwnPresenceStatus();
    f.advanceClock(2400);
    f.desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'active', idleSeconds: 2 });
    await f.app.updateOwnPresenceStatus();
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.advanceClock(2000);
    f.desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'active', idleSeconds: 4 });
    await f.app.updateOwnPresenceStatus();
    await f.app.updateOwnPresenceStatus();
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.advanceClock(2000);
    f.desktop.getSystemIdleState.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await f.app.updateOwnPresenceStatus();
    await f.app.updateOwnPresenceStatus();
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.advanceClock(2000); await f.app.updateOwnPresenceStatus();
    expect(f.state.currentPresenceStatus.value).toBe('ONLINE');
  } finally { f.stop(); }
});

it('可信应用操作立即恢复，但不会解除隐身；迟到的闲置查询不能覆盖操作', async () => {
  const f = setup();
  try {
    f.app.startPresenceHeartbeat(); await settle();
    f.state.currentPresenceStatus.value = 'AWAY';
    f.interact(false);
    expect(f.state.currentPresenceStatus.value).toBe('AWAY');
    f.state.presenceMode.value = 'invisible';
    const pending = deferred<{ state: 'locked'; idleSeconds: number }>();
    f.desktop.getSystemIdleState.mockReturnValueOnce(pending.promise);
    const reading = f.app.updateOwnPresenceStatus();
    f.interact();
    expect(f.state.currentPresenceStatus.value).toBe('ONLINE');
    expect(f.state.presenceMode.value).toBe('invisible');
    pending.resolve({ state: 'locked', idleSeconds: 500 });
    await reading;
    await settle();
    expect(f.state.currentPresenceStatus.value).toBe('ONLINE');
    expect(f.state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal), expect.any(Object));
  } finally { f.stop(); }
});

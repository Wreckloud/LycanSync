import { EventEmitter } from 'node:events';
import { effectScope, ref, shallowRef } from 'vue';
import { RoomEvent, Track, type Participant, type Room } from 'livekit-client';
import { afterEach, expect, it, vi } from 'vitest';
import { useScreenShareWindows } from './useScreenShareWindows';

afterEach(() => vi.useRealTimers());

function fixture(desktop?: Pick<NonNullable<Window['lycanDesktop']>, 'focusViewerWindow' | 'onViewerClosed'>) {
  class ViewerWindow extends EventTarget {
    closed = false;
    document = { getElementById: () => ({}) };
    focus = vi.fn();
    close = vi.fn(() => { this.closed = true; this.dispatchEvent(new Event('pagehide')); });
  }
  const windows: ViewerWindow[] = [];
  function child(): ViewerWindow {
    const result = new ViewerWindow();
    windows.push(result);
    return result;
  }
  const owner = Object.assign(new EventTarget(), { location: { origin: 'lycan://app' }, open: vi.fn(child), lycanDesktop: desktop });
  const room = shallowRef(new EventEmitter() as unknown as Room);
  const a = { identity: 'A', isScreenShareEnabled: true } as Participant;
  const b = { identity: 'B', isScreenShareEnabled: true } as Participant;
  const participants = shallowRef([a, b]);
  const revision = ref(0), status = ref('connected');
  const sessions: Record<string, string> = { A: 'first', B: 'second' };
  const notice = vi.fn(), closed = vi.fn(), scope = effectScope();
  const manager = scope.run(() => useScreenShareWindows({
    room: () => room.value, participants: () => participants.value, status: () => status.value,
    revision: () => revision.value, shareSessionId: (identity) => sessions[identity], notice, closed,
  }, owner as unknown as Window))!;
  function ready(index = 0, patch = {}) {
    const entry = manager.entries.value[index];
    const event = new Event('message');
    Object.assign(event, { origin: 'lycan://app', source: entry.window, data: { type: 'lycan-viewer-ready', id: entry.id }, ...patch });
    owner.dispatchEvent(event);
  }
  return { manager, scope, room, a, b, participants, revision, status, sessions, notice, closed, owner, windows, ready };
}

it('重复打开只唤回原窗口，多路可同时打开，子页面就绪才提供 Vue 挂载目标', () => {
  const f = fixture();
  expect(f.manager.open('A')).toBe(true);
  expect(f.manager.open('A')).toBe(true);
  expect(f.windows).toHaveLength(1); expect(f.windows[0]!.focus).toHaveBeenCalledOnce();
  expect(f.manager.entries.value[0]!.target).toBeNull();
  f.ready(0, { source: {} });
  expect(f.manager.entries.value[0]!.target).toBeNull();
  f.ready(); expect(f.manager.entries.value[0]!.target).not.toBeNull();
  f.manager.open('B'); f.ready(1);
  expect(f.manager.entries.value).toHaveLength(2);
  f.windows[0]!.dispatchEvent(new Event('pagehide'));
  expect(f.manager.entries.value.map((entry) => entry.participant.identity)).toEqual(['B']);
  expect(f.b.isScreenShareEnabled).toBe(true);
  expect(f.windows[1]!.closed).toBe(false);
  f.scope.stop();
});

it('初始空白页的 pagehide 不会取消未就绪窗口；清理后迟到就绪不能恢复', () => {
  const f = fixture(); f.manager.open('A');
  const entry = f.manager.entries.value[0]!;
  f.windows[0]!.dispatchEvent(new Event('pagehide'));
  expect(f.manager.entries.value).toHaveLength(1);
  f.manager.closeAll();
  const event = new Event('message');
  Object.assign(event, { origin: 'lycan://app', source: entry.window, data: { type: 'lycan-viewer-ready', id: entry.id } });
  f.owner.dispatchEvent(event);
  expect(f.manager.entries.value).toEqual([]);
  expect(entry.target).toBeNull();
  expect(f.closed).toHaveBeenCalledExactlyOnceWith('A', 'first');
  f.scope.stop();
});

it('停止后显示结束，不自动跟随下一次共享；用户重新打开才创建新的观看位置', () => {
  const f = fixture(); f.manager.open('A'); f.ready();
  const first = f.manager.entries.value[0]!;
  Object.assign(f.a, { isScreenShareEnabled: false }); f.revision.value++;
  expect(first.ended).toBe(true);
  Object.assign(f.a, { isScreenShareEnabled: true }); f.sessions.A = 'new'; f.revision.value++;
  expect(first.ended).toBe(true);
  expect(f.manager.open('A')).toBe(true);
  expect(f.manager.entries.value[0]!.id).not.toBe(first.id);
  expect(f.manager.entries.value[0]!.ended).toBe(false);
  expect(f.windows[0]!.closed).toBe(true);
  f.scope.stop();
});

it('重连的空列表和旧发布不会结束观看；重连完成核对原共享，不能接管新会话', () => {
  const f = fixture(); f.manager.open('A'); f.ready();
  f.status.value = 'reconnecting'; f.participants.value = []; f.revision.value++;
  expect(f.manager.entries.value[0]!.ended).toBe(false);
  Object.assign(f.a, { isScreenShareEnabled: false }); f.participants.value = [f.a];
  f.status.value = 'connected'; f.revision.value++;
  expect(f.manager.entries.value[0]!.ended).toBe(false);
  Object.assign(f.a, { isScreenShareEnabled: true }); f.revision.value++;
  f.room.value.emit(RoomEvent.Reconnected);
  expect(f.manager.entries.value[0]!.ended).toBe(false);
  f.sessions.A = 'replacement'; f.revision.value++;
  expect(f.manager.entries.value[0]!.ended).toBe(true);
  f.scope.stop();
});

it('新远控授权早于界面版本刷新时，按会话替换旧窗，关闭回调仍属于旧会话', () => {
  const f = fixture(); f.manager.open('A'); f.ready();
  f.sessions.A = 'control-share';
  expect(f.manager.open('A')).toBe(true);
  expect(f.windows).toHaveLength(2);
  expect(f.closed).toHaveBeenCalledExactlyOnceWith('A', 'first');
  expect(f.manager.entries.value[0]!.shareSessionId).toBe('control-share');
  expect(f.manager.entries.value[0]!.ended).toBe(false);
  f.scope.stop();
});

it('成员离房关闭对应窗，实际切房在异步就绪前关闭全部，旧房事件不影响新房', () => {
  const f = fixture(); f.manager.open('A'); f.manager.open('B');
  (f.room.value as unknown as EventEmitter).emit(RoomEvent.ParticipantDisconnected, f.a);
  expect(f.manager.entries.value.map((entry) => entry.participant.identity)).toEqual(['B']);
  const previous = f.room.value;
  f.room.value = new EventEmitter() as unknown as Room;
  expect(f.manager.entries.value).toEqual([]);
  expect(f.windows.every((window) => window.closed)).toBe(true);
  f.manager.open('A'); f.ready();
  (previous as unknown as EventEmitter).emit(RoomEvent.ParticipantDisconnected, f.a);
  (previous as unknown as EventEmitter).emit(RoomEvent.TrackUnpublished, { source: Track.Source.ScreenShare });
  expect(f.manager.entries.value).toHaveLength(1);
  f.scope.stop();
});

it('超时和弹窗被阻止均明确失败，不创建房间或关闭其他分享', () => {
  vi.useFakeTimers();
  const f = fixture(); f.manager.open('A');
  vi.advanceTimersByTime(8000);
  expect(f.manager.entries.value).toEqual([]);
  expect(f.notice).toHaveBeenCalledOnce();
  expect(f.windows[0]!.closed).toBe(true);
  expect(f.a.isScreenShareEnabled).toBe(true);
  f.owner.open.mockReturnValueOnce(null as never);
  expect(f.manager.open('B')).toBe(false);
  expect(f.notice).toHaveBeenCalledTimes(2);
  f.scope.stop();
});

it('原生唤回的旧失败和关闭通知不能误关新房间窗口，销毁时撤销订阅', async () => {
  let rejectFocus!: (error: Error) => void;
  let nativeClosed!: Parameters<NonNullable<Window['lycanDesktop']>['onViewerClosed']>[0];
  const stopNative = vi.fn();
  const f = fixture({
    focusViewerWindow: vi.fn(() => new Promise<void>((_, reject) => { rejectFocus = reject; })),
    onViewerClosed: (listener) => { nativeClosed = listener; return stopNative; },
  });
  f.manager.open('A'); f.ready();
  const previous = f.manager.entries.value[0]!;
  f.manager.open('A');
  f.room.value = new EventEmitter() as unknown as Room;
  f.manager.open('A'); f.ready();
  const current = f.manager.entries.value[0]!;
  rejectFocus(new Error('旧窗口已关闭'));
  await Promise.resolve();
  nativeClosed({ id: previous.id, failed: true });
  expect(f.manager.entries.value).toEqual([current]);
  expect(f.notice).not.toHaveBeenCalled();
  nativeClosed({ id: current.id, failed: true });
  expect(f.manager.entries.value).toEqual([]);
  expect(f.notice).toHaveBeenCalledOnce();
  expect(f.a.isScreenShareEnabled).toBe(true);
  f.scope.stop();
  expect(stopNative).toHaveBeenCalledOnce();
});

it('解除输入向每个存活窗口同步发出，不关闭窗口或改变共享', () => {
  const f = fixture(); f.manager.open('A'); f.manager.open('B');
  const release = [vi.fn(), vi.fn()];
  f.windows.forEach((window, index) => window.addEventListener('lycan-viewer-disarm', release[index]!));
  f.manager.disarmAll();
  expect(release.every((listener) => listener.mock.calls.length === 1)).toBe(true);
  expect(f.manager.entries.value).toHaveLength(2);
  expect(f.closed).not.toHaveBeenCalled();
  expect(f.windows.every((window) => !window.closed)).toBe(true);
  f.scope.stop();
});

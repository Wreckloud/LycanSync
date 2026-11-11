import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useGroupPresences } from './useGroupPresences';
import { findGroupPresences, waitForGroupPresenceChanges, type GroupPresence, type GroupPresenceChangeCursor } from './groupApi';

vi.mock('./groupApi', () => ({ findGroupPresences: vi.fn(), waitForGroupPresenceChanges: vi.fn(),
  nextPresenceWaitRequest: vi.fn(() => ({ clientId: 'test', requestId: 1 })) }));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
const presence = (userId: string): GroupPresence => ({ userId, status: 'ONLINE', lastSeenAt: null,
  activityType: null, activityName: null, activityStartedAt: null });
const cursor = (version = 1, detailVersion = 1, changed = false): GroupPresenceChangeCursor =>
  ({ serverInstanceId: 'server', version, detailVersion, changed });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const waiting: ReturnType<typeof deferred<GroupPresenceChangeCursor>>[] = [];
  const find = vi.mocked(findGroupPresences).mockReset().mockResolvedValue([presence('self')]);
  const wait = vi.mocked(waitForGroupPresenceChanges).mockReset().mockImplementation(() => {
    const pending = deferred<GroupPresenceChangeCursor>(); waiting.push(pending); return pending.promise;
  });
  const selected = ref<string | null>(null);
  const members = [{ userId: 'self', nickname: '自己', avatar: '', role: 'MEMBER' as const, joinedAt: '2026-11-11T00:00:00Z' }];
  const detail = ref({ id: 'group', members });
  const refreshDetail = vi.fn(async () => {});
  const scope = effectScope(); scopes.push(scope);
  const app = scope.run(() => useGroupPresences(selected, () => detail.value, refreshDetail))!;
  return { app, selected, detail, refreshDetail, scope, find, wait, waiting };
}

it('名单变化复核资料，仅状态变化不加载；退出群预览后清空状态', async () => {
  const f = setup();
  f.find.mockResolvedValue([presence('self'), presence('friend')]);
  f.selected.value = 'group'; await settle();
  expect(f.refreshDetail).toHaveBeenCalledExactlyOnceWith('group', true);
  expect(Object.keys(f.app.groupPresences.value)).toEqual(['self', 'friend']);
  f.detail.value.members.push({ userId: 'friend', nickname: '朋友', avatar: '', role: 'MEMBER', joinedAt: '2026-11-11T00:00:00Z' });
  f.app.refreshGroupPresence(); await settle();
  expect(f.refreshDetail).toHaveBeenCalledOnce();
  f.selected.value = null; await settle();
  expect(f.app.groupPresences.value).toEqual({});
  expect(f.app.presenceConnectionLost.value).toBe(false);
  expect(f.wait.mock.calls.at(-1)![4].aborted).toBe(true);
});

it('首个游标与资料版本变化才复核资料，状态变化只刷新快照', async () => {
  const f = setup(); f.selected.value = 'group'; await settle();
  f.waiting[0].resolve(cursor()); await settle();
  expect(f.refreshDetail).toHaveBeenCalledExactlyOnceWith('group', true);
  expect(f.wait.mock.calls[1][3]).toEqual({ serverInstanceId: 'server', version: 1, detailVersion: 1 });
  f.waiting[1].resolve(cursor(2, 1, true)); await settle();
  expect(f.find).toHaveBeenCalledTimes(2);
  expect(f.refreshDetail).toHaveBeenCalledOnce();
  f.waiting[2].resolve(cursor(3, 2)); await settle();
  expect(f.refreshDetail).toHaveBeenCalledTimes(2);
  f.waiting[3].resolve({ ...cursor(0, 2), serverInstanceId: 'new-server' }); await settle();
  expect(f.refreshDetail).toHaveBeenCalledTimes(3);
});

it('切群取消旧快照，迟到成功不改写新群；停止后长轮询不重启', async () => {
  const f = setup(); const old = deferred<GroupPresence[]>();
  f.find.mockReturnValueOnce(old.promise);
  f.selected.value = 'group'; await settle();
  const oldSignal = f.find.mock.calls[0][1]!;
  f.selected.value = 'other'; await settle();
  expect(oldSignal.aborted).toBe(true);
  old.resolve([presence('old-member')]); await settle();
  expect(Object.keys(f.app.groupPresences.value)).toEqual(['self']);
  expect(f.refreshDetail).not.toHaveBeenCalled();
  f.scope.stop();
  expect(f.wait.mock.calls[0][4].aborted).toBe(true);
  f.waiting[0].resolve(cursor(1, 1, true)); await settle();
  expect(f.wait).toHaveBeenCalledOnce();
  expect(f.find).toHaveBeenCalledTimes(2);
  expect(f.refreshDetail).not.toHaveBeenCalled();
});

it('切群后旧长轮询失败不显示断连，不安排新重试', async () => {
  vi.useFakeTimers();
  const f = setup(); f.selected.value = 'group'; await settle();
  f.selected.value = 'other'; await settle();
  expect(f.wait.mock.calls[0][4].aborted).toBe(true);
  f.waiting[0].reject(new Error('old request')); await settle();
  expect(f.app.presenceConnectionLost.value).toBe(false);
  await vi.advanceTimersByTimeAsync(16000);
  expect(f.find).toHaveBeenCalledTimes(2);
});

it('断连逐步退避，成功后恢复；重试等待由销毁负责清理', async () => {
  vi.useFakeTimers();
  const f = setup(); f.find.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
  f.selected.value = 'group'; await settle();
  expect(f.app.presenceConnectionLost.value).toBe(true);
  await vi.advanceTimersByTimeAsync(999); expect(f.find).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.find).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999); expect(f.find).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.find).toHaveBeenCalledTimes(3);
  expect(f.app.presenceConnectionLost.value).toBe(false);
  f.waiting[0].resolve(cursor()); await settle();
  f.waiting[1].reject(new Error('network')); await settle();
  await vi.advanceTimersByTimeAsync(1000); expect(f.find).toHaveBeenCalledTimes(4);
  f.waiting[2].reject(new Error('network')); await settle();
  expect(vi.getTimerCount()).toBe(1);
  f.scope.stop(); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(16000);
  expect(f.find).toHaveBeenCalledTimes(4);
});

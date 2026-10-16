import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import type { RtcRoomSummary } from './rtc/roomSummaryApi';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const functionNames = ['applyDetectedActivity', 'sendHeartbeat', 'stopPresenceHeartbeat', 'updateOwnPresenceStatus',
  'refreshOnActivation', 'handlePresenceNetworkRestored', 'refreshGroupPresences', 'leaveVoice'];
const variableNames = ['PRESENCE_IDLE_TIMEOUT_MS', 'activityRevision', 'activitySnapshotRevision', 'removeActivityListener',
  'fetchedRoomSummary', 'roomSummary', 'groupHasVoiceActivity'];
const callbacks = sourceFile.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return Boolean(statement.name && functionNames.includes(statement.name.text));
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
    .some((declaration) => variableNames.includes(declaration.name.getText(sourceFile)));
  const text = statement.getText(sourceFile);
  return text.startsWith('void desktop?.getCurrentActivity()') || text.startsWith('watch(showActivity,')
    || text.startsWith('watch(fetchedRoomSummary,') || text.startsWith('onScopeDispose(() => removeActivityListener');
}).map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() { for (let turn = 0; turn < 4; turn++) await nextTick(); }

function setup() {
  const scope = effectScope();
  const initialActivity = deferred<DetectedActivity | null>();
  const leaving = deferred<void>();
  const removeActivityListener = vi.fn();
  let activityListener!: (activity: DetectedActivity | null) => void;
  const desktop = { getCurrentActivity: vi.fn(() => initialActivity.promise),
    getSystemIdleState: vi.fn(async () => ({ state: 'active', idleSeconds: 0 })),
    onActivityChange: vi.fn((listener: typeof activityListener) => { activityListener = listener; return removeActivityListener; }) };
  const currentActivity = ref<DetectedActivity | null>(null);
  const showActivity = ref(true);
  const rawSummary = ref<RtcRoomSummary | null>({ participantCount: 2, participants: [
    { participantIdentity: 'user-self', displayName: '自己' }, { participantIdentity: 'user-friend', displayName: '朋友' },
  ] });
  const state = {
    props: { user: { id: 'self' } }, currentActivity, showActivity,
    sharedActivity: computed(() => showActivity.value ? currentActivity.value : null),
    currentPresenceStatus: ref('ONLINE'), presenceStopped: false,
    presenceAbort: null as AbortController | null, presenceHeartbeatTimer: null,
    selectedGroupId: ref<string | null>('group'), joinedGroupId: ref<string | null>('group'),
    selectedGroupDetail: ref({ id: 'group', members: [{ userId: 'self' }] }), groupPresences: ref({}),
    groupPresenceWatchGeneration: 0, presenceConnectionLost: ref(false), loadGroup: vi.fn(async () => {}),
    findGroupPresences: vi.fn(async () => [{ userId: 'self' }, { userId: 'friend' }].map((member) => ({ ...member,
      status: 'ONLINE', lastSeenAt: null, activityType: null, activityName: null, activityStartedAt: null }))),
    joiningGroupId: ref<string | null>(null), joinedGroupDetail: ref<unknown>(null),
    locallyLeftVoiceGroupId: ref<string | null>(null), roomSummaryRefreshVersion: ref(0),
    summaryError: ref<string | null>(null), roomOccupancies: ref<Record<string, number>>({ group: 2 }),
    roomOccupancyRequest: new AbortController(), joinAttempt: 0, lastActivationRefreshAt: 0,
    departingGroupId: ref<string | null>(null), callbarLeaving: ref(false),
    pendingSwitchGroupId: ref<string | null>(null), membersExpanded: ref(false), viewerNotice: ref(''),
    rtc: { status: 'connected', participants: [{ identity: 'user-self' }, { identity: 'user-friend' }],
      leave: vi.fn(() => leaving.promise) },
    stage: { reset: vi.fn() }, selectCaptureSource: vi.fn(), releaseViewerLock: vi.fn(), endStageDrag: vi.fn(),
    callSounds: { left: vi.fn(async () => {}) }, sendPresenceHeartbeat: vi.fn(async () => {}),
    refreshRoomOccupancies: vi.fn(async () => {}), refreshGroups: vi.fn(async () => {}), startGroupPresenceSync: vi.fn(),
  };
  const showingJoinedGroup = computed(() => state.joinedGroupId.value !== null && state.joinedGroupId.value === state.selectedGroupId.value);
  // 正式 App 回调、派生状态和监听；RTC/系统闲置/活动/HTTP 边界受控，不连接房间或设备。
  const sandbox = {
    ...state, desktop, showingJoinedGroup, computed, watch, onScopeDispose, AbortController, clearInterval,
    document: { visibilityState: 'visible' }, useRoomSummary: () => rawSummary,
  };
  const app = scope.run(() => runInNewContext(`${compiled}\n({ ${functionNames.join(', ')}, roomSummary, groupHasVoiceActivity })`, sandbox)) as {
    applyDetectedActivity: (activity: DetectedActivity | null) => void; stopPresenceHeartbeat: () => void;
    updateOwnPresenceStatus: () => Promise<void>; refreshOnActivation: () => void; handlePresenceNetworkRestored: () => void;
    refreshGroupPresences: (groupId: string, generation: number, signal: AbortSignal) => Promise<boolean>;
    leaveVoice: () => void; roomSummary: { value: RtcRoomSummary | null }; groupHasVoiceActivity: (groupId: string) => boolean;
  };
  return { scope, state: sandbox, app, desktop, rawSummary, leaving, initialActivity, removeActivityListener,
    notifyActivity: (activity: DetectedActivity | null) => activityListener(activity),
    stop: () => { app.stopPresenceHeartbeat(); scope.stop(); } };
}

it('离房立即过滤自己并保留朋友；清理确认后再刷新，旧占用请求已取消', async () => {
  const { state, app, leaving, stop } = setup();
  try {
    app.leaveVoice();
    expect(state.joinedGroupId.value).toBeNull();
    expect(app.roomSummary.value?.participants.map((member) => member.participantIdentity)).toEqual(['user-friend']);
    expect(app.roomSummary.value?.participantCount).toBe(1);
    expect(state.roomOccupancies.value.group).toBe(1);
    expect(state.roomOccupancyRequest.signal.aborted).toBe(true);
    expect(state.refreshGroups).toHaveBeenCalledWith(true, false);
    expect(state.refreshRoomOccupancies).not.toHaveBeenCalled();
    leaving.resolve();
    await settle();
    expect(state.roomSummaryRefreshVersion.value).toBe(1);
    expect(state.refreshRoomOccupancies).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('自己是最后一人时旧服务器快照不能保留语音徽标，不修改服务端快照', () => {
  const { state, app, rawSummary, stop } = setup();
  try {
    state.rtc.participants = [{ identity: 'user-self' }];
    rawSummary.value = { participantCount: 1, participants: [{ participantIdentity: 'user-self', displayName: '自己' }] };
    app.leaveVoice();
    expect(app.roomSummary.value?.participantCount).toBe(0);
    expect(app.groupHasVoiceActivity('group')).toBe(false);
    expect(rawSummary.value.participantCount).toBe(1);
  } finally { stop(); }
});

it('离房失败保留明确提示，销毁后迟到成功不再查询', async () => {
  const first = setup();
  try {
    first.app.leaveVoice();
    first.leaving.reject(new Error('disconnect failed'));
    await settle();
    expect(first.state.viewerNotice.value).toContain('离开语音未能确认');
  } finally { first.stop(); }
  const second = setup();
  second.app.leaveVoice();
  second.stop();
  second.leaving.resolve();
  await settle();
  expect(second.state.refreshRoomOccupancies).not.toHaveBeenCalled();
});

it.each([false, true])('新入房操作开始后旧离房结果不改提示或发起刷新（失败：%s）', async (failed) => {
  const { state, app, leaving, stop } = setup();
  try {
    app.leaveVoice();
    state.joinAttempt++;
    state.joiningGroupId.value = 'new-group';
    state.viewerNotice.value = '新房间提示';
    if (failed) leaving.reject(new Error('old disconnect failed'));
    else leaving.resolve();
    await settle();
    expect(state.viewerNotice.value).toBe('新房间提示');
    expect(state.roomSummaryRefreshVersion.value).toBe(0);
    expect(state.refreshRoomOccupancies).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('离房修正只针对原群和本人，服务端确认无人后恢复正常摘要', async () => {
  const { state, app, rawSummary, stop } = setup();
  try {
    app.leaveVoice();
    state.selectedGroupId.value = 'other-group';
    expect(app.roomSummary.value?.participantCount).toBe(2);
    state.selectedGroupId.value = 'group';
    rawSummary.value = { participantCount: 0, participants: [] };
    await settle();
    expect(state.locallyLeftVoiceGroupId.value).toBeNull();
    expect(app.roomSummary.value?.participantCount).toBe(0);
  } finally { stop(); }
});

it('成员快照的名单变化立即复核资料，仅状态变化不重复加载，旧群结果无权刷新', async () => {
  const { state, app, stop } = setup();
  try {
    await app.refreshGroupPresences('group', 0, new AbortController().signal);
    expect(state.loadGroup).toHaveBeenCalledExactlyOnceWith('group', true);
    state.selectedGroupDetail.value.members.push({ userId: 'friend' });
    await app.refreshGroupPresences('group', 0, new AbortController().signal);
    expect(state.loadGroup).toHaveBeenCalledOnce();
    state.selectedGroupId.value = 'other';
    const result = await app.refreshGroupPresences('group', 0, new AbortController().signal);
    expect(result).toBe(false);
    expect(state.loadGroup).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('闲置五分钟或锁屏判离开，恢复输入立即判在线，查询失败保留原状态', async () => {
  const { state, app, desktop, stop } = setup();
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
    expect(state.currentPresenceStatus.value).toBe('ONLINE');
    desktop.getSystemIdleState.mockResolvedValueOnce({ state: 'locked', idleSeconds: 0 });
    await app.updateOwnPresenceStatus();
    expect(state.currentPresenceStatus.value).toBe('AWAY');
  } finally { stop(); }
});

it('网络或窗口恢复立即上报心跳、复核闲置及刷新成员，不等待周期', async () => {
  const { state, app, desktop, stop } = setup();
  try {
    app.handlePresenceNetworkRestored();
    expect(state.sendPresenceHeartbeat).toHaveBeenCalledOnce();
    expect(desktop.getSystemIdleState).toHaveBeenCalledOnce();
    expect(state.startGroupPresenceSync).toHaveBeenCalledWith('group', true);
    expect(state.refreshRoomOccupancies).toHaveBeenCalledOnce();
    expect(state.roomSummaryRefreshVersion.value).toBe(1);
    app.refreshOnActivation();
    expect(state.refreshGroups).toHaveBeenCalledOnce();
    expect(desktop.getSystemIdleState).toHaveBeenCalledTimes(2);
    expect(state.roomSummaryRefreshVersion.value).toBe(2);
    await settle();
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
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal));
    expect(state.currentActivity.value?.name).toBe('当前游戏');
  } finally { stop(); }
});

it('停止后迟到闲置和活动结果不能重开心跳或覆盖当前展示', async () => {
  const { state, app, desktop, initialActivity, stop } = setup();
  const idle = deferred<{ state: string; idleSeconds: number }>();
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
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', { type: 'MUSIC', name: '歌曲' }, expect.any(AbortSignal));
    state.showActivity.value = false;
    await settle();
    expect(state.sendPresenceHeartbeat).toHaveBeenLastCalledWith('ONLINE', null, expect.any(AbortSignal));
    expect(state.currentActivity.value?.name).toBe('歌曲');
  } finally { stop(); }
});

it('本人和群成员的音乐/游戏展示一致，离线和关闭动态均不占用第二行', () => {
  const names = ['memberActivity', 'memberOnlineStatus'];
  const statements = sourceFile.statements.filter((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(sourceFile))));
  const state = { props: { user: { id: 'self' } }, currentPresenceStatus: ref('ONLINE'),
    sharedActivity: ref<DetectedActivity | null>({ type: 'MUSIC', name: '歌曲', startedAt: '2026-10-15T00:00:00Z' }),
    groupPresences: ref({ friend: { status: 'ONLINE', activityType: 'MUSIC', activityName: '歌曲', activityStartedAt: '2026-10-15T00:00:00Z' } }),
    formatActivityDuration: () => '1:00' };
  const body = statements.map((statement) => statement.getText(sourceFile)).join('\n');
  const display = runInNewContext(`${ts.transpile(body)}\nmemberActivity`, state) as (member: { userId: string }) => { type: string; text: string } | null;
  expect(display({ userId: 'self' })?.text).toBe('正在听 歌曲');
  expect(display({ userId: 'friend' })?.text).toBe('正在听 歌曲');
  state.groupPresences.value.friend.status = 'OFFLINE';
  expect(display({ userId: 'friend' })).toBeNull();
  state.sharedActivity.value = null;
  expect(display({ userId: 'self' })).toBeNull();
  state.sharedActivity.value = { type: 'GAME', name: '游戏', startedAt: '2026-10-15T00:00:00Z' };
  expect(display({ userId: 'self' })?.text).toBe('正在玩 游戏 · 1:00');
});

function setupOccupancies() {
  const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'refreshRoomOccupancies')!;
  const body = ts.transpile(declaration.getText(sourceFile), { target: ts.ScriptTarget.ES2022 });
  const pending: Array<{ resolve: (rooms: Array<{ groupId: string; participantCount: number }>) => void;
    reject: (error: Error) => void; signal: AbortSignal }> = [];
  const state = { roomOccupancyRequest: null as AbortController | null, roomOccupancies: ref<Record<string, number>>({}),
    AbortController, requestRoomOccupancies: vi.fn((signal: AbortSignal) => new Promise((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    })) };
  const refresh = runInNewContext(`${body}\nrefreshRoomOccupancies`, state) as (force?: boolean) => Promise<void>;
  return { state, pending, refresh };
}

it('慢速占用请求不被周期刷新反复取消，完成后可以继续查询', async () => {
  const { state, pending, refresh } = setupOccupancies();
  const first = refresh();
  await refresh();
  expect(state.requestRoomOccupancies).toHaveBeenCalledOnce();
  expect(pending[0].signal.aborted).toBe(false);
  pending[0].resolve([{ groupId: 'group', participantCount: 1 }]);
  await first;
  expect(state.roomOccupancyRequest).toBeNull();
  const second = refresh();
  pending[1].resolve([{ groupId: 'group', participantCount: 2 }]);
  await second;
  expect(state.roomOccupancies.value.group).toBe(2);
});

it('离房完成后的强制刷新取消旧快照，旧结果不覆盖新人数', async () => {
  const { state, pending, refresh } = setupOccupancies();
  const old = refresh();
  const current = refresh(true);
  expect(pending[0].signal.aborted).toBe(true);
  pending[1].resolve([{ groupId: 'group', participantCount: 0 }]);
  await current;
  pending[0].resolve([{ groupId: 'group', participantCount: 1 }]);
  await old;
  expect(state.roomOccupancies.value.group).toBe(0);
  expect(state.roomOccupancyRequest).toBeNull();
});

it('占用查询失败保留最后人数并结束等待，下一轮能够重试', async () => {
  const { state, pending, refresh } = setupOccupancies();
  state.roomOccupancies.value = { group: 1 };
  const failed = refresh();
  pending[0].reject(new Error('network unavailable'));
  await failed;
  expect(state.roomOccupancies.value.group).toBe(1);
  expect(state.roomOccupancyRequest).toBeNull();
  const retrying = refresh();
  pending[1].resolve([{ groupId: 'group', participantCount: 0 }]);
  await retrying;
  expect(state.roomOccupancies.value.group).toBe(0);
});

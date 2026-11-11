import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import type { RtcRoomSummary } from './rtc/roomSummaryApi';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const functionNames = ['refreshOnActivation', 'handlePresenceNetworkRestored', 'leaveVoice'];
const variableNames = ['fetchedRoomSummary', 'roomSummary', 'groupHasVoiceActivity'];
const callbacks = sourceFile.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return Boolean(statement.name && functionNames.includes(statement.name.text));
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
    .some(declaration => variableNames.includes(declaration.name.getText(sourceFile)));
  return statement.getText(sourceFile).startsWith('watch(fetchedRoomSummary,');
}).map(statement => statement.getText(sourceFile)).join('\n');
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
  const leaving = deferred<void>();
  const rawSummary = ref<RtcRoomSummary | null>({ participantCount: 2, participants: [
    { participantIdentity: 'user-self', displayName: '自己' }, { participantIdentity: 'user-friend', displayName: '朋友' },
  ] });
  const state = {
    props: { user: { id: 'self' } }, ownPresence: { stopped: false },
    selectedGroupId: ref<string | null>('group'), joinedGroupId: ref<string | null>('group'),
    joiningGroupId: ref<string | null>(null), joinedGroupDetail: ref<unknown>(null),
    locallyLeftVoiceGroupId: ref<string | null>(null), roomSummaryRefreshVersion: ref(0),
    summaryError: ref<string | null>(null), roomOccupancies: ref<Record<string, number>>({ group: 2 }),
    roomOccupancyRequest: new AbortController(), joinAttempt: 0, lastActivationRefreshAt: 0, listRequest: null,
    departingGroupId: ref<string | null>(null), callbarLeaving: ref(false),
    pendingSwitchGroupId: ref<string | null>(null), viewerNotice: ref(''),
    rtc: { status: 'connected', participants: [{ identity: 'user-self' }, { identity: 'user-friend' }], leave: vi.fn(() => leaving.promise) },
    selectCaptureSource: vi.fn(), viewingWindows: { value: { closeAll: vi.fn() } },
    callSounds: { left: vi.fn(async () => {}) }, sendHeartbeat: vi.fn(async () => {}), updateOwnPresenceStatus: vi.fn(async () => {}),
    refreshRoomOccupancies: vi.fn(async () => {}), refreshGroups: vi.fn(async () => {}), refreshGroupPresence: vi.fn(),
    computed, watch, document: { visibilityState: 'visible' }, useRoomSummary: () => rawSummary,
  };
  const showingJoinedGroup = computed(() => state.joinedGroupId.value !== null && state.joinedGroupId.value === state.selectedGroupId.value);
  const sandbox = { ...state, showingJoinedGroup };
  const app = scope.run(() => runInNewContext(`${compiled}\n({ ${functionNames.join(', ')}, roomSummary, groupHasVoiceActivity })`, sandbox)) as {
    refreshOnActivation: () => void; handlePresenceNetworkRestored: () => void;
    leaveVoice: () => void; roomSummary: { value: RtcRoomSummary | null }; groupHasVoiceActivity: (groupId: string) => boolean;
  };
  return { scope, state: sandbox, app, rawSummary, leaving, stop: () => { state.ownPresence.stopped = true; scope.stop(); } };
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
    expect(first.state.viewerNotice.value).toContain('退出语音时发生问题');
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

it('网络或窗口恢复立即上报心跳、复核闲置及刷新成员，不等待周期', async () => {
  const { state, app, stop } = setup();
  try {
    app.handlePresenceNetworkRestored();
    await settle();
    expect(state.sendHeartbeat).toHaveBeenCalledOnce();
    expect(state.updateOwnPresenceStatus).toHaveBeenCalledOnce();
    expect(state.refreshGroupPresence).toHaveBeenCalledOnce();
    expect(state.refreshRoomOccupancies).toHaveBeenCalledOnce();
    expect(state.roomSummaryRefreshVersion.value).toBe(1);
    app.refreshOnActivation();
    expect(state.refreshGroups).toHaveBeenCalledOnce();
    expect(state.updateOwnPresenceStatus).toHaveBeenCalledTimes(2);
    expect(state.roomSummaryRefreshVersion.value).toBe(2);
    await settle();
  } finally { stop(); }
});

it('本人和群成员的音乐/游戏展示一致，离线和关闭动态均不占用第二行', () => {
  const names = ['memberActivity', 'memberOnlineStatus', 'personalActivityStatus'];
  const statements = sourceFile.statements.filter((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(sourceFile))));
  const state = { props: { user: { id: 'self' } }, publicPresenceStatus: ref('ONLINE'),
    sharedActivity: ref<DetectedActivity | null>({ type: 'MUSIC', name: '歌曲', startedAt: '2026-10-15T00:00:00Z' }),
    groupPresences: ref({ friend: { status: 'ONLINE', activityType: 'MUSIC', activityName: '歌曲', activityStartedAt: '2026-10-15T00:00:00Z' } }),
    computed };
  const body = statements.map((statement) => statement.getText(sourceFile)).join('\n');
  const result = runInNewContext(`${ts.transpile(body)}\n({ memberActivity, personalActivityStatus })`, state) as {
    memberActivity: (member: { userId: string }) => { type: string; text: string; startedAt?: string } | null;
    personalActivityStatus: { value: { type: string; text: string } | null };
  };
  const display = result.memberActivity;
  expect(result.personalActivityStatus.value?.text).toBe('正在听 歌曲');
  expect(display({ userId: 'self' })?.text).toBe('正在听 歌曲');
  expect(display({ userId: 'friend' })?.text).toBe('正在听 歌曲');
  state.groupPresences.value.friend.status = 'OFFLINE';
  expect(display({ userId: 'friend' })).toBeNull();
  state.sharedActivity.value = null;
  expect(display({ userId: 'self' })).toBeNull();
  expect(result.personalActivityStatus.value).toBeNull();
  state.sharedActivity.value = { type: 'GAME', name: '游戏', startedAt: '2026-10-15T00:00:00Z' };
  expect(display({ userId: 'self' })?.text).toBe('正在玩 游戏');
  expect(display({ userId: 'self' })?.startedAt).toBe('2026-10-15T00:00:00Z');
  state.groupPresences.value.friend = { status: 'ONLINE', activityType: 'GAME', activityName: '游戏', activityStartedAt: '2026-10-15T00:00:00Z' };
  expect(display({ userId: 'friend' })?.text).toBe('正在玩 游戏');
  expect(display({ userId: 'friend' })?.startedAt).toBe('2026-10-15T00:00:00Z');
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

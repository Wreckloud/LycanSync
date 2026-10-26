import { EventEmitter } from 'node:events';
import { effectScope, ref, shallowRef } from 'vue';
import { RoomEvent, type Participant, type Room } from 'livekit-client';
import { expect, it } from 'vitest';
import { useScreenShareLayout } from './useScreenShareLayout';

function fixture() {
  const room = shallowRef(new EventEmitter() as unknown as Room);
  const participants = shallowRef(['A', 'B', 'C'].map(identity => ({ identity, isScreenShareEnabled: true,
    getTrackPublication: () => ({ trackSid: identity + '-video' }) }) as unknown as Participant));
  const revision = ref(0), status = ref('connected');
  const sessions: Record<string, string> = { A: 'a', B: 'b', C: 'c' };
  const privateShares = new Set<string>();
  const scope = effectScope();
  const view = scope.run(() => useScreenShareLayout({ room: () => room.value,
    participants: () => participants.value, revision: () => revision.value, status: () => status.value,
    session: identity => sessions[identity], privateControl: identity => privateShares.has(identity) ? '画面未公开' : '',
  }))!;
  return { room, participants, revision, status, sessions, privateShares, scope, view };
}

it('预览点击切换聚焦，再点同一共享收起；头像和私密画面不进入观看', () => {
  const f = fixture();
  expect(f.view.mode.value).toBe('collapsed');
  f.view.select('A');
  expect(f.view.focusedShare.value?.participant.identity).toBe('A');
  f.view.select('B');
  expect(f.view.focusedShare.value?.participant.identity).toBe('B');
  f.view.select('B');
  expect(f.view.mode.value).toBe('collapsed');
  f.privateShares.add('A');
  f.participants.value = f.participants.value.map(participant => participant.identity === 'B'
    ? { ...participant, isScreenShareEnabled: false } as Participant : participant);
  f.revision.value++;
  expect(f.view.select('A')).toBe(false);
  expect(f.view.select('B')).toBe(false);
  f.scope.stop();
});

it('网格自动包含全部有效共享，新增加入、停止移除，不改变成员折叠记忆', () => {
  const f = fixture();
  f.view.select('B');
  f.view.membersVisible.value = false;
  f.view.grid();
  expect(f.view.displayed.value.map(share => share.participant.identity)).toEqual(['A', 'B', 'C']);
  f.participants.value = [...f.participants.value, { identity: 'D', isScreenShareEnabled: true,
    getTrackPublication: () => ({ trackSid: 'd' }) } as unknown as Participant];
  f.revision.value++;
  expect(f.view.displayed.value).toHaveLength(4);
  f.participants.value = f.participants.value.filter(participant => participant.identity !== 'A');
  f.privateShares.add('C'); f.revision.value++;
  expect(f.view.displayed.value.map(share => share.participant.identity)).toEqual(['B', 'D']);
  f.view.select('D');
  expect(f.view.membersVisible.value).toBe(false);
  f.view.membersVisible.value = true;
  f.view.grid(); f.view.select('B');
  expect(f.view.membersVisible.value).toBe(true);
  f.scope.stop();
});

it('聚焦停止、换源或撤回权限后收起，新共享不自动接管；单路网格仍可切换', () => {
  const f = fixture();
  f.view.select('A');
  f.sessions.A = 'new-a'; f.revision.value++;
  expect(f.view.mode.value).toBe('collapsed');
  f.view.select('A'); f.privateShares.add('A'); f.revision.value++;
  expect(f.view.mode.value).toBe('collapsed');
  f.participants.value = f.participants.value.slice(1, 2); f.revision.value++;
  f.view.select('B'); f.view.grid();
  expect(f.view.mode.value).toBe('grid');
  expect(f.view.displayed.value).toHaveLength(1);
  f.participants.value = []; f.revision.value++;
  expect(f.view.mode.value).toBe('collapsed');
  f.scope.stop();
});

it('网格共享停止后仍展示其他有效来源，观察起点不因界面切换重置', () => {
  const f = fixture();
  f.view.grid();
  const observedAt = f.view.shares.value[1]!.observedAt;
  f.participants.value = f.participants.value.slice(1); f.revision.value++;
  expect(f.view.shares.value[0]!.observedAt).toBe(observedAt);
  expect(f.view.mode.value).toBe('grid');
  expect(f.view.displayed.value).toHaveLength(2);
  f.scope.stop();
});

it('重连空快照不收起聚焦；重连完成核验会话，切房清空且旧事件无效', () => {
  const f = fixture(); f.view.select('A');
  const participants = f.participants.value;
  f.status.value = 'reconnecting'; f.participants.value = []; f.revision.value++;
  expect(f.view.mode.value).toBe('focus');
  f.participants.value = participants; f.status.value = 'connected';
  f.room.value.emit(RoomEvent.Reconnected);
  expect(f.view.focusedShare.value?.participant.identity).toBe('A');
  f.sessions.A = 'new-a'; f.room.value.emit(RoomEvent.Reconnected);
  expect(f.view.mode.value).toBe('collapsed');
  const oldRoom = f.room.value;
  f.room.value = new EventEmitter() as unknown as Room;
  oldRoom.emit(RoomEvent.Reconnected);
  expect(f.view.mode.value).toBe('collapsed');
  f.scope.stop();
});

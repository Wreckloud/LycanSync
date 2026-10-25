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

it('默认只展示卡片，首次网格收录当前共享，新共享不挤入；手动选择才加入', () => {
  const f = fixture();
  expect(f.view.mode.value).toBe('collapsed');
  f.participants.value = f.participants.value.slice(0, 2);
  f.view.grid();
  expect(f.view.shares.value.map(share => share.participant.identity)).toEqual(['A', 'B']);
  f.participants.value = [...f.participants.value, { identity: 'D', isScreenShareEnabled: true,
    getTrackPublication: () => ({ trackSid: 'd' }) } as unknown as Participant];
  f.revision.value++;
  f.view.grid();
  expect(f.view.shares.value).toHaveLength(2);
  expect(f.view.select('D')).toBe(true);
  expect(f.view.mode.value).toBe('focus');
  expect(f.view.focusedShare.value?.participant.identity).toBe('D');
  f.view.grid();
  expect(f.view.displayed.value).toHaveLength(3);
  f.scope.stop();
});

it('切换聚焦和单路展示不丢网格顺序；移除聚焦不自动接管别人的画面', () => {
  const f = fixture(); f.view.grid(); f.view.select('B');
  const key = f.view.focused.value!;
  f.view.single.value = key;
  expect(f.view.displayed.value.map(share => share.participant.identity)).toEqual(['B']);
  f.view.single.value = null; f.view.grid();
  expect(f.view.displayed.value.map(share => share.participant.identity)).toEqual(['A', 'B', 'C']);
  f.view.remove(key);
  expect(f.view.focused.value).toBeNull();
  expect(f.view.mode.value).toBe('grid');
  f.scope.stop();
});

it('先聚焦再首次打开网格仍收录当前共享，移除后不自动加回', () => {
  const f = fixture();
  f.view.select('B');
  const key = f.view.focused.value!;
  f.view.grid();
  expect(f.view.shares.value.map(share => share.participant.identity)).toEqual(['B', 'A', 'C']);
  f.view.remove(key);
  f.view.grid();
  expect(f.view.shares.value.map(share => share.participant.identity)).toEqual(['A', 'C']);
  f.scope.stop();
});

it('停止、换源与私密撤回立即结束旧位置，新共享只有明确重新选择才进入', () => {
  const f = fixture(); f.view.grid();
  const old = f.view.shares.value[0]!;
  f.sessions.A = 'new-a'; f.privateShares.add('B'); f.revision.value++;
  expect(old.ended).toBe(true);
  expect(f.view.shares.value[1]!.ended).toBe(true);
  expect(f.view.select('B')).toBe(false);
  f.view.select('A');
  expect(f.view.focusedShare.value?.key).not.toBe(old.key);
  expect(f.view.focusedShare.value?.ended).toBe(false);
  expect(f.view.shares.value.filter(share => share.participant.identity === 'A')).toHaveLength(1);
  f.scope.stop();
});

it('重连的空快照不结束原共享；重连完成检查会话，切房清空且旧房结果无效', () => {
  const f = fixture(); f.view.select('A');
  const participants = f.participants.value;
  f.status.value = 'reconnecting'; f.participants.value = []; f.revision.value++;
  expect(f.view.focusedShare.value?.ended).toBe(false);
  f.participants.value = participants; f.status.value = 'connected';
  f.room.value.emit(RoomEvent.Reconnected);
  expect(f.view.focusedShare.value?.ended).toBe(false);
  const oldRoom = f.room.value;
  f.room.value = new EventEmitter() as unknown as Room;
  expect(f.view.mode.value).toBe('collapsed');
  oldRoom.emit(RoomEvent.Reconnected);
  expect(f.view.shares.value).toEqual([]);
  f.scope.stop();
});

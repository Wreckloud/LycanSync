import { EventEmitter } from 'node:events';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { RoomEvent, type Room } from 'livekit-client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_OVERLAY_SETTINGS, useVoiceOverlay } from './useVoiceOverlay';
import type { VoiceOverlayBridge, VoiceOverlaySettings, VoiceOverlaySnapshot } from './types';

function roomFixture() {
  const events = new EventEmitter();
  const local = { identity: 'local', name: '自己', attributes: {}, isMicrophoneEnabled: true, isSpeaking: true };
  const remote = { identity: 'remote', name: '朋友', attributes: {} as Record<string, string>, isMicrophoneEnabled: true, isSpeaking: false };
  return Object.assign(events, { localParticipant: local, remoteParticipants: new Map([['remote', remote]]) }) as unknown as Room;
}

async function settle() { for (let turn = 0; turn < 8; turn++) await nextTick(); }

function setup(stored: string | null = JSON.stringify({ ...DEFAULT_OVERLAY_SETTINGS, enabled: true })) {
  const scope = effectScope();
  const room = shallowRef<Room | null>(roomFixture());
  const status = ref('connected');
  const revision = ref(0);
  const microphone = ref(true);
  const listening = ref(true);
  const errors = { callback: (_message: string) => {} };
  const placement = { callback: (_settings: VoiceOverlaySettings) => {} };
  const snapshots: VoiceOverlaySnapshot[] = [];
  const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const bridge = {
    begin: vi.fn(async () => 'owner-1'),
    configure: vi.fn(async (_owner: string, settings: VoiceOverlaySettings) => settings),
    update: vi.fn(async (_owner: string, snapshot: VoiceOverlaySnapshot) => { snapshots.push(snapshot); }),
    edit: vi.fn(async (_owner: string, enabled: boolean) => enabled), end: vi.fn(async () => {}), displays: vi.fn(async () => [{ id: 1, label: '屏幕 1' }]),
    onError: vi.fn((callback: (message: string) => void) => { errors.callback = callback; return vi.fn(); }),
    onPlacement: vi.fn((callback: (settings: VoiceOverlaySettings) => void) => { placement.callback = callback; return vi.fn(); }),
    onEditingChange: vi.fn((_callback: (editing: boolean) => void) => vi.fn()),
  } satisfies VoiceOverlayBridge;
  const model = scope.run(() => useVoiceOverlay({ userId: 'one', room: () => room.value, revision: () => revision.value,
    status: () => status.value, microphone: () => microphone.value, listening: () => listening.value,
    avatar: () => 'data:image/png;base64,AA==', storage, bridge }))!;
  return { scope, room, status, revision, microphone, listening, bridge, storage, snapshots, model, errors, placement };
}

it('默认关闭不发送成员快照；开启后才投影当前房间，按账号记忆设置', async () => {
  const f = setup(null);
  try {
    await settle();
    expect(f.snapshots).toEqual([]);
    await f.model.configure({ enabled: true });
    expect(f.snapshots.at(-1)?.members.map((member) => member.name)).toEqual(['自己', '朋友']);
    expect(f.snapshots.at(-1)?.portraits).toHaveLength(2);
    expect(f.storage.setItem).toHaveBeenCalledWith('lycansync.voice-overlay.v1.one', expect.any(String));
  } finally { f.scope.stop(); }
});

it('直接响应说话事件，重复事件不发送，后续说话快照不重复携带头像', async () => {
  const f = setup();
  try {
    await settle();
    const room = f.room.value!;
    room.remoteParticipants.get('remote')!.isSpeaking = true;
    room.emit(RoomEvent.ActiveSpeakersChanged, []);
    expect(f.snapshots.at(-1)?.members[1].speaking).toBe(true);
    expect(f.snapshots.at(-1)?.portraits).toBeUndefined();
    const count = f.snapshots.length;
    room.emit(RoomEvent.ActiveSpeakersChanged, []);
    f.revision.value++;
    expect(f.snapshots).toHaveLength(count);
  } finally { f.scope.stop(); }
});

it('停止收听或禁麦立即撤销自己的说话标记；重连时也不保留远端高亮', async () => {
  const f = setup();
  try {
    await settle();
    f.listening.value = false;
    expect(f.snapshots.at(-1)?.members[0]).toMatchObject({ microphone: false, listening: false, speaking: false });
    f.listening.value = true;
    f.microphone.value = false;
    expect(f.snapshots.at(-1)?.members[0].speaking).toBe(false);
    f.room.value!.remoteParticipants.get('remote')!.isSpeaking = true;
    f.status.value = 'reconnecting';
    expect(f.snapshots.at(-1)?.members.every((member) => !member.speaking)).toBe(true);
  } finally { f.scope.stop(); }
});

it('离房立即发送隐藏并解绑旧事件；新房间重新登记头像，旧房间事件无权更新', async () => {
  const f = setup();
  await settle();
  const previous = f.room.value!;
  f.room.value = null;
  expect(f.snapshots.at(-1)).toMatchObject({ roomId: null, status: 'hidden', members: [] });
  expect(previous.listenerCount(RoomEvent.ActiveSpeakersChanged)).toBe(0);
  f.room.value = roomFixture();
  const current = f.snapshots.at(-1);
  expect(current?.portraits).toHaveLength(2);
  previous.emit(RoomEvent.ActiveSpeakersChanged, []);
  expect(f.snapshots.at(-1)).toBe(current);
  f.scope.stop();
  expect(f.bridge.end).toHaveBeenCalledWith('owner-1');
  expect(f.bridge.onError.mock.results[0]!.value).toHaveBeenCalledOnce();
});

it('应用设置失败不保存假成功；本机存储失败明确反馈已生效但未保存', async () => {
  const f = setup();
  try {
    await settle();
    f.bridge.configure.mockRejectedValueOnce(new Error('unavailable'));
    await f.model.configure({ scale: 125 });
    expect(f.model.settings.value.scale).toBe(100);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.storage.setItem.mockImplementation(() => { throw new Error('disk failure'); });
    await f.model.configure({ scale: 125 });
    expect(f.model.settings.value.scale).toBe(125);
    expect(f.model.error.value).toContain('无法保存');
  } finally { f.scope.stop(); }
});

it('覆盖故障只显示独立错误；位置事件保存到本机，结束编辑恢复正常模式', async () => {
  const f = setup();
  try {
    await settle();
    await f.model.edit(true);
    expect(f.model.editing.value).toBe(true);
    f.placement.callback({ ...f.model.settings.value, x: 0.2, displayId: 1 });
    expect(f.model.settings.value.x).toBe(0.2);
    f.errors.callback('覆盖不可用');
    expect(f.model.editing.value).toBe(false);
    expect(f.model.error.value).toBe('覆盖不可用');
    expect(f.room.value).not.toBeNull();
    await f.model.edit(false);
    expect(f.bridge.edit).toHaveBeenLastCalledWith('owner-1', false);
  } finally { f.scope.stop(); }
});

it('损坏偏好保持关闭，不覆盖存储；初始化迟到时销毁自己的owner', async () => {
  const f = setup('{invalid');
  await settle();
  expect(f.model.settings.value.enabled).toBe(false);
  expect(f.model.error.value).toContain('无法读取');
  expect(f.storage.setItem).not.toHaveBeenCalled();
  f.scope.stop();
  const g = setup();
  g.scope.stop();
  await settle();
  expect(g.bridge.end).toHaveBeenCalledWith('owner-1');
  expect(g.bridge.update).not.toHaveBeenCalled();
});

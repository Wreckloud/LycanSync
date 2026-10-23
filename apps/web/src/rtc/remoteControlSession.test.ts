import type { Room } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlSession, type PreparedControlShare, type RemoteControlShare } from './remoteControlSession';
import { decodeRemoteControlMessage, encodeRemoteControlMessage, type RemoteControlMessage } from './remoteControl';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture() {
  const peers = new Map<string, ReturnType<typeof peer>>();
  const packets: Array<{ from: string; to: string; message: RemoteControlMessage }> = [];
  function peer(identity: string) {
    let current = true;
    let share: RemoteControlShare | null = null;
    const room = { remoteParticipants: new Map(), localParticipant: {
      publishData: vi.fn(async (payload: Uint8Array, options: { destinationIdentities: string[] }) => {
        const message = decodeRemoteControlMessage(payload)!;
        for (const to of options.destinationIdentities) {
          packets.push({ from: identity, to, message });
          queueMicrotask(() => { const destination = peers.get(to); destination?.session.handleData(destination.room, identity, payload); });
        }
      }),
    } } as unknown as Room;
    const desktop = {
      authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      revokeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      sendNativeRemoteInput: vi.fn().mockResolvedValue({ changed: true }),
    };
    const controllerRestore = vi.fn(async () => {}), targetRestore = vi.fn(async () => { share = null; });
    const suspend = vi.fn(async (_room: Room, _current: () => boolean): Promise<() => Promise<void>> => controllerRestore);
    const prepare = vi.fn(async (_room: Room, _identity: string, sourceId: string, _public: boolean,
      _current: () => boolean, _signal: AbortSignal): Promise<PreparedControlShare> => {
      share = { shareId: identity + '-share', captureSessionId: identity + '-capture',
        sourceId, kind: 'monitor', liveKitTrackId: identity + '-video' };
      return { share, restore: targetRestore };
    });
    const notice = vi.fn();
    const session = new RemoteControlSession({ currentRoom: () => current ? room : null,
      isCurrentRoom: candidate => current && candidate === room, currentShare: () => share,
      desktop: () => desktop as unknown as Window['lycanDesktop'], suspendController: suspend,
      prepareTarget: prepare, setNotice: notice });
    return { room, session, desktop, suspend, prepare, notice, controllerRestore, targetRestore,
      leave() { current = false; session.clearRoomState(); },
      receive(from: string, message: RemoteControlMessage) { session.handleData(room, from, encodeRemoteControlMessage(message)); } };
  }
  for (const identity of ['controller', 'target', 'other']) peers.set(identity, peer(identity));
  for (const [identity, entry] of peers) {
    for (const [other] of peers) if (identity !== other) entry.room.remoteParticipants.set(other, { identity: other } as never);
    entry.session.queryParticipants(entry.room);
  }
  return { a: peers.get('controller')!, b: peers.get('target')!, c: peers.get('other')!, packets,
    stop() { peers.forEach(entry => entry.leave()); } };
}

afterEach(() => vi.useRealTimers());

describe('远控协商与资源归属', () => {
  it('接受后才暂停控制方共享，准备完成才授权；第三人不能抢占或注入输入', async () => {
    const f = fixture();
    const suspended = deferred<() => Promise<void>>();
    f.a.suspend.mockReturnValueOnce(suspended.promise);
    try {
      await vi.waitFor(() => expect(f.a.session.available.value.target).toBe(true));
      expect(await f.a.session.requestControl('target')).toBe(true);
      await vi.waitFor(() => expect(f.b.session.request.value?.identity).toBe('controller'));
      expect(f.a.suspend).not.toHaveBeenCalled();
      const approving = f.b.session.allow('monitor:primary', false);
      await vi.waitFor(() => expect(f.a.suspend).toHaveBeenCalledOnce());
      expect(f.b.prepare).not.toHaveBeenCalled();
      suspended.resolve(f.a.controllerRestore);
      expect(await approving).toBe(true);
      await vi.waitFor(() => expect(f.a.session.active.value?.identity).toBe('target'));
      expect(f.b.prepare).toHaveBeenCalledWith(f.b.room, 'controller', 'monitor:primary', false,
        expect.any(Function), expect.any(AbortSignal));
      await vi.waitFor(() => expect(f.c.session.presentations.value.target).toEqual({ identity: 'controller', public: false }));
      const active = f.a.session.active.value!;
      f.b.receive('other', { type: 'input', ...active, sequence: 1, input: { kind: 'keyDown', key: 'letterA' } });
      expect(f.b.desktop.sendNativeRemoteInput).not.toHaveBeenCalled();
      await f.a.session.sendInput({ kind: 'keyDown', key: 'letterA' });
      await vi.waitFor(() => expect(f.b.desktop.sendNativeRemoteInput).toHaveBeenCalledOnce());
      await f.c.session.requestControl('target');
      await vi.waitFor(() => expect(f.c.session.pending.value).toBeNull());
      expect(f.b.session.owner.value?.identity).toBe('controller');
      f.a.session.trackUnpublished(f.a.room, 'target', 'old-public-video');
      expect(f.a.session.active.value?.controlSessionId).toBe(active.controlSessionId);
      await f.a.session.exitControl();
      await vi.waitFor(() => expect(f.b.targetRestore).toHaveBeenCalledOnce());
      expect(f.a.controllerRestore).toHaveBeenCalledOnce();
      expect(f.a.session.active.value).toBeNull();
      expect(f.b.session.owner.value).toBeNull();
    } finally { suspended.resolve(f.a.controllerRestore); f.stop(); }
  });

  it('恢复失败明确提示，不能把失效的旧共享记为已恢复', async () => {
    const f = fixture();
    f.a.controllerRestore.mockRejectedValueOnce(new Error('sourceExpired'));
    try {
      await vi.waitFor(() => expect(f.a.session.available.value.target).toBe(true));
      await f.a.session.requestControl('target');
      await vi.waitFor(() => expect(f.b.session.request.value).not.toBeNull());
      expect(await f.b.session.allow('monitor:primary', true)).toBe(true);
      await vi.waitFor(() => expect(f.a.session.active.value).not.toBeNull());
      await f.a.session.exitControl();
      expect(f.a.notice).toHaveBeenCalledWith(expect.stringContaining('原共享恢复失败'));
      expect(f.a.session.restoring.value).toBe(false);
      expect(f.a.session.active.value).toBeNull();
    } finally { f.stop(); }
  });

  it('准备中取消，迟到的暂停结果只恢复本机，迟到授权不能激活输入', async () => {
    const f = fixture();
    const suspended = deferred<() => Promise<void>>();
    f.a.suspend.mockReturnValueOnce(suspended.promise);
    try {
      await vi.waitFor(() => expect(f.a.session.available.value.target).toBe(true));
      await f.a.session.requestControl('target');
      const requestId = f.a.session.pending.value!.requestId;
      await vi.waitFor(() => expect(f.b.session.request.value).not.toBeNull());
      const approving = f.b.session.allow('monitor:primary', true);
      await vi.waitFor(() => expect(f.a.suspend).toHaveBeenCalledOnce());
      await f.a.session.cancelPending();
      suspended.resolve(f.a.controllerRestore);
      expect(await approving).toBe(false);
      await vi.waitFor(() => expect(f.a.controllerRestore).toHaveBeenCalledOnce());
      expect(f.b.prepare).not.toHaveBeenCalled();
      f.a.receive('target', { type: 'allow', trackSid: 'target-video', requestId, shareSessionId: 'late-share', controlSessionId: 'late-control' });
      expect(f.a.session.active.value).toBeNull();
      expect(await f.a.session.sendInput({ kind: 'keyDown', key: 'letterA' })).toBe(false);
      expect(f.packets.some(packet => packet.message.type === 'revoke' && packet.message.controlSessionId === 'late-control')).toBe(true);
    } finally { suspended.resolve(f.a.controllerRestore); f.stop(); }
  });

  it('未就绪时超时不采集；重复接受不启动两次，离房后忽略旧消息', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const suspended = deferred<() => Promise<void>>();
    f.a.suspend.mockReturnValueOnce(suspended.promise);
    try {
      await vi.advanceTimersByTimeAsync(1);
      await f.a.session.requestControl('target');
      await vi.advanceTimersByTimeAsync(1);
      const approving = f.b.session.allow('monitor:primary', true);
      expect(await f.b.session.allow('monitor:primary', true)).toBe(false);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await approving).toBe(false);
      expect(f.b.prepare).not.toHaveBeenCalled();
      suspended.resolve(f.a.controllerRestore);
      await vi.advanceTimersByTimeAsync(1);
      f.b.leave();
      f.b.receive('controller', { type: 'request', requestId: 'old-room' });
      expect(f.b.session.request.value).toBeNull();
      expect(f.b.desktop.authorizeNativeRemoteControl).not.toHaveBeenCalled();
    } finally { suspended.resolve(f.a.controllerRestore); f.stop(); }
  });

  it('控制方已暂停并通知就绪后，等待授权超时仍能取消并恢复原共享', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const preparation = deferred<void>();
    const prepare = f.b.prepare.getMockImplementation()!;
    f.b.prepare.mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      await preparation.promise;
      return prepared;
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      await f.a.session.requestControl('target');
      await vi.advanceTimersByTimeAsync(1);
      const approving = f.b.session.allow('monitor:primary', false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.b.prepare).toHaveBeenCalledOnce();
      expect(f.a.session.pending.value?.phase).toBe('preparing');
      await vi.advanceTimersByTimeAsync(20_001);
      expect(f.a.session.pending.value).toBeNull();
      expect(f.a.controllerRestore).toHaveBeenCalledOnce();
      preparation.resolve();
      expect(await approving).toBe(false);
      expect(f.b.desktop.authorizeNativeRemoteControl).not.toHaveBeenCalled();
      expect(f.b.targetRestore).toHaveBeenCalledOnce();
    } finally { preparation.resolve(); f.stop(); }
  });
});

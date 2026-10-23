import { ref, shallowRef } from 'vue';
import type { Room } from 'livekit-client';
import {
  decodeRemoteControlMessage, encodeRemoteControlMessage, REMOTE_CONTROL_TOPIC, REMOTE_CONTROL_MAX_INPUTS_PER_SECOND,
  LatestValueSender, RemoteControlAuthorization, type RemoteControlInput,
} from './remoteControl';

export interface RemoteControlShare {
  readonly shareId: string;
  readonly captureSessionId: string;
  readonly sourceId: string;
  readonly kind: 'monitor' | 'window';
  readonly liveKitTrackId: string | null;
}

export interface PreparedControlShare {
  share: RemoteControlShare;
  restore(): Promise<void>;
}

interface RemoteControlSessionOptions {
  currentRoom(): Room | null;
  isCurrentRoom(room: Room): boolean;
  currentShare(): RemoteControlShare | null;
  desktop(): Window['lycanDesktop'];
  suspendController(room: Room, current: () => boolean): Promise<() => Promise<void>>;
  prepareTarget(room: Room, identity: string, sourceId: string, publicVideo: boolean,
    current: () => boolean, signal: AbortSignal): Promise<PreparedControlShare>;
  setNotice(message: string): void;
}

interface ControllerInputSession {
  room: Room;
  identity: string;
  shareId: string;
  controlSessionId: string;
  sequence: number;
  exiting: boolean;
  pointerSender: LatestValueSender<{ sequence: number; input: Extract<RemoteControlInput, { kind: 'move' }> }> | null;
}

interface NativeRemoteControlCleanup {
  room: Room;
  captureSessionId: string;
  controlSessionId: string;
  authorization: RemoteControlAuthorization;
}

interface GrantAttempt {
  controller: AbortController;
  ready?: (accepted: boolean) => void;
}

/** 请求独立于共享；媒体准备归房间模块，输入授权和清理归本会话。 */
export class RemoteControlSession {
  readonly request = shallowRef<{ identity: string; requestId: string } | null>(null);
  readonly granting = ref(false);
  readonly restoring = ref(false);
  readonly cleanupPending = ref(false);
  readonly owner = shallowRef<{ identity: string; controlSessionId: string; public: boolean } | null>(null);
  readonly shares = shallowRef<Record<string, { shareSessionId: string; kind: 'monitor' | 'window' }>>({});
  readonly available = shallowRef<Record<string, boolean>>({});
  readonly presentations = shallowRef<Record<string, { identity: string; public: boolean }>>({});
  readonly active = shallowRef<{ identity: string; shareSessionId: string; controlSessionId: string; trackSid: string } | null>(null);
  readonly pending = shallowRef<{ identity: string; requestId: string; phase: 'waiting' | 'preparing' } | null>(null);

  private authorization = new RemoteControlAuthorization();
  private controllerInput: ControllerInputSession | null = null;
  private nativeCleanup: NativeRemoteControlCleanup | null = null;
  private grantAttempt: GrantAttempt | null = null;
  private controllerPreparation: object | null = null;
  private authorizedShare: RemoteControlShare | null = null;
  private targetRestore: (() => Promise<void>) | null = null;
  private controllerRestore: (() => Promise<void>) | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStoppedCaptureId: string | null = null;
  private remoteInputWindowStarted = Date.now();
  private remoteInputCount = 0;

  constructor(private readonly options: RemoteControlSessionOptions) {}

  private send(room: Room, identity: string, message: Parameters<typeof encodeRemoteControlMessage>[0], reliable = true) {
    const encoded = encodeRemoteControlMessage(message);
    const payload = new Uint8Array(encoded.byteLength);
    payload.set(encoded);
    return room.localParticipant.publishData(payload, {
      reliable, destinationIdentities: [identity], topic: REMOTE_CONTROL_TOPIC,
    });
  }

  private stateMessage(): Extract<Parameters<typeof encodeRemoteControlMessage>[0], { type: 'state' }> {
    const share = this.options.currentShare();
    const owner = this.owner.value;
    return { type: 'state', available: Boolean(this.options.desktop()),
      share: share ? { shareSessionId: share.shareId, kind: share.kind } : null,
      control: owner ? { identity: owner.identity, public: owner.public } : null };
  }

  private broadcast(room: Room) {
    if (!this.options.isCurrentRoom(room)) return;
    for (const identity of room.remoteParticipants.keys()) {
      void this.send(room, identity, this.stateMessage()).catch(() => {});
    }
  }

  beginShare(room: Room) { this.broadcast(room); }

  announceParticipant(room: Room, identity: string) {
    if (!this.options.isCurrentRoom(room)) return;
    void this.send(room, identity, this.stateMessage()).catch(() => {});
    void this.send(room, identity, { type: 'queryState' }).catch(() => {});
  }

  queryParticipants(room: Room) {
    room.remoteParticipants.forEach((_participant, identity) => this.announceParticipant(room, identity));
  }

  handleData(room: Room, identity: string, payload: Uint8Array) {
    if (!this.options.isCurrentRoom(room) || !room.remoteParticipants.has(identity)) return;
    const message = decodeRemoteControlMessage(payload);
    if (!message) return;
    if (message.type === 'queryState') {
      void this.send(room, identity, this.stateMessage()).catch(() => {});
    } else if (message.type === 'state') {
      this.available.value = { ...this.available.value, [identity]: message.available };
      const shares = { ...this.shares.value };
      if (message.share) shares[identity] = message.share;
      else delete shares[identity];
      this.shares.value = shares;
      const presentations = { ...this.presentations.value };
      if (message.control) presentations[identity] = message.control;
      else delete presentations[identity];
      this.presentations.value = presentations;
    } else if (message.type === 'request') {
      if (this.request.value?.identity === identity && this.request.value.requestId === message.requestId) return;
      if (!this.options.desktop() || this.busy()) {
        void this.send(room, identity, { type: 'reject', requestId: message.requestId }).catch(() => {});
        return;
      }
      const request = { identity, requestId: message.requestId };
      this.request.value = request;
      clearTimeout(this.requestTimer);
      this.requestTimer = setTimeout(() => {
        if (this.request.value === request) void this.reject();
      }, 30_000);
    } else if (message.type === 'accept') {
      const pending = this.pending.value;
      if (pending?.identity === identity && pending.requestId === message.requestId && pending.phase === 'waiting') {
        void this.prepareController(room, pending);
      }
    } else if (message.type === 'controllerReady') {
      if (this.request.value?.identity === identity && this.request.value.requestId === message.requestId) {
        this.grantAttempt?.ready?.(true);
      }
    } else if (message.type === 'allow') {
      const pending = this.pending.value;
      if (this.active.value?.controlSessionId === message.controlSessionId) return;
      if (!pending || pending.identity !== identity || pending.requestId !== message.requestId
          || pending.phase !== 'preparing' || !this.controllerRestore) {
        void this.send(room, identity, { type: 'revoke', shareSessionId: message.shareSessionId,
          controlSessionId: message.controlSessionId }).catch(() => {});
        return;
      }
      clearTimeout(this.pendingTimer);
      this.pending.value = null;
      this.active.value = { identity, shareSessionId: message.shareSessionId,
        controlSessionId: message.controlSessionId, trackSid: message.trackSid };
      const session: ControllerInputSession = { room, identity, shareId: message.shareSessionId,
        controlSessionId: message.controlSessionId, sequence: 0, exiting: false, pointerSender: null };
      session.pointerSender = new LatestValueSender(
        ({ sequence, input }) => this.publishInput(session, sequence, input),
        () => { if (this.controllerInput === session) void this.exitControl(); },
      );
      this.controllerInput = session;
    } else if (message.type === 'reject') {
      if (this.pending.value?.identity === identity && this.pending.value.requestId === message.requestId) {
        void this.cancelPending(identity, room);
        this.options.setNotice('对方未接受远程控制，或准备画面失败。');
      }
    } else if (message.type === 'cancel') {
      if (this.request.value?.identity === identity && this.request.value.requestId === message.requestId) {
        void this.reject();
      }
      const controller = this.authorization.controller;
      if (controller?.identity === identity && controller.requestId === message.requestId) {
        void this.revokeOwnerControl(room);
      }
    } else if (message.type === 'revoke') {
      const active = this.active.value;
      if (active?.identity === identity && active.shareSessionId === message.shareSessionId
          && active.controlSessionId === message.controlSessionId) void this.exitControl();
      if (this.authorizedShare?.shareId === message.shareSessionId
          && this.authorization.controller?.identity === identity
          && this.authorization.controller.controlSessionId === message.controlSessionId) {
        void this.revokeOwnerControl(room, false);
      }
    } else if (message.type === 'input') this.receiveInput(room, identity, message);
  }

  private busy() {
    return Boolean(this.request.value || this.pending.value || this.active.value || this.owner.value
      || this.grantAttempt || this.controllerPreparation || this.nativeCleanup || this.restoring.value);
  }

  async requestControl(identity: string) {
    const room = this.options.currentRoom();
    if (!room || !this.options.isCurrentRoom(room) || !room.remoteParticipants.has(identity)
        || !this.available.value[identity]) return false;
    if (this.busy()) {
      this.options.setNotice('请先结束当前远程控制、申请或清理，再申请新的控制。');
      return false;
    }
    const pending = { identity, requestId: crypto.randomUUID(), phase: 'waiting' as const };
    this.pending.value = pending;
    this.pendingTimer = setTimeout(() => {
      if (this.pending.value?.requestId === pending.requestId) {
        void this.cancelPending(identity, room);
        this.options.setNotice('远程控制申请已超时，请重新申请。');
      }
    }, 30_000);
    try {
      await this.send(room, identity, { type: 'request', requestId: pending.requestId });
      return this.options.isCurrentRoom(room) && this.pending.value?.requestId === pending.requestId;
    } catch {
      if (this.pending.value === pending) {
        await this.cancelPending(identity, room);
        this.options.setNotice('远程控制申请发送失败。');
      }
      return false;
    }
  }

  private async prepareController(room: Room, pending: NonNullable<RemoteControlSession['pending']['value']>) {
    const attempt = {};
    this.controllerPreparation = attempt;
    const preparing = { ...pending, phase: 'preparing' as const };
    this.pending.value = preparing;
    const current = () => this.options.isCurrentRoom(room) && this.pending.value === preparing
      && this.controllerPreparation === attempt;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      // 本机暂停已完成后仍需等待对方授权，不能让准备任务的结束撤销超时资格。
      if (this.options.isCurrentRoom(room) && this.pending.value === preparing) {
        void this.cancelPending(pending.identity, room);
        this.options.setNotice('远程控制准备已超时，已取消本次申请。');
      }
    }, 20_000);
    try {
      const restore = await this.options.suspendController(room, current);
      if (!current()) { await this.restore(restore); return; }
      this.controllerRestore = restore;
      await this.send(room, pending.identity, { type: 'controllerReady', requestId: pending.requestId });
    } catch {
      if (current()) {
        await this.cancelPending(pending.identity, room);
        this.options.setNotice('本机共享未能暂停，远程控制未开始。');
      }
    } finally {
      if (this.controllerPreparation === attempt) this.controllerPreparation = null;
    }
  }

  async allow(sourceId: string, publicVideo: boolean) {
    const room = this.options.currentRoom();
    const pending = this.request.value;
    const desktop = this.options.desktop();
    if (!room || !pending || !desktop || this.grantAttempt || this.nativeCleanup
        || !room.remoteParticipants.has(pending.identity)) return false;
    const attempt: GrantAttempt = { controller: new AbortController() };
    this.grantAttempt = attempt;
    this.granting.value = true;
    clearTimeout(this.requestTimer);
    const current = () => !attempt.controller.signal.aborted && this.options.isCurrentRoom(room)
      && this.request.value === pending && room.remoteParticipants.has(pending.identity);
    const controlSessionId = crypto.randomUUID();
    let authorizationAttempted = false;
    let share: RemoteControlShare | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = new Promise<boolean>(resolve => {
        attempt.ready = resolve;
        readyTimer = setTimeout(() => resolve(false), 10_000);
      });
      await this.send(room, pending.identity, { type: 'accept', requestId: pending.requestId });
      if (!await ready || !current()) throw new Error('remoteControlPreparationCancelled');
      clearTimeout(readyTimer);
      const prepared = await this.options.prepareTarget(room, pending.identity, sourceId, publicVideo, current, attempt.controller.signal);
      share = prepared.share;
      this.targetRestore = prepared.restore;
      if (!current() || this.options.currentShare() !== share || !share.liveKitTrackId) throw new Error('remoteControlPreparationCancelled');
      this.authorizedShare = share;
      this.authorization = new RemoteControlAuthorization();
      const authorization = this.authorization;
      authorization.beginShare(share.shareId, share.kind);
      authorization.request(pending.identity, share.shareId, pending.requestId);
      authorizationAttempted = true;
      await desktop.authorizeNativeRemoteControl(share.captureSessionId, controlSessionId, pending.identity);
      if (!current() || this.options.currentShare() !== share
          || !authorization.grant(pending.identity, pending.requestId, controlSessionId)) {
        throw new Error('remoteControlPreparationCancelled');
      }
      this.remoteInputCount = 0;
      this.remoteInputWindowStarted = Date.now();
      await this.send(room, pending.identity, { type: 'allow', shareSessionId: share.shareId,
        requestId: pending.requestId, controlSessionId, trackSid: share.liveKitTrackId });
      if (!current() || this.options.currentShare() !== share) throw new Error('remoteControlPreparationCancelled');
      this.owner.value = { identity: pending.identity, controlSessionId, public: publicVideo };
      this.request.value = null;
      this.broadcast(room);
      return true;
    } catch (error) {
      if (this.request.value === pending) this.request.value = null;
      if (share && authorizationAttempted && this.options.isCurrentRoom(room)) {
        void this.send(room, pending.identity, { type: 'revoke', shareSessionId: share.shareId, controlSessionId }).catch(() => {});
      }
      // 授权 IPC 失败也可能已经到达原生端；必须确认撤销，不能按失败当作未授权。
      if (authorizationAttempted && share && this.lastStoppedCaptureId !== share.captureSessionId) {
        this.authorization.beginCleanup(controlSessionId);
        this.nativeCleanup = { room, captureSessionId: share.captureSessionId, controlSessionId, authorization: this.authorization };
        this.cleanupPending.value = true;
        await this.doRetryCleanup();
      }
      const restored = !this.nativeCleanup && await this.finishTarget();
      if (this.options.isCurrentRoom(room)) {
        void this.send(room, pending.identity, { type: 'reject', requestId: pending.requestId }).catch(() => {});
        if (error instanceof Error && error.message === 'remoteControlShareRestoreFailed') {
          this.options.setNotice('远程控制未开始，画面清理或原共享恢复失败，请检查共享状态后重试。');
        } else if (!attempt.controller.signal.aborted && restored) this.options.setNotice('无法准备远程控制，请检查共享状态后重新申请。');
      }
      return false;
    } finally {
      clearTimeout(readyTimer);
      attempt.ready = undefined;
      if (this.grantAttempt === attempt) {
        this.grantAttempt = null;
        this.granting.value = false;
      }
    }
  }

  async reject() {
    const request = this.request.value;
    const room = this.options.currentRoom();
    if (!request) return;
    this.request.value = null;
    clearTimeout(this.requestTimer);
    if (this.grantAttempt) {
      this.grantAttempt.controller.abort();
      this.grantAttempt.ready?.(false);
    }
    if (room) {
      void this.send(room, request.identity, { type: 'reject', requestId: request.requestId }).catch(() => {});
    }
  }

  async cancelPending(identity?: string, room = this.options.currentRoom()) {
    const pending = this.pending.value;
    if (!pending || (identity && pending.identity !== identity)) return;
    this.pending.value = null;
    clearTimeout(this.pendingTimer);
    if (room) {
      void this.send(room, pending.identity, { type: 'cancel', requestId: pending.requestId }).catch(() => {
        if (this.options.isCurrentRoom(room)) this.options.setNotice('取消通知发送失败，本地不会接受迟到授权。');
      });
    }
    await this.finishController();
  }

  private receiveInput(room: Room, identity: string, message: Extract<ReturnType<typeof decodeRemoteControlMessage>, { type: 'input' }>) {
    if (!this.authorization.acceptsInput(identity, message.shareSessionId,
      message.controlSessionId, message.sequence, message.input.kind === 'move')) return;
    const now = Date.now();
    if (now - this.remoteInputWindowStarted >= 1000) { this.remoteInputWindowStarted = now; this.remoteInputCount = 0; }
    if (this.remoteInputCount >= REMOTE_CONTROL_MAX_INPUTS_PER_SECOND) {
      if (message.input.kind !== 'move') void this.revokeOwnerControl(room);
      return;
    }
    this.remoteInputCount++;
    const share = this.options.currentShare();
    const desktop = this.options.desktop();
    if (!share || !desktop || share !== this.authorizedShare) return;
    void desktop.sendNativeRemoteInput(share.captureSessionId, message.controlSessionId, identity,
      message.sequence, message.input).catch(() => {
        if (this.options.isCurrentRoom(room) && this.authorization.controller?.controlSessionId === message.controlSessionId) {
          this.options.setNotice('远程输入失败，控制已撤销。');
          void this.revokeOwnerControl(room);
        }
      });
  }

  private async publishInput(session: ControllerInputSession, sequence: number, input: RemoteControlInput) {
    if (session.exiting || this.controllerInput !== session || !this.options.isCurrentRoom(session.room)
        || this.active.value?.controlSessionId !== session.controlSessionId) return false;
    try {
      await this.send(session.room, session.identity, { type: 'input', shareSessionId: session.shareId,
        controlSessionId: session.controlSessionId, sequence, input }, input.kind !== 'move');
      return true;
    } catch {
      if (this.controllerInput === session) {
        this.options.setNotice('远程输入发送失败，请退出控制后重试。');
        void this.exitControl(session);
      }
      return false;
    }
  }

  sendInput(input: RemoteControlInput) {
    const session = this.controllerInput;
    if (!session || !this.options.isCurrentRoom(session.room)) return Promise.resolve(false);
    if (input.kind === 'move') {
      session.pointerSender?.push({ sequence: ++session.sequence, input });
      return Promise.resolve(true);
    }
    return this.publishInput(session, ++session.sequence, input);
  }

  async exitControl(expected?: ControllerInputSession) {
    const session = this.controllerInput;
    if (!session || (expected && session !== expected)) return false;
    session.exiting = true;
    session.pointerSender?.dispose();
    this.controllerInput = null;
    this.active.value = null;
    void this.send(session.room, session.identity, { type: 'revoke', shareSessionId: session.shareId,
      controlSessionId: session.controlSessionId }).catch(() => {
      if (this.options.isCurrentRoom(session.room) && !this.pending.value && !this.active.value) {
        this.options.setNotice('退出通知发送失败，本地输入已停止。');
      }
    });
    await this.finishController();
    return true;
  }

  private async restore(restore: () => Promise<void>) {
    this.restoring.value = true;
    try { await restore(); return true; }
    catch {
      this.options.setNotice('远程控制已停止，画面清理或原共享恢复失败，请检查共享状态后重试。');
      return false;
    }
    finally { this.restoring.value = false; }
  }

  private async finishController() {
    const restore = this.controllerRestore;
    this.controllerRestore = null;
    if (restore) await this.restore(restore);
  }

  private async finishTarget() {
    const restore = this.targetRestore;
    this.targetRestore = null;
    this.authorizedShare = null;
    this.authorization.clear();
    const restored = !restore || await this.restore(restore);
    const room = this.options.currentRoom();
    if (room) this.broadcast(room);
    return restored;
  }

  private async doRetryCleanup() {
    const cleanup = this.nativeCleanup;
    const desktop = this.options.desktop();
    if (!cleanup || !desktop) return !cleanup;
    try {
      await desktop.revokeNativeRemoteControl(cleanup.captureSessionId, cleanup.controlSessionId);
      if (this.nativeCleanup !== cleanup) return !this.nativeCleanup;
      cleanup.authorization.finishRevoke(cleanup.controlSessionId);
      this.nativeCleanup = null;
      this.cleanupPending.value = false;
      return true;
    } catch {
      if (this.nativeCleanup === cleanup) {
        this.cleanupPending.value = true;
        if (this.options.isCurrentRoom(cleanup.room)) this.options.setNotice('远程控制输入尚未释放，请重试撤销。');
      }
      return false;
    }
  }

  completeNativeCleanup(captureSessionId: string) {
    this.lastStoppedCaptureId = captureSessionId;
    const cleanup = this.nativeCleanup;
    if (cleanup?.captureSessionId !== captureSessionId) return;
    cleanup.authorization.finishRevoke(cleanup.controlSessionId);
    this.nativeCleanup = null;
    this.cleanupPending.value = false;
    if (!this.grantAttempt) void this.finishTarget();
  }

  private async revokeOwnerControl(room: Room, notifyPeer = true) {
    const share = this.authorizedShare;
    const controller = this.authorization.controller;
    if (controller && share) {
      this.authorization.beginRevoke(controller.identity, controller.controlSessionId);
      this.owner.value = null;
      this.nativeCleanup = { room, captureSessionId: share.captureSessionId,
        controlSessionId: controller.controlSessionId, authorization: this.authorization };
      this.cleanupPending.value = true;
      if (notifyPeer && this.options.isCurrentRoom(room)) {
        void this.send(room, controller.identity, { type: 'revoke', shareSessionId: share.shareId,
          controlSessionId: controller.controlSessionId }).catch(() => {});
      }
    }
    const cleaned = await this.doRetryCleanup();
    if (cleaned) await this.finishTarget();
    return cleaned;
  }

  async endShare(room: Room, share: RemoteControlShare | null) {
    if (share && this.authorizedShare === share) {
      if (this.grantAttempt) {
        this.grantAttempt.controller.abort();
        this.grantAttempt.ready?.(false);
      }
      if (this.owner.value) await this.revokeOwnerControl(room);
    }
    this.broadcast(room);
  }

  participantDisconnected(room: Room, identity: string) {
    if (!this.options.isCurrentRoom(room)) return;
    if (this.request.value?.identity === identity) void this.reject();
    if (this.pending.value?.identity === identity) void this.cancelPending(identity, room);
    if (this.active.value?.identity === identity) void this.exitControl();
    if (this.authorization.controller?.identity === identity) void this.revokeOwnerControl(room, false);
    const available = { ...this.available.value }, shares = { ...this.shares.value }, presentations = { ...this.presentations.value };
    delete available[identity]; delete shares[identity]; delete presentations[identity];
    this.available.value = available;
    this.shares.value = shares;
    this.presentations.value = presentations;
  }

  trackUnpublished(room: Room, identity: string, trackSid: string) {
    if (!this.options.isCurrentRoom(room)) return;
    // 旧公开轨道的撤销通知可能晚于新私密授权，不能误停新的控制会话。
    if (this.active.value?.identity === identity && this.active.value.trackSid === trackSid) void this.exitControl();
  }

  connectionReconnecting(room: Room) {
    void this.reject();
    void this.cancelPending(undefined, room);
    if (this.controllerInput) void this.exitControl();
    if (this.authorization.controller) void this.revokeOwnerControl(room);
  }

  clearRoomState() {
    clearTimeout(this.requestTimer);
    clearTimeout(this.pendingTimer);
    if (this.grantAttempt) {
      this.grantAttempt.controller.abort();
      this.grantAttempt.ready?.(false);
    }
    this.controllerInput?.pointerSender?.dispose();
    this.controllerInput = null;
    this.active.value = null;
    this.pending.value = null;
    this.request.value = null;
    this.granting.value = false;
    this.owner.value = null;
    this.shares.value = {};
    this.available.value = {};
    this.presentations.value = {};
    void this.finishController();
    // 离房负责停止旧采集；不能用迟到的恢复重新创建房间或采集。
    if (!this.grantAttempt && !this.nativeCleanup) void this.finishTarget();
  }

  async revokeOwner() {
    const room = this.options.currentRoom();
    return room ? this.revokeOwnerControl(room) : false;
  }

  async retryCleanup() {
    const cleaned = await this.doRetryCleanup();
    if (cleaned) await this.finishTarget();
    return cleaned;
  }
}

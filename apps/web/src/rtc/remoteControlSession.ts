import { ref } from 'vue';
import type { Room } from 'livekit-client';
import {
  decodeRemoteControlMessage, encodeRemoteControlMessage, REMOTE_CONTROL_TOPIC,
  LatestValueSender, RemoteControlAuthorization, type RemoteControlInput,
} from './remoteControl';

/** 已发布的普通共享资源；远控仅在其有效期间申请和使用授权。 */
export interface RemoteControlShare {
  readonly shareId: string;
  readonly captureSessionId: string;
  readonly sourceId: string;
  readonly kind: 'monitor' | 'window';
  readonly liveKitTrackId: string | null;
}

interface RemoteControlSessionOptions {
  currentRoom(): Room | null;
  isCurrentRoom(room: Room): boolean;
  currentShare(): RemoteControlShare | null;
  desktop(): Window['lycanDesktop'];
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
  shareId: string;
  identity: string;
  requestId: string;
  controlSessionId: string;
  authorization: RemoteControlAuthorization;
}

/** 管理远控申请、授权、输入队列和原生授权清理。 */
export class RemoteControlSession {
  readonly request = ref<{ identity: string; requestId: string } | null>(null);
  readonly granting = ref(false);
  readonly cleanupPending = ref(false);
  readonly owner = ref<{ identity: string; controlSessionId: string } | null>(null);
  readonly shares = ref<Record<string, { shareSessionId: string; kind: 'monitor' | 'window' }>>({});
  readonly active = ref<{ identity: string; shareSessionId: string; controlSessionId: string } | null>(null);
  readonly pending = ref<{ identity: string; shareSessionId: string; requestId: string } | null>(null);

  private authorization = new RemoteControlAuthorization();
  private readonly pendingShareQueries = new Map<string, string>();
  private controllerInput: ControllerInputSession | null = null;
  private nativeCleanup: NativeRemoteControlCleanup | null = null;
  private grantAttempt: object | null = null;
  private authorizedShare: RemoteControlShare | null = null;
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

  beginShare(room: Room, share: RemoteControlShare) {
    if (!this.options.isCurrentRoom(room)) return;
    this.authorization = new RemoteControlAuthorization();
    this.authorizedShare = share;
    this.authorization.beginShare(share.shareId, share.kind);
    for (const identity of room.remoteParticipants.keys()) {
      void this.send(room, identity, { type: 'share', shareSessionId: share.shareId, sourceKind: share.kind }).catch(() => {});
    }
  }

  announceParticipant(room: Room, identity: string) {
    const share = this.options.currentShare();
    if (share) {
      void this.send(room, identity, { type: 'share', shareSessionId: share.shareId, sourceKind: share.kind }).catch(() => {});
    }
    const requestId = crypto.randomUUID();
    this.pendingShareQueries.set(identity, requestId);
    void this.send(room, identity, { type: 'queryShare', requestId }).catch(() => {});
  }

  queryParticipants(room: Room) {
    room.remoteParticipants.forEach((_participant, identity) => this.announceParticipant(room, identity));
  }

  handleData(room: Room, identity: string, payload: Uint8Array, hasScreenShareTrack: boolean) {
    if (!this.options.isCurrentRoom(room)) return;
    const message = decodeRemoteControlMessage(payload);
    if (!message) return;
    if (message.type === 'queryShare') {
      const share = this.options.currentShare();
      if (share) {
        void this.send(room, identity, {
          type: 'shareState', shareSessionId: share.shareId, sourceKind: share.kind, requestId: message.requestId,
        }).catch(() => {});
      }
      return;
    }
    if (message.type === 'share' || message.type === 'shareState') {
      if (message.type === 'shareState'
        && (this.pendingShareQueries.get(identity) !== message.requestId || !hasScreenShareTrack)) return;
      this.pendingShareQueries.delete(identity);
      const previous = this.shares.value[identity];
      if (previous && previous.shareSessionId !== message.shareSessionId) {
        if (this.pending.value?.identity === identity && this.pending.value.shareSessionId === previous.shareSessionId) {
          this.pending.value = null;
        }
        if (this.controllerInput?.identity === identity && this.controllerInput.shareId === previous.shareSessionId) {
          this.clearControllerInput(this.controllerInput);
        }
      }
      this.shares.value = { ...this.shares.value,
        [identity]: { shareSessionId: message.shareSessionId, kind: message.sourceKind } };
      return;
    }
    if (message.type === 'shareStopped') {
      this.pendingShareQueries.delete(identity);
      if (this.shares.value[identity]?.shareSessionId === message.shareSessionId) {
        const next = { ...this.shares.value };
        delete next[identity];
        this.shares.value = next;
      }
      if (this.pending.value?.identity === identity && this.pending.value.shareSessionId === message.shareSessionId) {
        this.pending.value = null;
      }
      if (this.active.value?.identity === identity && this.active.value.shareSessionId === message.shareSessionId) {
        this.clearControllerInput(this.controllerInput ?? undefined);
      } else if (this.controllerInput?.identity === identity && this.controllerInput.shareId === message.shareSessionId) {
        this.clearControllerInput(this.controllerInput);
      }
      return;
    }
    if (message.type === 'request') {
      const share = this.options.currentShare();
      if (!share || share.kind !== 'monitor' || share.shareId !== message.shareSessionId) return;
      const result = this.grantAttempt || this.nativeCleanup ? 'denied'
        : this.authorization.request(identity, message.shareSessionId, message.requestId);
      if (result === 'accepted') this.request.value = { identity, requestId: message.requestId };
      else if (result === 'denied') {
        void this.send(room, identity, { type: 'reject', shareSessionId: message.shareSessionId,
          requestId: message.requestId }).catch(() => {});
      }
      return;
    }
    if (message.type === 'cancel') {
      if (this.options.currentShare()?.shareId !== message.shareSessionId) return;
      const rejected = this.authorization.reject(identity, message.requestId);
      if (rejected && this.request.value?.identity === identity && this.request.value.requestId === message.requestId) {
        this.request.value = null;
      }
      const granted = this.authorization.controller;
      if (!rejected && granted?.identity === identity && granted.requestId === message.requestId) {
        void this.revokeOwnerControl(room);
      }
      return;
    }
    if (message.type === 'allow') {
      const pending = this.pending.value;
      if (!pending || pending.identity !== identity || pending.shareSessionId !== message.shareSessionId
          || pending.requestId !== message.requestId) return;
      this.pending.value = null;
      this.active.value = { identity, shareSessionId: message.shareSessionId, controlSessionId: message.controlSessionId };
      const session: ControllerInputSession = { room, identity, shareId: message.shareSessionId,
        controlSessionId: message.controlSessionId, sequence: 0, exiting: false, pointerSender: null };
      session.pointerSender = new LatestValueSender(
        ({ sequence, input }) => this.publishInput(session, sequence, input),
        () => { if (this.controllerInput === session) void this.exitControl(); },
      );
      this.controllerInput?.pointerSender?.dispose();
      this.controllerInput = session;
      return;
    }
    if (message.type === 'reject') {
      if (this.pending.value?.identity === identity && this.pending.value.shareSessionId === message.shareSessionId
          && this.pending.value.requestId === message.requestId) this.pending.value = null;
      return;
    }
    if (message.type === 'revoke') {
      const active = this.active.value;
      if (active?.identity === identity && active.shareSessionId === message.shareSessionId
          && active.controlSessionId === message.controlSessionId) this.clearControllerInput(this.controllerInput ?? undefined);
      if (this.options.currentShare()?.shareId === message.shareSessionId
          && this.authorization.controller?.identity === identity
          && this.authorization.controller.controlSessionId === message.controlSessionId) {
        void this.revokeOwnerControl(room, false);
      }
      return;
    }
    if (message.type === 'input') this.receiveInput(room, identity, message);
  }

  private receiveInput(room: Room, identity: string, message: Extract<ReturnType<typeof decodeRemoteControlMessage>, { type: 'input' }>) {
    if (!this.authorization.acceptsInput(identity, message.shareSessionId,
      message.controlSessionId, message.sequence, message.input.kind === 'move')) return;
    const now = Date.now();
    if (now - this.remoteInputWindowStarted >= 1000) { this.remoteInputWindowStarted = now; this.remoteInputCount = 0; }
    if (this.remoteInputCount >= 120) {
      if (message.input.kind !== 'move') {
        this.options.setNotice('远程输入超过安全频率，控制已结束并释放按键。');
        void this.revokeOwnerControl(room);
      }
      return;
    }
    this.remoteInputCount++;
    const share = this.options.currentShare();
    const controller = this.authorization.controller;
    const desktop = this.options.desktop();
    if (!share || !desktop || !controller || share.shareId !== message.shareSessionId
        || controller.controlSessionId !== message.controlSessionId || controller.identity !== identity) return;
    void desktop.sendNativeRemoteInput(share.captureSessionId, message.controlSessionId, identity,
      message.sequence, message.input).catch(() => {
        const currentController = this.authorization.controller;
        if (!this.options.isCurrentRoom(room) || this.options.currentShare() !== share
            || currentController?.controlSessionId !== message.controlSessionId) return;
        this.options.setNotice('远程输入失败，控制已撤销。');
        void this.revokeOwnerControl(room);
      });
  }

  participantDisconnected(room: Room, identity: string) {
    if (!this.options.isCurrentRoom(room)) return;
    if (this.authorization.controller?.identity === identity) void this.revokeOwnerControl(room);
    const pendingApproval = this.authorization.pendingRequest;
    if (pendingApproval?.identity === identity) {
      this.authorization.reject(identity, pendingApproval.requestId);
      if (this.request.value?.requestId === pendingApproval.requestId) this.request.value = null;
    }
    if (this.pending.value?.identity === identity) void this.cancelPending(identity);
    if (this.controllerInput?.identity === identity) this.clearControllerInput(this.controllerInput);
    this.pendingShareQueries.delete(identity);
    const next = { ...this.shares.value };
    delete next[identity];
    this.shares.value = next;
  }

  trackUnpublished(room: Room, identity: string) {
    if (!this.options.isCurrentRoom(room)) return;
    const share = this.shares.value[identity];
    if (!share) return;
    const next = { ...this.shares.value };
    delete next[identity];
    this.shares.value = next;
    if (this.pending.value?.identity === identity && this.pending.value.shareSessionId === share.shareSessionId) {
      void this.cancelPending(identity, share.shareSessionId);
    }
    if (this.controllerInput?.identity === identity && this.controllerInput.shareId === share.shareSessionId) {
      this.clearControllerInput(this.controllerInput);
    }
  }

  async requestControl(identity: string) {
    const room = this.options.currentRoom();
    const share = this.shares.value[identity];
    if (!room || !this.options.isCurrentRoom(room) || !share || share.kind !== 'monitor' || this.pending.value
        || this.active.value || this.controllerInput || this.nativeCleanup) return false;
    const requestId = crypto.randomUUID();
    this.pending.value = { identity, shareSessionId: share.shareSessionId, requestId };
    try {
      await this.send(room, identity, { type: 'request', shareSessionId: share.shareSessionId, requestId });
      return this.options.isCurrentRoom(room) && this.pending.value?.requestId === requestId;
    } catch {
      if (!this.options.isCurrentRoom(room) || this.pending.value?.requestId !== requestId) return false;
      this.pending.value = null;
      this.options.setNotice('远程控制申请发送失败。');
      return false;
    }
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

  private clearControllerInput(session?: ControllerInputSession) {
    const current = this.controllerInput;
    if (!current || (session && current !== session)) return;
    current.pointerSender?.dispose();
    this.controllerInput = null;
    if (this.active.value?.controlSessionId === current.controlSessionId) this.active.value = null;
  }

  async exitControl(expected?: ControllerInputSession) {
    const session = this.controllerInput;
    if (!session || (expected && session !== expected)) return false;
    session.exiting = true;
    session.pointerSender?.dispose();
    this.clearControllerInput(session);
    void this.send(session.room, session.identity, { type: 'revoke', shareSessionId: session.shareId,
      requestId: session.controlSessionId, controlSessionId: session.controlSessionId }).catch(() => {
      if (this.options.isCurrentRoom(session.room) && !this.controllerInput && !this.pending.value && !this.active.value
          && this.shares.value[session.identity]?.shareSessionId === session.shareId) {
        this.options.setNotice('退出控制通知发送失败，本地输入已停止。');
      }
    });
    return true;
  }

  async cancelPending(identity?: string, shareId?: string, room = this.options.currentRoom()) {
    const pending = this.pending.value;
    if (!pending || (identity && pending.identity !== identity) || (shareId && pending.shareSessionId !== shareId)) return;
    this.pending.value = null;
    if (room) {
      void this.send(room, pending.identity, { type: 'cancel', shareSessionId: pending.shareSessionId,
        requestId: pending.requestId }).catch(() => {
        if (this.options.isCurrentRoom(room) && !this.pending.value) {
          this.options.setNotice('取消申请通知发送失败；迟到的允许仍会被忽略。');
        }
      });
    }
  }

  private findCurrentRoom(): Room | null {
    return this.options.currentRoom();
  }

  private async doRetryCleanup() {
    const cleanup = this.nativeCleanup;
    const desktop = this.options.desktop();
    if (!cleanup || !desktop) return false;
    this.cleanupPending.value = true;
    try {
      await desktop.revokeNativeRemoteControl(cleanup.captureSessionId, cleanup.controlSessionId);
      if (this.nativeCleanup !== cleanup) return false;
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
    const cleanup = this.nativeCleanup;
    if (!cleanup || cleanup.captureSessionId !== captureSessionId) return;
    cleanup.authorization.finishRevoke(cleanup.controlSessionId);
    this.nativeCleanup = null;
    this.cleanupPending.value = false;
  }

  private async revokeOwnerControl(room: Room, notifyPeer = true) {
    if (this.nativeCleanup) return this.doRetryCleanup();
    const authorization = this.authorization;
    const controller = authorization.controller;
    const share = this.authorizedShare;
    if (!controller || !share) return false;
    const revoking = authorization.beginRevoke(controller.identity, controller.controlSessionId);
    if (!revoking) return false;
    const cleanup: NativeRemoteControlCleanup = { room, captureSessionId: share.captureSessionId,
      shareId: share.shareId, identity: revoking.identity, requestId: revoking.requestId,
      controlSessionId: revoking.controlSessionId, authorization };
    this.nativeCleanup = cleanup;
    this.owner.value = null;
    this.cleanupPending.value = true;
    if (notifyPeer && this.options.isCurrentRoom(room)) {
      void this.send(room, cleanup.identity, { type: 'revoke', shareSessionId: cleanup.shareId,
        requestId: cleanup.requestId, controlSessionId: cleanup.controlSessionId }).catch(() => {
        if (this.options.isCurrentRoom(room) && this.options.currentShare() === share && this.nativeCleanup === cleanup) {
          this.options.setNotice('撤销控制通知发送失败，但本地输入已停止。');
        }
      });
    }
    return this.doRetryCleanup();
  }

  private async retainNativeGrant(room: Room, share: RemoteControlShare, authorization: RemoteControlAuthorization, identity: string,
    requestId: string, controlSessionId: string) {
    // 授权响应已失效仍需撤销其原生会话，清理完成前阻止下一次授权。
    authorization.beginCleanup(controlSessionId);
    const cleanup: NativeRemoteControlCleanup = { room, captureSessionId: share.captureSessionId,
      shareId: share.shareId, identity, requestId, controlSessionId, authorization };
    this.nativeCleanup = cleanup;
    if (this.authorizedShare === share) this.owner.value = null;
    this.cleanupPending.value = true;
    return this.doRetryCleanup();
  }

  async allow() {
    const room = this.findCurrentRoom();
    const authorization = this.authorization;
    const pending = authorization.pendingRequest;
    const share = this.options.currentShare();
    const desktop = this.options.desktop();
    if (this.grantAttempt || this.nativeCleanup || !room || !pending || !share || share.kind !== 'monitor' || !desktop
        || !room.remoteParticipants.has(pending.identity)) return false;
    const controlSessionId = crypto.randomUUID();
    const attempt = {};
    this.grantAttempt = attempt;
    this.granting.value = true;
    let nativeAuthorized = false;
    try {
      await desktop.authorizeNativeRemoteControl(share.captureSessionId, controlSessionId, pending.identity);
      nativeAuthorized = true;
      const stillPending = authorization.pendingRequest;
      if (!this.options.isCurrentRoom(room) || this.options.currentShare() !== share
          || !room.remoteParticipants.has(pending.identity) || stillPending?.identity !== pending.identity
          || stillPending.requestId !== pending.requestId
          || !authorization.grant(pending.identity, pending.requestId, controlSessionId)) {
        authorization.reject(pending.identity, pending.requestId);
        await this.retainNativeGrant(room, share, authorization, pending.identity, pending.requestId, controlSessionId);
        return false;
      }
      this.request.value = null;
      await this.send(room, pending.identity, { type: 'allow', shareSessionId: share.shareId,
        requestId: pending.requestId, controlSessionId });
      if (!this.options.isCurrentRoom(room) || this.options.currentShare() !== share
          || authorization.controller?.controlSessionId !== controlSessionId) {
        await this.retainNativeGrant(room, share, authorization, pending.identity, pending.requestId, controlSessionId);
        return false;
      }
      this.owner.value = { identity: pending.identity, controlSessionId };
      return true;
    } catch {
      if (authorization.pendingRequest?.requestId === pending.requestId) {
        authorization.reject(pending.identity, pending.requestId);
      }
      if (this.request.value?.requestId === pending.requestId) this.request.value = null;
      if (nativeAuthorized) {
        if (this.options.isCurrentRoom(room) && this.options.currentShare() === share
            && authorization.controller?.controlSessionId === controlSessionId) await this.revokeOwnerControl(room);
        else await this.retainNativeGrant(room, share, authorization, pending.identity, pending.requestId, controlSessionId);
      }
      if (this.options.isCurrentRoom(room) && this.options.currentShare() === share
          && !this.nativeCleanup && !this.request.value) this.options.setNotice('无法启动远程控制，请重新申请。');
      return false;
    } finally {
      if (this.grantAttempt === attempt) {
        this.grantAttempt = null;
        this.granting.value = false;
      }
    }
  }

  async reject() {
    const room = this.findCurrentRoom();
    const authorization = this.authorization;
    const pending = authorization.pendingRequest;
    const share = this.options.currentShare();
    if (!room || !pending || !share) return;
    authorization.reject(pending.identity, pending.requestId);
    if (this.request.value?.requestId === pending.requestId) this.request.value = null;
    void this.send(room, pending.identity, { type: 'reject', shareSessionId: share.shareId,
      requestId: pending.requestId }).catch(() => {
      if (this.options.isCurrentRoom(room) && this.options.currentShare() === share && !authorization.pendingRequest) {
        this.options.setNotice('拒绝通知发送失败。');
      }
    });
  }

  async endShare(room: Room, share: RemoteControlShare | null) {
    if (!share || (this.authorizedShare !== share && this.options.currentShare() !== share)) return;
    const authorization = this.authorization;
    const pending = authorization.pendingRequest;
    const ownerAtEnd = this.owner.value;
    if (pending) {
      authorization.reject(pending.identity, pending.requestId);
      if (this.request.value?.requestId === pending.requestId) this.request.value = null;
      void this.send(room, pending.identity, { type: 'reject', shareSessionId: share.shareId,
        requestId: pending.requestId }).catch(() => {
        if (this.options.isCurrentRoom(room) && (!this.options.currentShare() || this.options.currentShare() === share)) {
          this.options.setNotice('拒绝通知发送失败，本地共享正在停止。');
        }
      });
    }
    if (authorization.controller) await this.revokeOwnerControl(room);
    for (const identity of room.remoteParticipants.keys()) {
      void this.send(room, identity, { type: 'shareStopped', shareSessionId: share.shareId }).catch(() => {
        if (this.options.isCurrentRoom(room) && (!this.options.currentShare() || this.options.currentShare() === share)) {
          this.options.setNotice('共享停止通知发送失败。');
        }
      });
    }
    if (this.authorizedShare === share) {
      this.authorizedShare = null;
      authorization.clear();
    }
    if (!pending || this.request.value?.requestId === pending.requestId) this.request.value = null;
    if (ownerAtEnd && this.owner.value?.controlSessionId === ownerAtEnd.controlSessionId) this.owner.value = null;
  }

  connectionReconnecting(room: Room) {
    if (this.authorization.controller) void this.revokeOwnerControl(room);
    if (this.authorization.pendingRequest) void this.reject();
    if (this.pending.value) void this.cancelPending(undefined, undefined, room);
    if (this.controllerInput) void this.exitControl();
  }

  clearRoomState() {
    this.controllerInput?.pointerSender?.dispose();
    this.controllerInput = null;
    this.authorization.clear();
    this.authorizedShare = null;
    this.request.value = null;
    this.owner.value = null;
    this.active.value = null;
    this.pending.value = null;
    this.shares.value = {};
    this.pendingShareQueries.clear();
    // 旧共享的授权 IPC 仍可能迟到成功；完成前不允许新共享启动授权。
    this.granting.value = false;
    this.cleanupPending.value = Boolean(this.nativeCleanup);
  }

  async revokeOwner() {
    const room = this.findCurrentRoom();
    if (!room) return false;
    return this.revokeOwnerControl(room);
  }

  async retryCleanup() { return this.doRetryCleanup(); }
}

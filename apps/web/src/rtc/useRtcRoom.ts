import { markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import {
  AudioPresets, ConnectionState, DisconnectReason, LocalAudioTrack, Room, RoomEvent, Track, supportsAV1,
  type VideoCodec,
  type LocalTrack, type Participant, type RemoteParticipant,
  type ParticipantTrackPermission,
} from 'livekit-client';
import { requestRtcToken, TokenRequestError } from './tokenApi';
import { DEFAULT_AUDIO_PREFERENCES, normalizeAudioVolume, unappliedCaptureProcessing,
  type AudioProcessingSettings } from './audioPreferences';
import { ENTRANCE_SOUND_MAX_BYTES, ENTRANCE_SOUND_TOPIC, isSupportedEntranceSoundType } from './entranceSound';
import { MicrophoneAudioProcessor } from './microphoneAudioProcessor';
import { MicrophoneLoopback } from './microphoneLoopback';
import { NativeScreenVideoSession } from './nativeScreenVideo';
import { NativeScreenAudioSession } from './nativeScreenAudio';
import { NativeMicrophoneAudioSession, type NativeMicrophoneSettings } from './nativeMicrophoneAudio';
import { nativeScreenAudioMode } from './nativeScreenAudioMode';
import { REMOTE_CONTROL_TOPIC, type RemoteControlInput } from './remoteControl';
import { RemoteControlSession, type RemoteControlShare } from './remoteControlSession';
import { screenShareQuality, screenShareVideoPreset, type ScreenShareQualityId } from './screenShareQuality';

type RoomStatus = 'idle' | 'joining' | 'connected' | 'reconnecting';
type MediaSource = Track.Source.Microphone | Track.Source.ScreenShare;
const SCREEN_SHARE_PRESET = screenShareVideoPreset('standard');
const SPEAKER_REFRESH_INTERVAL_MS = 120;
const ENTRANCE_SOUND_RECEIVE_TIMEOUT_MS = 8_000;
const PROCESSING_RESTART_NOTICE = '部分音频处理设置需要重新开麦后生效。';
const PROCESSING_UNSUPPORTED_NOTICE = '当前麦克风设备不支持动态切换这项音频处理，请重新开麦后生效。';

interface RtcRoomEvents {
  participantJoined?(identity: string): void;
  participantLeft?(identity: string): void;
  participantEntrancePending?(identity: string): void;
  participantEntranceFailed?(identity: string): void;
  participantEntranceSound?(identity: string, bytes: Uint8Array): void;
  screenShareStarted?(): void;
  screenShareStopped?(): void;
  disconnected?(): void;
  selectNativeScreenSource?(
    capabilities: Promise<Record<string, { available: boolean; reason: string }>>,
  ): Promise<NativeScreenSourceSelection | null>;
}

interface NativeScreenSourceSelection { sourceId: string; shareAudio: boolean; quality?: ScreenShareQualityId }

interface ScreenShareResource {
  captureSessionId: string | null;
  sourceId: string;
  kind: 'monitor' | 'window';
  videoSession: NativeScreenVideoSession;
  videoTrack: LocalTrack;
  liveKitTrackId: string | null;
  remoteShare: RemoteControlShare | null;
  quality: ScreenShareQualityId;
}

interface PublicTrackRegistry {
  eligibleTracks: Set<LocalTrack>;
  publishedSids: Map<LocalTrack, string>;
}

interface RtcRoomOptions {
  screenShareQuality?: ScreenShareQualityId;
  inputGain: number;
  processing: AudioProcessingSettings;
  events?: RtcRoomEvents;
}

function preferredVideoCodec(): VideoCodec {
  try {
    // RTX 40 系列和新 Chromium 可协商 AV1；实际是否由硬件编码仍以诊断中的 encoderImplementation 为准。
    if (supportsAV1()) return 'av1';
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
    return codecs.some(({ mimeType }) => mimeType.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
  } catch {
    return 'vp8';
  }
}

function captureErrorMessage(error: unknown, source: MediaSource): string {
  const label = source === Track.Source.Microphone ? '麦克风' : '屏幕共享';
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return `${label}未获授权或已取消，请允许后重试。`;
    if (error.name === 'NotFoundError') return `未找到可用的${label}设备。`;
    if (error.name === 'NotReadableError') return `${label}无法采集，请检查系统权限或设备占用。`;
    if (source === Track.Source.Microphone && window.lycanDesktop) {
      if (error.message === 'audioDeviceUnavailable') return '默认麦克风不可用，请检查设备连接或 Windows 录音权限。';
      if (error.message === 'microphoneCaptureFormatUnsupported') return '当前麦克风音频格式暂不支持。';
      if (error.message === 'platformUnsupported') return '当前桌面系统不支持原生麦克风采集。';
      return '原生麦克风采集失败，请检查默认输入设备和 Windows 录音权限。';
    }
    if (source === Track.Source.ScreenShare) {
      const code = error.message.match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1];
      if (code === 'nativeVideoStopNotConfirmed') return '原生屏幕共享停止未确认，请重启客户端后再试。';
      if (code === 'captureSettingsUnsupported') return '当前 Windows 不支持所选屏幕共享设置，请关闭对应选项后重试。';
      if (code === 'captureBorderAccessDenied') return '未获准隐藏共享边框。请关闭该选项后重试；此功能需要 Windows 授权及安装包权限支持。';
      if (code) return `屏幕共享操作失败（${code}）。`;
    }
  }
  return `${label}操作失败，请检查设备、浏览器权限和 LiveKit 连接。`;
}

function reportNativeAudioCleanupFailure(error: unknown) {
  console.error('原生音频清理未完成', error);
}

/** 编排房间与媒体生命周期；桌面走原生采集，浏览器走 Chromium，不持久化凭证。 */
export function useRtcRoom(options?: RtcRoomOptions) {
  const revision = ref(0);
  const activeRoom = shallowRef<Room | null>(null);
  const pendingJoin = shallowRef<AbortController | null>(null);
  const pendingMedia = shallowRef(new Set<MediaSource>());
  const unpublishedTracks = shallowRef(new Set<LocalTrack>());
  const room = shallowRef<Room | null>(null);
  const status = ref<RoomStatus>('idle');
  const participants = shallowRef<Participant[]>([]);
  const notice = ref('');
  const needsAudioPlayback = ref(false);
  const busySources = ref<MediaSource[]>([]);
  const screenShareActive = ref(false);
  const screenShareSelectionCancelled = ref(false);
  const remoteAudioSubscriptions = new Map<string, boolean>();
  const publicTracksByRoom = new WeakMap<Room, PublicTrackRegistry>();
  let microphoneInputGain = normalizeAudioVolume(options?.inputGain ?? DEFAULT_AUDIO_PREFERENCES.inputGain);
  let microphoneProcessing: AudioProcessingSettings = options?.processing
    ? { ...options.processing }
    : {
        echoCancellation: DEFAULT_AUDIO_PREFERENCES.echoCancellation,
        noiseSuppression: DEFAULT_AUDIO_PREFERENCES.noiseSuppression,
        autoGainControl: DEFAULT_AUDIO_PREFERENCES.autoGainControl,
        voiceEnhancement: DEFAULT_AUDIO_PREFERENCES.voiceEnhancement,
      };
  let microphoneProcessor: MicrophoneAudioProcessor | null = null;
  let nativeMicrophoneSession: NativeMicrophoneAudioSession | null = null;
  let microphoneLoopback: MicrophoneLoopback | null = null;
  let microphoneLoopbackAttempt = 0;
  const microphoneLoopbackState = ref<'idle' | 'starting' | 'listening'>('idle');
  const microphoneLoopbackNotice = ref('');
  let speakerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let screenShareResource: ScreenShareResource | null = null;
  const currentScreenShareQuality = ref<ScreenShareQualityId>(options?.screenShareQuality ?? 'standard');
  const screenShareQualityBusy = ref(false);
  let nativeScreenAudioSession: NativeScreenAudioSession | null = null;
  const remoteControl = new RemoteControlSession({
    currentRoom: () => activeRoom.value,
    isCurrentRoom: (candidate) => activeRoom.value === candidate,
    currentShare: () => screenShareResource?.remoteShare ?? null,
    desktop: () => window.lycanDesktop,
    setNotice: (message) => { notice.value = message; },
  });

  function updateTrackSubscriptionPermissions(currentRoom: Room) {
    if (activeRoom.value !== currentRoom) return;
    const trackSids = [...(publicTracksByRoom.get(currentRoom)?.publishedSids.values() ?? [])];
    const permissions: ParticipantTrackPermission[] = [...currentRoom.remoteParticipants.keys()].map(
      (participantIdentity) => ({ participantIdentity, allowAll: false, allowedTrackSids: trackSids }),
    );
    currentRoom.localParticipant.setTrackSubscriptionPermissions(false, permissions);
  }

  function retirePublicTrack(currentRoom: Room, track: LocalTrack) {
    const publicTracks = publicTracksByRoom.get(currentRoom);
    if (!publicTracks) return;
    // 主动结束先撤销资格，SDK 的迟到发布事件就不能重新授予权限。
    publicTracks.eligibleTracks.delete(track);
    publicTracks.publishedSids.delete(track);
    updateTrackSubscriptionPermissions(currentRoom);
  }

  function stopMicrophoneLoopback() {
    microphoneLoopbackAttempt++;
    const loopback = microphoneLoopback;
    microphoneLoopback = null;
    microphoneLoopbackState.value = 'idle';
    loopback?.stop();
  }

  async function startMicrophoneLoopback(volume: number) {
    if (microphoneLoopback) return;
    const currentRoom = activeRoom.value;
    const publication = currentRoom?.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (currentRoom?.state !== ConnectionState.Connected || !publication?.track || publication.isMuted) {
      microphoneLoopbackNotice.value = '请先加入通话并开启麦克风。';
      return;
    }
    microphoneLoopbackNotice.value = '';
    const attempt = ++microphoneLoopbackAttempt;
    const loopback = new MicrophoneLoopback({
      onStopped: () => {
        if (microphoneLoopback !== loopback) return;
        microphoneLoopback = null;
        microphoneLoopbackState.value = 'idle';
      },
      onError: (error) => {
        if (microphoneLoopback === loopback) microphoneLoopbackNotice.value = error.message;
      },
    });
    microphoneLoopback = loopback;
    microphoneLoopbackState.value = 'starting';
    try {
      // 此 getter 包含浏览器处理器的输出，试听复用实际发布的处理后音轨。
      await loopback.start(publication.track.mediaStreamTrack, normalizeAudioVolume(volume),
        (currentRoom.options.publishDefaults?.audioPreset ?? AudioPresets.music).maxBitrate,
        currentRoom.options.publishDefaults?.dtx ?? true);
      if (microphoneLoopback === loopback) microphoneLoopbackState.value = 'listening';
    } catch (error) {
      if (attempt !== microphoneLoopbackAttempt) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      microphoneLoopbackNotice.value = error instanceof Error ? error.message : '麦克风试听失败，请重试。';
    }
  }

  function setMicrophoneLoopbackVolume(volume: number) {
    microphoneLoopback?.setVolume(normalizeAudioVolume(volume));
  }

  function clearSpeakerRefreshTimer() {
    if (speakerRefreshTimer !== null) clearTimeout(speakerRefreshTimer);
    speakerRefreshTimer = null;
  }

  onScopeDispose(() => {
    stopMicrophoneLoopback();
    pendingJoin.value?.abort();
    const currentRoom = activeRoom.value;
    if (currentRoom) {
      void remoteControl.cancelPending(undefined, undefined, currentRoom);
      void remoteControl.exitControl();
      void remoteControl.endShare(currentRoom, screenShareResource?.remoteShare ?? null);
    }
    activeRoom.value = null;
    const publicTracks = currentRoom ? publicTracksByRoom.get(currentRoom) : undefined;
    publicTracks?.eligibleTracks.clear();
    publicTracks?.publishedSids.clear();
    const shareResource = screenShareResource;
    screenShareResource = null;
    const nativeAudio = nativeScreenAudioSession;
    nativeScreenAudioSession = null;
    const nativeMicrophone = nativeMicrophoneSession;
    nativeMicrophoneSession = null;
    void nativeAudio?.stop().catch(reportNativeAudioCleanupFailure);
    void nativeMicrophone?.stop().catch(reportNativeAudioCleanupFailure);
    void shareResource?.videoSession.stop().then(() => {
      if (shareResource?.captureSessionId) remoteControl.completeNativeCleanup(shareResource.captureSessionId);
    }).catch(reportNativeAudioCleanupFailure);
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    clearSpeakerRefreshTimer();
    remoteControl.clearRoomState();
    void currentRoom?.disconnect();
  });

  async function join(groupId: string): Promise<boolean> {
    if (pendingJoin.value || activeRoom.value) return false;

    // 1. 先申请临时凭证；取消入房时中止请求，过期请求不能建立新连接。
    const request = new AbortController();
    pendingJoin.value = request;
    notice.value = '';
    status.value = 'joining';
    let joiningRoom: Room | null = null;
    try {
      const credential = await requestRtcToken(groupId, request.signal);
      if (request.signal.aborted) return false;

      // 2. 建立独立的 RTC 会话；连接本身不采集麦克风、摄像头或屏幕。
      // TODO: 根据异地实测调整共享画质，并记录连接类型、RTT、丢包和码率以排查代理影响。
      joiningRoom = markRaw(new Room({
        // 非可见画面仍由 SDK 暂停订阅，减少多路共享时的接收负担。
        adaptiveStream: true,
        dynacast: true,
        // 远端成员可在本机单独放大到 200%；统一由一个 AudioContext 混音，避免额外音频管线。
        webAudioMix: true,
        audioCaptureDefaults: {
          echoCancellation: microphoneProcessing.echoCancellation,
          noiseSuppression: microphoneProcessing.noiseSuppression,
          autoGainControl: microphoneProcessing.autoGainControl,
        },
        publishDefaults: {
          // 优先使用客户端可协商的 AV1，否则回退 H.264；实际硬件编码状态由媒体诊断确认。
          videoCodec: preferredVideoCodec(),
          // 游戏共享不应在同一连接的其他媒体竞争时被优先降级。
          screenShareEncoding: { ...SCREEN_SHARE_PRESET.encoding, priority: 'high' },
          // 双开实测多层 H.264 均由 OpenH264 软件编码；单层优先保留 1080p/60 观看画质。
          simulcast: false,
          // 网络受限时优先保留游戏画面尺寸，必要时降低帧率而不是立即变糊。
          degradationPreference: 'maintain-resolution',
        },
      }));
      const currentRoom = joiningRoom;
      activeRoom.value = currentRoom;
      room.value = currentRoom;
      publicTracksByRoom.set(currentRoom, { eligibleTracks: new Set(), publishedSids: new Map() });
      // SDK 在 EngineEvent.Connected / reconnect 时发送已保存的完整策略；先存入拒绝策略，避免发布前默认放行。
      currentRoom.localParticipant.setTrackSubscriptionPermissions(false, []);
      let remoteEventsEnabled = false;
      const receivedEntranceSounds = new Set<string>();
      currentRoom.on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        if (!remoteEventsEnabled || topic !== REMOTE_CONTROL_TOPIC || !sender?.identity
            || activeRoom.value !== currentRoom) return;
        remoteControl.handleData(currentRoom, sender.identity, payload,
          Boolean(currentRoom.remoteParticipants.get(sender.identity)?.getTrackPublication(Track.Source.ScreenShare)));
      });
      // 3. SDK 实例保持原样；事件更新数组与版本，驱动 Vue 重读成员和轨道状态。
      const applyRemoteAudioSubscription = (participant: RemoteParticipant) => {
        const subscribed = remoteAudioSubscriptions.get(participant.identity);
        const publication = participant.getTrackPublication(Track.Source.Microphone);
        if (subscribed !== undefined && publication && publication.isDesired !== subscribed) {
          publication.setSubscribed(subscribed);
        }
      };
      const refresh = () => {
        if (activeRoom.value !== currentRoom) return;
        revision.value++;
        participants.value = [currentRoom.localParticipant, ...currentRoom.remoteParticipants.values()];
        screenShareActive.value = Boolean(currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track);
        needsAudioPlayback.value = !currentRoom.canPlaybackAudio;
      };
      const scheduleSpeakerRefresh = () => {
        if (speakerRefreshTimer !== null) return;
        speakerRefreshTimer = setTimeout(() => {
          speakerRefreshTimer = null;
          refresh();
        }, SPEAKER_REFRESH_INTERVAL_MS);
      };
      [
        RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
        RoomEvent.ParticipantAttributesChanged,
        RoomEvent.AudioPlaybackStatusChanged,
      ].forEach((event) => currentRoom.on(event, refresh));
      currentRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        updateTrackSubscriptionPermissions(currentRoom);
        if (remoteEventsEnabled) options?.events?.participantJoined?.(participant.identity);
        if (remoteEventsEnabled) remoteControl.announceParticipant(currentRoom, participant.identity);
        refresh();
      });
      currentRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        receivedEntranceSounds.delete(participant.identity);
        updateTrackSubscriptionPermissions(currentRoom);
        remoteControl.participantDisconnected(currentRoom, participant.identity);
        if (remoteEventsEnabled) options?.events?.participantLeft?.(participant.identity);
        refresh();
      });
      currentRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
        applyRemoteAudioSubscription(participant);
        if (remoteEventsEnabled && publication.source === Track.Source.ScreenShare) {
          options?.events?.screenShareStarted?.();
        }
        refresh();
      });
      currentRoom.on(RoomEvent.LocalTrackPublished, (publication) => {
        const publicTracks = publicTracksByRoom.get(currentRoom);
        if (publication.track && publication.trackSid && publicTracks?.eligibleTracks.has(publication.track)
          && publicTracks.publishedSids.get(publication.track) !== publication.trackSid) {
          publicTracks.publishedSids.set(publication.track, publication.trackSid);
          updateTrackSubscriptionPermissions(currentRoom);
        }
        if (publication.source === Track.Source.ScreenShare) options?.events?.screenShareStarted?.();
        refresh();
      });
      currentRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare && participant) {
          remoteControl.trackUnpublished(currentRoom, participant.identity);
        }
        if (remoteEventsEnabled && publication.source === Track.Source.ScreenShare) {
          options?.events?.screenShareStopped?.();
        }
        refresh();
      });
      currentRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
        const publicTracks = publicTracksByRoom.get(currentRoom);
        if (publication.track && publicTracks?.publishedSids.get(publication.track) === publication.trackSid) {
          publicTracks.publishedSids.delete(publication.track);
          updateTrackSubscriptionPermissions(currentRoom);
        }
        if (publication.source === Track.Source.Microphone) stopMicrophoneLoopback();
        if (publication.source === Track.Source.ScreenShare) options?.events?.screenShareStopped?.();
        refresh();
      });
      currentRoom.registerByteStreamHandler(ENTRANCE_SOUND_TOPIC, async (reader, participantInfo) => {
        const identity = participantInfo.identity;
        if (!remoteEventsEnabled || receivedEntranceSounds.has(identity)
          || !isSupportedEntranceSoundType(reader.info.mimeType)
          || typeof reader.info.size !== 'number' || reader.info.size <= 0
          || reader.info.size > ENTRANCE_SOUND_MAX_BYTES) return;
        receivedEntranceSounds.add(identity);
        options?.events?.participantEntrancePending?.(identity);
        try {
          const chunks: Uint8Array[] = [];
          let receivedBytes = 0;
          for await (const chunk of reader.withAbortSignal(AbortSignal.timeout(ENTRANCE_SOUND_RECEIVE_TIMEOUT_MS))) {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > ENTRANCE_SOUND_MAX_BYTES) throw new Error('entrance sound exceeds limit');
            chunks.push(chunk);
          }
          if (receivedBytes <= 0) {
            options?.events?.participantEntranceFailed?.(identity);
            return;
          }
          const bytes = new Uint8Array(receivedBytes);
          let offset = 0;
          chunks.forEach((chunk) => {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          });
          if (activeRoom.value === currentRoom && currentRoom.remoteParticipants.has(identity)) {
            options?.events?.participantEntranceSound?.(identity, bytes);
          }
        } catch {
          options?.events?.participantEntranceFailed?.(identity);
        }
      });
      // 发言状态变化可能很频繁，节流只影响 UI 指示，不影响音频传输。
      currentRoom.on(RoomEvent.ActiveSpeakersChanged, scheduleSpeakerRefresh);
      currentRoom.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
        if (activeRoom.value !== currentRoom) return;
        if (connectionState === ConnectionState.Connected) status.value = 'connected';
        else if (connectionState === ConnectionState.Reconnecting
          || connectionState === ConnectionState.SignalReconnecting) {
          stopMicrophoneLoopback();
          status.value = 'reconnecting';
          remoteControl.connectionReconnecting(currentRoom);
        }
        refresh();
      });
      currentRoom.on(RoomEvent.Disconnected, (reason) => {
        if (activeRoom.value !== currentRoom) return;
        options?.events?.disconnected?.();
        leave();
        notice.value = reason === DisconnectReason.DUPLICATE_IDENTITY
          ? '语音已在另一台设备连接。' : '已与房间断开连接，请确认 LiveKit 正常运行后重新加入。';
      });

      // 4. 凭证只用于连接 LiveKit，不写入本地存储，也不通过日志输出。
      await currentRoom.connect(credential.serverUrl, credential.token);
      if (request.signal.aborted || activeRoom.value !== currentRoom) {
        await currentRoom.disconnect();
        return false;
      }
      currentRoom.remoteParticipants.forEach(applyRemoteAudioSubscription);
      updateTrackSubscriptionPermissions(currentRoom);
      refresh();
      status.value = 'connected';
      remoteEventsEnabled = true;
      remoteControl.queryParticipants(currentRoom);

      // 5. 明确加入语音后默认开麦；权限失败只保持关麦，不退出已经建立的语音会话。
      await setMediaEnabled(Track.Source.Microphone, true);
      if (request.signal.aborted || activeRoom.value !== currentRoom) return false;
      await updateListeningState(true);
      if (request.signal.aborted || activeRoom.value !== currentRoom) return false;
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      if (activeRoom.value === joiningRoom) leave();
      status.value = 'idle';
      notice.value = error instanceof TokenRequestError ? error.message
        : '连接失败，请确认后端和 LiveKit 已启动，并检查本机端口及网络。';
      return false;
    } finally {
      if (pendingJoin.value === request) pendingJoin.value = null;
    }
  }

  async function leave(): Promise<void> {
    stopMicrophoneLoopback();
    // 先使旧会话失效，再停止发布与连接，防止迟到的事件覆盖下一次入房状态。
    pendingJoin.value?.abort();
    pendingJoin.value = null;
    // 先替换操作集合，使正在等待选择器或采集的任务立即进入旧会话清理路径。
    pendingMedia.value = new Set([Track.Source.Microphone, Track.Source.ScreenShare]);
    const currentRoom = activeRoom.value;
    if (currentRoom) {
      void remoteControl.cancelPending(undefined, undefined, currentRoom);
      void remoteControl.exitControl();
      await remoteControl.endShare(currentRoom, screenShareResource?.remoteShare ?? null);
    }
    activeRoom.value = null;
    const publicTracks = currentRoom ? publicTracksByRoom.get(currentRoom) : undefined;
    publicTracks?.eligibleTracks.clear();
    publicTracks?.publishedSids.clear();
    const shareResource = screenShareResource;
    screenShareResource = null;
    const nativeAudio = nativeScreenAudioSession;
    nativeScreenAudioSession = null;
    const nativeMicrophone = nativeMicrophoneSession;
    nativeMicrophoneSession = null;
    const nativeStop = Promise.all([
      nativeAudio?.stop().catch(reportNativeAudioCleanupFailure),
      shareResource?.videoSession.stop().then(() => {
        if (shareResource.captureSessionId) remoteControl.completeNativeCleanup(shareResource.captureSessionId);
      }).catch(reportNativeAudioCleanupFailure),
      nativeMicrophone?.stop().catch(reportNativeAudioCleanupFailure),
    ]);
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    clearSpeakerRefreshTimer();
    remoteControl.clearRoomState();
    pendingMedia.value = new Set();
    busySources.value = [];
    screenShareActive.value = false;
    screenShareSelectionCancelled.value = false;
    microphoneProcessor = null;
    room.value = null;
    participants.value = [];
    status.value = 'idle';
    needsAudioPlayback.value = false;
    notice.value = '';
    // 桌面关窗需等待离房信令发送完毕；本地状态和采集已在上方立即清理。
    await nativeStop;
    await (currentRoom?.disconnect() ?? Promise.resolve());
  }

  async function setMediaEnabled(source: MediaSource, enabled: boolean) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || currentRoom.state !== ConnectionState.Connected
      || pendingMedia.value.has(source)) return;
    const operations = pendingMedia.value;
    operations.add(source);
    const isCurrentTask = () => activeRoom.value === currentRoom && pendingMedia.value === operations;
    const microphoneProcessorAtStart = source === Track.Source.Microphone ? microphoneProcessor : null;
    busySources.value = [...operations];
    notice.value = '';
    if (source === Track.Source.ScreenShare && enabled) screenShareSelectionCancelled.value = false;
    let capturedTracks: LocalTrack[] = [];
    let selectedQuality = options?.screenShareQuality ?? 'standard';
    let sharePreset = screenShareVideoPreset(selectedQuality);
    let microphoneProcessorForTask: MicrophoneAudioProcessor | null = null;
    let nativeVideo: NativeScreenVideoSession | null = null;
    let shareResource: ScreenShareResource | null = null;
    let nativeAudio: NativeScreenAudioSession | null = null;
    let nativeMicrophone: NativeMicrophoneAudioSession | null = null;
    let nativeSourceId: string | null = null;
    let published = false;
    let nativeVideoStopFailed = false;
    const publicTracks = publicTracksByRoom.get(currentRoom);
    try {
      // 1. 关闭时取消发布并释放设备，而不是仅把采集中的音频静音。
      const participant = currentRoom.localParticipant;
      const existingTrack = participant.getTrackPublication(source)?.track;
      if (!enabled) {
        if (source === Track.Source.Microphone) stopMicrophoneLoopback();
        if (source === Track.Source.ScreenShare) {
          shareResource = screenShareResource;
          nativeVideo = shareResource?.videoSession ?? null;
          nativeAudio = nativeScreenAudioSession;
          const videoTrack = shareResource?.videoTrack ?? existingTrack;
          const shareAudioTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
          if (videoTrack) retirePublicTrack(currentRoom, videoTrack);
          if (shareAudioTrack) retirePublicTrack(currentRoom, shareAudioTrack);
          if (screenShareResource === shareResource) screenShareResource = null;
          if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
          const nativeStop = nativeVideo?.stop();
          await remoteControl.endShare(currentRoom, shareResource?.remoteShare ?? null);
          let videoStopFailed = false;
          let videoStopError: unknown;
          let audioStopFailed = false;
          let audioStopError: unknown;
          try {
            await Promise.all([
              videoTrack ? participant.unpublishTrack(videoTrack, true) : Promise.resolve(),
              shareAudioTrack ? participant.unpublishTrack(shareAudioTrack, true) : Promise.resolve(),
            ]);
          } finally {
            try {
              await nativeStop;
            } catch (error) {
              nativeVideoStopFailed = true;
              videoStopFailed = true;
              videoStopError = error;
              if (isCurrentTask() && shareResource && !screenShareResource) screenShareResource = shareResource;
            }
            try {
              await nativeAudio?.stop();
            } catch (error) {
              audioStopFailed = true;
              audioStopError = error;
              reportNativeAudioCleanupFailure(error);
              if (isCurrentTask() && nativeAudio && !nativeScreenAudioSession) {
                nativeScreenAudioSession = nativeAudio;
              }
            }
            if (!videoStopFailed && shareResource?.captureSessionId) {
              remoteControl.completeNativeCleanup(shareResource.captureSessionId);
            }
            if (videoStopFailed) throw videoStopError;
            if (audioStopFailed) throw audioStopError;
          }
        } else if (existingTrack) {
          retirePublicTrack(currentRoom, existingTrack);
          nativeMicrophone = nativeMicrophoneSession;
          if (nativeMicrophoneSession === nativeMicrophone) nativeMicrophoneSession = null;
          if (microphoneProcessor === microphoneProcessorAtStart) microphoneProcessor = null;
          try {
            await participant.unpublishTrack(existingTrack, true);
          } finally {
            await nativeMicrophone?.stop();
            nativeMicrophone = null;
          }
        }
        if (source === Track.Source.Microphone && microphoneProcessor === microphoneProcessorAtStart) {
          microphoneProcessor = null;
        }
        return;
      }
      if (existingTrack) return;
      if (source === Track.Source.ScreenShare && screenShareResource) {
        throw new Error('nativeVideoStopNotConfirmed');
      }

      // 2. 用户点击后才请求采集；浏览器路径保留原有无共享声音行为。
      if (source === Track.Source.Microphone) {
        const desktop = window.lycanDesktop;
        if (desktop) {
          const nativeSettings: NativeMicrophoneSettings = {
            inputGain: microphoneInputGain,
            noiseSuppression: microphoneProcessing.noiseSuppression,
            autoGainControl: microphoneProcessing.autoGainControl,
            voiceEnhancement: microphoneProcessing.voiceEnhancement,
          };
          nativeMicrophone = new NativeMicrophoneAudioSession(desktop, {
            onError: (code) => {
              if (nativeMicrophoneSession !== nativeMicrophone || activeRoom.value !== currentRoom) return;
              nativeMicrophoneSession = null;
              stopMicrophoneLoopback();
              const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
              if (publication?.track) {
                retirePublicTrack(currentRoom, publication.track);
                void currentRoom.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
              }
              const reason = code === 'audioDeviceUnavailable'
                ? '默认麦克风已断开或切换'
                : code === 'microphoneCaptureFormatUnsupported'
                  ? '当前麦克风格式暂不支持'
                  : '原生麦克风采集连接已中断';
              notice.value = `麦克风已停止：${reason}。`;
              revision.value++;
            },
          });
          nativeMicrophoneSession = nativeMicrophone;
          capturedTracks = [await nativeMicrophone.start(crypto.randomUUID(), nativeSettings)];
          if (!isCurrentTask()) return;
        } else {
          const processor = new MicrophoneAudioProcessor(microphoneInputGain, microphoneProcessing.voiceEnhancement);
          capturedTracks = await participant.createTracks({
            audio: {
              echoCancellation: microphoneProcessing.echoCancellation,
              noiseSuppression: microphoneProcessing.noiseSuppression,
              autoGainControl: microphoneProcessing.autoGainControl,
            },
            video: false,
          });
          if (!isCurrentTask()) return;
          const audioTrack = capturedTracks.find((track): track is LocalAudioTrack => track instanceof LocalAudioTrack);
          if (!audioTrack) throw new Error('麦克风采集未返回音频轨道');
          // LocalParticipant.createTracks 返回后才会给轨道注入房间的 AudioContext，此时接入处理器才可靠。
          await audioTrack.setProcessor(processor);
          if (!isCurrentTask()) return;
          processor.setInputGain(microphoneInputGain);
          processor.setVoiceEnhancement(microphoneProcessing.voiceEnhancement);
          microphoneProcessorForTask = processor;
          microphoneProcessor = processor;
        }
      } else {
        const desktop = window.lycanDesktop;
        if (desktop) {
          const selectSource = options?.events?.selectNativeScreenSource;
          const capabilitiesPromise = desktop.getNativeMediaCapabilities();
          if (!selectSource) {
            const capabilities = await capabilitiesPromise;
            if (!isCurrentTask()) return;
            if (!capabilities.videoCapture?.available) {
              throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
            }
            throw new Error('nativeSourceSelectionUnavailable');
          }
          const selectionPromise = selectSource(capabilitiesPromise);
          const selection = await selectionPromise;
          if (!isCurrentTask() || screenShareSelectionCancelled.value || !selection) return;
          const capabilities = await capabilitiesPromise;
          if (!isCurrentTask() || screenShareSelectionCancelled.value) return;
          if (!capabilities.videoCapture?.available) {
            throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
          }
          const { sourceId } = selection;
          selectedQuality = selection.quality ?? selectedQuality;
          sharePreset = screenShareVideoPreset(selectedQuality);
          nativeSourceId = sourceId;
          const kind = sourceId.startsWith('monitor:') ? 'monitor' : 'window';
          nativeVideo = new NativeScreenVideoSession(desktop, {
            maxFps: screenShareQuality(selectedQuality).fps,
            resolution: { width: screenShareQuality(selectedQuality).width, height: screenShareQuality(selectedQuality).height },
            contentHint: selectedQuality === 'text' ? 'detail' : 'motion',
            onError: (code) => {
              const failedShareResource = shareResource;
              const failedVideoSession = nativeVideo;
              if (!failedShareResource || !failedVideoSession || screenShareResource !== failedShareResource
                  || activeRoom.value !== currentRoom) return;
              void remoteControl.endShare(currentRoom, failedShareResource.remoteShare);
              if (code !== 'captureTargetClosed') notice.value = `原生屏幕共享已停止（${code}）。`;
              retirePublicTrack(currentRoom, failedShareResource.videoTrack);
              void currentRoom.localParticipant.unpublishTrack(failedShareResource.videoTrack, true).catch(() => {});
              const screenAudioTrack = currentRoom.localParticipant
                .getTrackPublication(Track.Source.ScreenShareAudio)?.track;
              if (screenAudioTrack) {
                retirePublicTrack(currentRoom, screenAudioTrack);
                void currentRoom.localParticipant.unpublishTrack(screenAudioTrack, true).catch(() => {});
              }
              nativeAudio = nativeScreenAudioSession;
              nativeScreenAudioSession = null;
              void nativeAudio?.stop().catch(reportNativeAudioCleanupFailure);
              void failedVideoSession.stop().then(() => {
                if (screenShareResource === failedShareResource) screenShareResource = null;
                if (failedShareResource.captureSessionId) {
                  remoteControl.completeNativeCleanup(failedShareResource.captureSessionId);
                }
              }).catch((error) => {
                reportNativeAudioCleanupFailure(error);
                if (activeRoom.value === currentRoom && screenShareResource === failedShareResource) {
                  notice.value = '原生屏幕共享停止未确认，请重启客户端后再试。';
                }
              });
              revision.value++;
            },
          });
          shareResource = { captureSessionId: null, sourceId, kind, videoSession: nativeVideo,
            videoTrack: nativeVideo.track, liveKitTrackId: null, remoteShare: null, quality: selectedQuality };
          screenShareResource = shareResource;
          capturedTracks = [await nativeVideo.start(sourceId)];
          shareResource.captureSessionId = nativeVideo.captureSessionId ?? null;
          if (!isCurrentTask()) return;
          if (selection.shareAudio) {
            const audioMode = nativeScreenAudioMode(capabilities.screenShareAudioCapture);
            if (audioMode !== 'unavailable') {
              nativeAudio = new NativeScreenAudioSession(desktop, {
                onError: (code) => {
                  if (nativeScreenAudioSession !== nativeAudio || activeRoom.value !== currentRoom) return;
                  nativeScreenAudioSession = null;
                  let reason = '声音采集连接已中断';
                  if (code === 'screenShareAudioTargetUnavailable') {
                    if (audioMode === 'systemMix') {
                      reason = '默认播放设备已断开或切换';
                    } else if (sourceId.startsWith('window:')) {
                      reason = '所选应用已关闭或声音目标不可用';
                    } else {
                      reason = '共享声音目标不可用';
                    }
                  } else if (code === 'screenShareAudioFormatUnsupported') {
                    reason = '当前系统音频格式暂不支持';
                  } else if (audioMode === 'systemMix') {
                    reason = '默认播放设备已断开或声音采集失败';
                  }
                  notice.value = `共享声音已停止，画面仍在共享（${reason}）。`;
                  const publication = currentRoom.localParticipant
                    .getTrackPublication(Track.Source.ScreenShareAudio);
                  if (publication?.track) {
                    retirePublicTrack(currentRoom, publication.track);
                    void currentRoom.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
                  }
                  revision.value++;
                },
              });
              nativeScreenAudioSession = nativeAudio;
              try {
                const videoSessionId = nativeVideo.captureSessionId;
                if (!videoSessionId) throw new Error('nativeVideoSessionUnavailable');
                const audioTrack = await nativeAudio.start(sourceId, videoSessionId);
                if (!isCurrentTask()) return;
                capturedTracks.push(audioTrack);
              } catch (error) {
                if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
                await nativeAudio.stop().catch(reportNativeAudioCleanupFailure);
                nativeAudio = null;
                if (!isCurrentTask()) return;
                const code = error instanceof Error ? error.message : '';
                let reason = 'Windows 音频捕获启动失败';
                if (/screenShareAudioUnsupported/.test(code)) {
                  reason = '当前 Windows 版本不支持屏幕共享声音捕获';
                } else if (/screenShareAudioTargetUnavailable/.test(code) && audioMode === 'systemMix') {
                  reason = '默认播放设备不可用或已切换';
                } else if (/screenShareAudioTargetUnavailable/.test(code) && sourceId.startsWith('window:')) {
                  reason = '无法确认所选应用的声音来源或应用已关闭';
                } else if (/screenShareAudioFormatUnsupported/.test(code)) {
                  reason = '当前系统音频格式暂不支持';
                }
                notice.value = `仅共享画面：${reason}。`;
              }
            } else {
              if (isCurrentTask()) notice.value = '仅共享画面：当前 Windows 版本不支持屏幕共享声音捕获。';
            }
          }
        } else {
          // 仅浏览器使用 Chromium 采集；Electron 原生失败不会回退到此路径。
          capturedTracks = await participant.createScreenTracks({
            audio: false,
            contentHint: selectedQuality === 'text' ? 'detail' : 'motion',
            resolution: sharePreset.resolution,
          });
          if (!isCurrentTask()) return;
        }
      }
      // 3. 采集期间可能已经离房或取消选择；失效任务不能再发布。
      if (!isCurrentTask() || (source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) return;
      capturedTracks.forEach((track) => unpublishedTracks.value.add(track));
      // 只有普通媒体发送流程采集的轨道有资格进入公开白名单。
      capturedTracks.forEach((track) => publicTracks?.eligibleTracks.add(track));
      const publishResults = await Promise.allSettled(capturedTracks.map((track) => {
        if (nativeMicrophone && track === nativeMicrophone.track) {
          return participant.publishTrack(track, { source: Track.Source.Microphone });
        }
        if (track.source === Track.Source.ScreenShare || (nativeVideo && track === nativeVideo.track)) {
          return participant.publishTrack(track, {
            source: Track.Source.ScreenShare,
            videoEncoding: { ...sharePreset.encoding, priority: 'high' },
          });
        }
        if (nativeAudio && track === nativeAudio.track) {
          return participant.publishTrack(track, { source: Track.Source.ScreenShareAudio });
        }
        return participant.publishTrack(track);
      }));
      const failedPublish = publishResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failedPublish) throw failedPublish.reason;
      published = true;
      if (!isCurrentTask()) return;
      if (source === Track.Source.ScreenShare) currentScreenShareQuality.value = selectedQuality;
      publishResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.track
          && publicTracks?.eligibleTracks.has(result.value.track)
          && typeof result.value.trackSid === 'string' && result.value.trackSid) {
          publicTracks.publishedSids.set(result.value.track, result.value.trackSid);
        }
      });
      updateTrackSubscriptionPermissions(currentRoom);
      if (nativeVideo && nativeSourceId && nativeVideo.captureSessionId) {
        const videoTrackIndex = capturedTracks.findIndex((track) => track === nativeVideo?.track);
        const videoPublishResult = publishResults[videoTrackIndex];
        const publication = videoPublishResult?.status === 'fulfilled' ? videoPublishResult.value : null;
        if (shareResource && screenShareResource === shareResource) {
          shareResource.captureSessionId = nativeVideo.captureSessionId;
          shareResource.liveKitTrackId = publication?.trackSid ?? null;
          // 当前协议把 shareSessionId 映射为采集会话值，代码仍分别记录共享标识和采集标识。
          shareResource.remoteShare = {
            shareId: nativeVideo.captureSessionId,
            captureSessionId: nativeVideo.captureSessionId,
            sourceId: nativeSourceId,
            kind: shareResource.kind,
            liveKitTrackId: shareResource.liveKitTrackId,
          };
          remoteControl.beginShare(currentRoom, shareResource.remoteShare);
        }
      }
    } catch (error) {
      // 自定义选择器的取消会被 Chromium 以拒绝采集返回；这是正常结束，不能误报为权限或连接故障。
      const targetClosed = source === Track.Source.ScreenShare && error instanceof Error
        && /(?:^|: )captureTargetClosed$/.test(error.message);
      if (isCurrentTask() && !targetClosed
        && !(source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) {
        notice.value = enabled ? captureErrorMessage(error, source)
          : nativeVideoStopFailed
            ? '原生屏幕共享停止未确认，请重启客户端后再试。'
            : `${source === Track.Source.Microphone ? '麦克风' : '屏幕共享'}停止未确认，请重新连接语音。`;
      }
    } finally {
      // 4. 失败或旧房间的轨道只由本任务所属房间清理，避免碰到新房间的发布。
      const releaseTracks = !published || !isCurrentTask();
      const releasedTracks = new Set<LocalTrack>();
      if (releaseTracks && capturedTracks.length) {
        capturedTracks.forEach((track) => retirePublicTrack(currentRoom, track));
        const participant = currentRoom.localParticipant;
        const publications = [...participant.trackPublications.values()]
          .filter((publication) => publication.track && capturedTracks.includes(publication.track));
        await Promise.all(publications.map(async (publication) => {
          const track = publication.track;
          if (!track) return;
          try {
            await participant.unpublishTrack(track, true);
            releasedTracks.add(track);
          } catch (error) {
            reportNativeAudioCleanupFailure(error);
          }
        }));
      }
      capturedTracks.forEach((track) => {
        unpublishedTracks.value.delete(track);
        if (releaseTracks && !releasedTracks.has(track)) {
          try {
            track.stop();
          } catch (error) {
            reportNativeAudioCleanupFailure(error);
          }
        }
      });
      if (nativeVideo && releaseTracks) {
        try {
          await nativeVideo.stop();
          if (screenShareResource === shareResource) screenShareResource = null;
        } catch (error) {
          reportNativeAudioCleanupFailure(error);
        }
      }
      if (nativeAudio && releaseTracks) {
        if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
        await nativeAudio.stop().catch(reportNativeAudioCleanupFailure);
      }
      if (source === Track.Source.Microphone && releaseTracks) {
        const processorToRelease = microphoneProcessorForTask ?? microphoneProcessorAtStart;
        if (processorToRelease && microphoneProcessor === processorToRelease) microphoneProcessor = null;
        if (nativeMicrophone) {
          if (nativeMicrophoneSession === nativeMicrophone) nativeMicrophoneSession = null;
          await nativeMicrophone.stop().catch(reportNativeAudioCleanupFailure);
        }
      }
      if (releaseTracks) updateTrackSubscriptionPermissions(currentRoom);
      operations.delete(source);
      if (source === Track.Source.ScreenShare && isCurrentTask()) screenShareSelectionCancelled.value = false;
      if (isCurrentTask()) busySources.value = [...operations];
    }
  }

  async function enableAudioPlayback() {
    const currentRoom = activeRoom.value;
    if (!currentRoom) return;
    try {
      await currentRoom.startAudio();
    } catch {
      if (activeRoom.value === currentRoom) notice.value = '浏览器未允许播放声音，请再次点击“允许播放声音”。';
    }
  }

  async function updateListeningState(listening: boolean) {
    const currentRoom = activeRoom.value;
    if (!currentRoom) return;
    try {
      // 收听开关属于公开房内状态，具体音量始终只保留在本机。
      await currentRoom.localParticipant.setAttributes({ 'lycansync.listening': String(listening) });
    } catch {
      if (activeRoom.value === currentRoom) notice.value = '收听状态未能同步给其他成员，请稍后重试。';
    }
  }

  function setMicrophoneInputGain(value: number) {
    microphoneInputGain = normalizeAudioVolume(value);
    microphoneProcessor?.setInputGain(microphoneInputGain);
    const requestRoom = activeRoom.value;
    const requestSession = nativeMicrophoneSession;
    if (requestSession) {
      void requestSession.configure({
        inputGain: microphoneInputGain,
        noiseSuppression: microphoneProcessing.noiseSuppression,
        autoGainControl: microphoneProcessing.autoGainControl,
        voiceEnhancement: microphoneProcessing.voiceEnhancement,
      }).catch(() => {
        if (requestRoom && activeRoom.value === requestRoom && nativeMicrophoneSession === requestSession) {
          notice.value = '麦克风设置未能应用。';
        }
      });
    }
  }

  async function setMicrophoneProcessing(settings: AudioProcessingSettings) {
    microphoneProcessing = { ...settings };
    microphoneProcessor?.setVoiceEnhancement(settings.voiceEnhancement);
    const requestRoom = activeRoom.value;
    const requestSession = nativeMicrophoneSession;
    if (requestSession) {
      try {
        await requestSession.configure({
          inputGain: microphoneInputGain,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          voiceEnhancement: settings.voiceEnhancement,
        });
      } catch {
        if (requestRoom && activeRoom.value === requestRoom && nativeMicrophoneSession === requestSession) {
          notice.value = '麦克风设置未能应用。';
        }
      }
      return;
    }
    const trackRoom = requestRoom;
    const track = trackRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    const mediaTrack = track.mediaStreamTrack;
    const isCurrentTrack = () => activeRoom.value === trackRoom
      && trackRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track === track
      && track.mediaStreamTrack === mediaTrack;
    if (notice.value === PROCESSING_RESTART_NOTICE || notice.value === PROCESSING_UNSUPPORTED_NOTICE) notice.value = '';
    try {
      await track.applyConstraints({
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      });
      if (isCurrentTrack()
        && unappliedCaptureProcessing(settings, mediaTrack.getSettings()).length > 0) {
        notice.value = PROCESSING_RESTART_NOTICE;
      }
    } catch {
      if (isCurrentTrack()) notice.value = PROCESSING_UNSUPPORTED_NOTICE;
    }
  }

  async function sendEntranceSound(file: File) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || currentRoom.state !== ConnectionState.Connected
      || !isSupportedEntranceSoundType(file.type) || file.size <= 0 || file.size > ENTRANCE_SOUND_MAX_BYTES) return false;
    const destinationIdentities = [...currentRoom.remoteParticipants.keys()];
    if (!destinationIdentities.length) return true;
    try {
      await currentRoom.localParticipant.sendFile(file, {
        topic: ENTRANCE_SOUND_TOPIC,
        mimeType: file.type,
        destinationIdentities,
        compress: false,
      });
      return activeRoom.value === currentRoom;
    } catch {
      if (activeRoom.value === currentRoom) notice.value = '自定义入场音未能发送，其他成员仍会听到默认提示音。';
      return false;
    }
  }

  function setRemoteAudioSubscribed(identity: string, subscribed: boolean) {
    remoteAudioSubscriptions.set(identity, subscribed);
    const publication = activeRoom.value?.remoteParticipants.get(identity)
      ?.getTrackPublication(Track.Source.Microphone);
    if (publication && publication.isDesired !== subscribed) publication.setSubscribed(subscribed);
  }

  async function toggleMedia(source: MediaSource) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || currentRoom.state !== ConnectionState.Connected) return;
    const enabled = Boolean(currentRoom.localParticipant.getTrackPublication(source)?.track);
    await setMediaEnabled(source, !enabled);
  }

  async function setScreenShareQuality(quality: ScreenShareQualityId): Promise<boolean> {
    const currentRoom = activeRoom.value;
    const resource = screenShareResource;
    if (!currentRoom || !resource || screenShareQualityBusy.value || resource.quality === quality
        || currentRoom.state !== ConnectionState.Connected
        || currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track !== resource.videoTrack) return false;
    screenShareQualityBusy.value = true;
    try {
      await resource.videoSession.configureQuality(quality);
      if (activeRoom.value !== currentRoom || screenShareResource !== resource) return false;
      resource.quality = quality;
      currentScreenShareQuality.value = quality;
      return true;
    } catch (error) {
      if (activeRoom.value === currentRoom && screenShareResource === resource) {
        notice.value = error instanceof Error && error.message === 'nativeVideoConfigurationRollbackFailed'
          ? '画质恢复失败，屏幕共享已停止，请重新开始共享。'
          : '画质未能切换，已保留原画质。';
      }
      return false;
    } finally {
      screenShareQualityBusy.value = false;
    }
  }

  function cancelPendingScreenShareSelection() {
    if (pendingMedia.value.has(Track.Source.ScreenShare)) screenShareSelectionCancelled.value = true;
  }

  return { revision, room, status, participants, notice, needsAudioPlayback, busySources, screenShareActive,
    currentScreenShareQuality, screenShareQualityBusy, setScreenShareQuality,
    remoteControlRequest: remoteControl.request, remoteControlOwner: remoteControl.owner,
    remoteControlShares: remoteControl.shares, remoteControlActive: remoteControl.active,
    remoteControlPending: remoteControl.pending, remoteControlGranting: remoteControl.granting,
    microphoneLoopbackState, microphoneLoopbackNotice, startMicrophoneLoopback, stopMicrophoneLoopback,
    setMicrophoneLoopbackVolume,
    join, leave, toggleMedia, setMediaEnabled, enableAudioPlayback, updateListeningState,
    setMicrophoneInputGain, setMicrophoneProcessing, setRemoteAudioSubscribed, sendEntranceSound,
    requestRemoteControl: (identity: string) => remoteControl.requestControl(identity),
    sendRemoteControlInput: (input: RemoteControlInput) => remoteControl.sendInput(input),
    exitRemoteControl: () => remoteControl.exitControl(),
    revokeRemoteControl: () => remoteControl.revokeOwner(),
    retryRemoteControlCleanup: () => remoteControl.retryCleanup(),
    remoteControlCleanupPending: remoteControl.cleanupPending,
    allowRemoteControl: () => remoteControl.allow(), rejectRemoteControl: () => remoteControl.reject(),
    cancelPendingRemoteControl: (identity?: string, shareId?: string) => remoteControl.cancelPending(identity, shareId),
    cancelPendingScreenShareSelection };
}

import { computed, markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import {
  ConnectionState, DisconnectReason, LocalAudioTrack, Room, RoomEvent, Track,
  type LocalTrack, type Participant, type RemoteParticipant,
  type ParticipantTrackPermission,
} from 'livekit-client';
import { requestRtcToken, TokenRequestError } from './tokenApi';
import { DEFAULT_AUDIO_PREFERENCES, normalizeAudioVolume, unappliedCaptureProcessing,
  type AudioProcessingSettings } from './audioPreferences';
import { ENTRANCE_SOUND_MAX_BYTES, ENTRANCE_SOUND_TOPIC, isSupportedEntranceSoundType } from './entranceSound';
import { MicrophoneAudioProcessor } from './microphoneAudioProcessor';
import { NativeScreenVideoSession } from './nativeScreenVideo';
import type { ScreenSharePreferences } from '../settings/screenSharePreferences';
import { NativeScreenAudioSession } from './nativeScreenAudio';
import { NativeMicrophoneAudioSession, type NativeMicrophoneSettings } from './nativeMicrophoneAudio';
import { nativeScreenAudioMode, type NativeScreenAudioMode } from './nativeScreenAudioMode';
import { REMOTE_CONTROL_TOPIC, type RemoteControlInput } from './remoteControl';
import { RemoteControlSession, type RemoteControlShare } from './remoteControlSession';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, validateCustomScreenShareQuality, screenShareDegradationPreference, screenShareQuality, screenShareThumbnailPreset, screenShareVideoPreset, type CustomScreenShareQuality, type ScreenShareQualityId } from './screenShareQuality';
import { syncScreenShareViewing } from './screenShareViewing';

type RoomStatus = 'idle' | 'joining' | 'connected' | 'reconnecting';
type MediaSource = Track.Source.Microphone | Track.Source.ScreenShare;
const SCREEN_SHARE_PRESET = screenShareVideoPreset('standard');
const SPEAKER_REFRESH_INTERVAL_MS = 120;
const ENTRANCE_SOUND_RECEIVE_TIMEOUT_MS = 8_000;
const PROCESSING_RESTART_NOTICE = '部分音频处理设置需要重新开麦后生效。';
const PROCESSING_UNSUPPORTED_NOTICE = '当前麦克风设备不支持动态切换这项音频处理，请重新开麦后生效。';
const MICROPHONE_STOP_NOTICE = '麦克风停止未确认，已禁止发送，请重启客户端后再开麦。';

interface RtcRoomEvents {
  beforeMicrophoneChange?(): Promise<void>;
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

interface NativeScreenSourceSelection { sourceId: string; shareAudio: boolean; quality?: ScreenShareQualityId;
  customQuality?: CustomScreenShareQuality; captureSettings?: ScreenSharePreferences; controllerIdentity?: string; controlTemporary?: boolean }

interface ScreenShareResource {
  captureSessionId: string | null;
  sourceId: string;
  kind: 'monitor' | 'window';
  videoSession: NativeScreenVideoSession;
  videoTrack: LocalTrack;
  liveKitTrackId: string | null;
  remoteShare: RemoteControlShare | null;
  quality: ScreenShareQualityId;
  customQuality: CustomScreenShareQuality;
  captureSettings?: ScreenSharePreferences;
  audioMode: NativeScreenAudioMode;
  audioChanging: boolean;
  stopping: boolean;
  controllerIdentity?: string;
  controlTemporary?: boolean;
}

interface RoomTrackRegistry {
  eligibleTracks: Set<LocalTrack>;
  publishedSids: Map<LocalTrack, string>;
  controllers: Map<LocalTrack, string>;
}

interface RtcRoomOptions {
  screenShareQuality?: ScreenShareQualityId;
  customScreenShareQuality?: CustomScreenShareQuality;
  inputGain: number;
  processing: AudioProcessingSettings;
  events?: RtcRoomEvents;
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
      if (code === 'nativeVideoFirstFrameTimeout') return '共享画面未能及时送达，已结束本次共享，请重新选择后重试。';
      if (code === 'dxgiMonitorUnavailable') return '所选显示器暂不支持无边框共享，请确认显示器连接后重试。';
      if (code === 'dxgiAdapterMismatch') return '显示器与采集显卡未能匹配，已停止本次共享，请重新选择显示器后重试。';
      if (code === 'captureSettingsUnsupported') return '当前系统不支持所选采集方式或设置，请在高级选项中改用自动或兼容采集后重试。';
      if (code === 'captureBorderAccessDenied') return '系统窗口采集未获准隐藏边框，请改用兼容采集，或在高级选项中允许此次显示系统边框。';
      if (code === 'obsWindowBindingUnavailable' || code === 'obsWindowTargetMismatch') {
        return '所选窗口身份未能确认，共享已停止。请重新选择窗口后重试。';
      }
      if (code && ['sharedTextureGpuWaitFailed', 'sharedTextureGpuStalled', 'sharedTextureReleaseFailed', 'sharedTextureAcquireFailed'].includes(code)) {
        return '显卡处理共享画面失败，本次共享已停止。请重新选择来源后重试。';
      }
      if (code && ['obsWindowCaptureStartFailed', 'obsWindowRuntimeUnavailable', 'obsWindowSourceUnavailable'].includes(code)) {
        return '窗口采集未能启动，请在高级选项中更换采集方式后重试；所选方式可能不兼容此应用。';
      }
      if (code === 'obsCaptureGameDetectionFailed') return '无法确认所选程序的共享方式，请重新选择窗口后重试。';
      if (code === 'obsGameBindingUnavailable') return '游戏采集组件版本不匹配，请重新构建或更新客户端。';
      if (code === 'obsGameTargetMismatch') return '游戏绘制窗口与所选窗口不符，已停止共享，请重新选择。';
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
  const playbackContext = shallowRef<AudioContext | null>(null);
  const status = ref<RoomStatus>('idle');
  const participants = shallowRef<Participant[]>([]);
  const notice = ref('');
  const needsAudioPlayback = ref(false);
  const busySources = ref<MediaSource[]>([]);
  const listening = ref(true);
  const microphoneIntent = ref(false);
  const microphoneEnabled = ref(false);
  const microphoneTracks = new Map<LocalTrack, MediaStreamTrack>();
  const microphoneMutes = new WeakMap<LocalTrack, Promise<LocalTrack>>();
  let microphoneVersion = 0;
  let microphoneTask: { room: Room; promise: Promise<void> } | null = null;
  let listeningTask: { room: Room; promise: Promise<void> } | null = null;
  let microphoneCleanupFailed = false;
  const screenShareActive = ref(false);
  const screenShareSelectionCancelled = ref(false);
  const remoteAudioSubscriptions = new Map<string, boolean>();
  const tracksByRoom = new WeakMap<Room, RoomTrackRegistry>();
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
  let speakerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let screenShareResource: ScreenShareResource | null = null;
  let screenShareIntentVersion = 0;
  const currentScreenShareQuality = ref<ScreenShareQualityId>(options?.screenShareQuality ?? 'standard');
  const currentCustomScreenShareQuality = ref<CustomScreenShareQuality>({ ...(options?.customScreenShareQuality ?? DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY) });
  const screenShareQualityBusy = ref(false);
  const screenShareSourceBusy = ref(false);
  const currentScreenShareAudioMode = computed(() => {
    void revision.value;
    return screenShareResource?.audioMode ?? 'unavailable';
  });
  const screenShareAudioRestricted = computed(() => {
    void revision.value;
    return Boolean(screenShareResource?.controlTemporary);
  });
  let nativeScreenAudioSession: NativeScreenAudioSession | null = null;
  const remoteControl = new RemoteControlSession({
    currentRoom: () => activeRoom.value,
    isCurrentRoom: (candidate) => activeRoom.value === candidate && status.value === 'connected',
    currentShare: () => screenShareResource?.remoteShare ?? null,
    desktop: () => window.lycanDesktop,
    suspendController: async (currentRoom, current) => {
      if (!current()) throw new Error('remoteControlCancelled');
      const resume = await suspendShareForControl(currentRoom);
      return () => resume();
    },
    prepareTarget: prepareRemoteControlShare,
    setNotice: (message) => { notice.value = message; },
  });

  function updateTrackSubscriptionPermissions(currentRoom: Room) {
    if (activeRoom.value !== currentRoom) return;
    const registry = tracksByRoom.get(currentRoom);
    const permissions: ParticipantTrackPermission[] = [...currentRoom.remoteParticipants.keys()].map(
      (participantIdentity) => ({ participantIdentity, allowAll: false,
        allowedTrackSids: [...(registry?.publishedSids.entries() ?? [])]
          .filter(([track]) => !registry?.controllers.has(track) || registry.controllers.get(track) === participantIdentity)
          .map(([, sid]) => sid) }),
    );
    currentRoom.localParticipant.setTrackSubscriptionPermissions(false, permissions);
  }

  function retireRoomTrack(currentRoom: Room, track: LocalTrack) {
    const roomTracks = tracksByRoom.get(currentRoom);
    if (!roomTracks) return;
    // 主动结束先撤销资格，SDK 的迟到发布事件就不能重新授予权限。
    roomTracks.eligibleTracks.delete(track);
    roomTracks.controllers.delete(track);
    roomTracks.publishedSids.delete(track);
    updateTrackSubscriptionPermissions(currentRoom);
  }

  function disableMicrophoneTrack(track: LocalTrack) {
    // 直接关闭采集输出与 sender 当前音轨；不能等待 SDK 静音锁或取消发布。
    track.mediaStreamTrack.enabled = false;
    const sourceTrack = microphoneTracks.get(track);
    if (sourceTrack) sourceTrack.enabled = false;
    if (track.sender?.track) track.sender.track.enabled = false;
  }

  function forbidMicrophone() {
    microphoneEnabled.value = false;
    const currentRoom = activeRoom.value;
    microphoneTracks.forEach((_source, track) => {
      disableMicrophoneTrack(track);
      if (currentRoom) retireRoomTrack(currentRoom, track);
    });
    const track = currentRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const nativeTrack = nativeMicrophoneSession?.track;
    if (nativeTrack) disableMicrophoneTrack(nativeTrack);
    if (track && currentRoom) {
      disableMicrophoneTrack(track);
      retireRoomTrack(currentRoom, track);
      // 同步禁发后再通知 SDK 静音，防止重连将仍挂在发布列表中的轨道自动重启。
      if (!microphoneMutes.has(track)) {
        const muted = track.mute();
        microphoneMutes.set(track, muted);
        void muted.catch((error) => {
          microphoneCleanupFailed = true;
          reportNativeAudioCleanupFailure(error);
          if (activeRoom.value === currentRoom) {
            notice.value = MICROPHONE_STOP_NOTICE;
          }
        });
      }
    }
    // 原生会话自己等待迟到启动并回收；停止采集不等待试听或发布请求。
    void nativeMicrophoneSession?.stop().catch((error) => {
      microphoneCleanupFailed = true;
      reportNativeAudioCleanupFailure(error);
      if (activeRoom.value === currentRoom) {
        notice.value = MICROPHONE_STOP_NOTICE;
      }
    });
  }

  function synchronizeMicrophone(): Promise<void> {
    const currentRoom = activeRoom.value;
    if (!currentRoom) return Promise.resolve();
    if (microphoneTask?.room === currentRoom) return microphoneTask.promise;
    const task = { room: currentRoom, promise: Promise.resolve() };
    microphoneTask = task;
    task.promise = (async () => {
      let appliedVersion: number;
      do {
        appliedVersion = microphoneVersion;
        const enabled = listening.value && microphoneIntent.value && status.value === 'connected';
        if (enabled && microphoneCleanupFailed) {
          notice.value = MICROPHONE_STOP_NOTICE;
          return;
        }
        await applyMediaEnabled(Track.Source.Microphone, enabled);
      } while (activeRoom.value === currentRoom && appliedVersion !== microphoneVersion);
    })().finally(() => { if (microphoneTask === task) microphoneTask = null; });
    return task.promise;
  }

  function clearSpeakerRefreshTimer() {
    if (speakerRefreshTimer !== null) clearTimeout(speakerRefreshTimer);
    speakerRefreshTimer = null;
  }

  onScopeDispose(() => {
    microphoneVersion++;
    microphoneIntent.value = false;
    forbidMicrophone();
    pendingJoin.value?.abort();
    const currentRoom = activeRoom.value;
    if (currentRoom) {
      void remoteControl.cancelPending(undefined, currentRoom);
      void remoteControl.exitControl();
      void remoteControl.endShare(currentRoom, screenShareResource?.remoteShare ?? null);
    }
    activeRoom.value = null;
    const roomTracks = currentRoom ? tracksByRoom.get(currentRoom) : undefined;
    roomTracks?.eligibleTracks.clear();
    roomTracks?.publishedSids.clear();
    roomTracks?.controllers.clear();
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
    microphoneTracks.clear();
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
    let unassignedPlaybackContext: AudioContext | null = null;
    try {
      // 本机测试可独占原生麦克风；确认释放后才进入新的房间生命周期。
      if (options?.events?.beforeMicrophoneChange) {
        try { await options.events.beforeMicrophoneChange(); }
        catch {
          if (request.signal.aborted) return false;
          status.value = 'idle';
          notice.value = '麦克风试听停止未确认，请重启客户端后再连接语音。';
          return false;
        }
      }
      if (request.signal.aborted) return false;
      const credential = await requestRtcToken(groupId, request.signal);
      if (request.signal.aborted) return false;

      // 2. 建立独立的 RTC 会话；连接本身不采集麦克风、摄像头或屏幕。
      // TODO: 根据异地实测调整共享画质，并记录连接类型、RTT、丢包和码率以排查代理影响。
      unassignedPlaybackContext = new AudioContext();
      joiningRoom = markRaw(new Room({
        // 小预览与独立观看按可见用途合并需求，不因观看路数自动限制主画面质量。
        adaptiveStream: false,
        dynacast: true,
        // 房间只用一个混音上下文；由本模块释放，供成员人声平衡节点复用。
        webAudioMix: { audioContext: unassignedPlaybackContext },
        audioCaptureDefaults: {
          echoCancellation: microphoneProcessing.echoCancellation,
          noiseSuppression: microphoneProcessing.noiseSuppression,
          autoGainControl: microphoneProcessing.autoGainControl,
        },
        publishDefaults: {
          // 屏幕统一使用 H.264 双层，实际编码器及高帧率表现由设备验收确认。
          videoCodec: 'h264',
          // 游戏共享不应在同一连接的其他媒体竞争时被优先降级。
          screenShareEncoding: { ...SCREEN_SHARE_PRESET.encoding, priority: 'high' },
          simulcast: true,
          screenShareSimulcastLayers: [screenShareThumbnailPreset()],
        },
      }));
      const currentRoom = joiningRoom;
      playbackContext.value = markRaw(unassignedPlaybackContext);
      unassignedPlaybackContext = null;
      activeRoom.value = currentRoom;
      room.value = currentRoom;
      tracksByRoom.set(currentRoom, { eligibleTracks: new Set(), publishedSids: new Map(), controllers: new Map() });
      // SDK 在 EngineEvent.Connected / reconnect 时发送已保存的完整策略；先存入拒绝策略，避免发布前默认放行。
      currentRoom.localParticipant.setTrackSubscriptionPermissions(false, []);
      let remoteEventsEnabled = false;
      const receivedEntranceSounds = new Set<string>();
      currentRoom.on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        if (!remoteEventsEnabled || topic !== REMOTE_CONTROL_TOPIC || !sender?.identity
            || activeRoom.value !== currentRoom) return;
        remoteControl.handleData(currentRoom, sender.identity, payload);
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
        const microphone = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
        if (microphoneEnabled.value && microphone?.isMuted) forbidMicrophone();
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
      currentRoom.on(RoomEvent.TrackSubscribed, (_track, publication) => {
        if (activeRoom.value === currentRoom && publication.source === Track.Source.ScreenShare) {
          syncScreenShareViewing(publication);
        }
      });
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
        if (publication.source === Track.Source.Microphone && publication.track
          && !microphoneEnabled.value) {
          disableMicrophoneTrack(publication.track);
          if (!listening.value || !microphoneIntent.value || status.value === 'reconnecting') {
            retireRoomTrack(currentRoom, publication.track);
          }
        }
        const roomTracks = tracksByRoom.get(currentRoom);
        if (publication.track && publication.trackSid && roomTracks?.eligibleTracks.has(publication.track)
          && roomTracks.publishedSids.get(publication.track) !== publication.trackSid) {
          roomTracks.publishedSids.set(publication.track, publication.trackSid);
          updateTrackSubscriptionPermissions(currentRoom);
        }
        if (publication.source === Track.Source.ScreenShare) options?.events?.screenShareStarted?.();
        refresh();
      });
      currentRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare && participant) {
          remoteControl.trackUnpublished(currentRoom, participant.identity, publication.trackSid);
        }
        if (remoteEventsEnabled && publication.source === Track.Source.ScreenShare) {
          options?.events?.screenShareStopped?.();
        }
        refresh();
      });
      currentRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
        const roomTracks = tracksByRoom.get(currentRoom);
        if (publication.track && roomTracks?.publishedSids.get(publication.track) === publication.trackSid) {
          roomTracks.publishedSids.delete(publication.track);
          updateTrackSubscriptionPermissions(currentRoom);
        }
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
        if (connectionState === ConnectionState.Connected) {
          const reconnected = status.value === 'reconnecting';
          status.value = 'connected';
          if (reconnected) {
            updateTrackSubscriptionPermissions(currentRoom);
            remoteControl.queryParticipants(currentRoom);
          }
        }
        else if (connectionState === ConnectionState.Reconnecting
          || connectionState === ConnectionState.SignalReconnecting) {
          status.value = 'reconnecting';
          screenShareIntentVersion++;
          remoteControl.connectionReconnecting(currentRoom);
        }
        refresh();
      });
      currentRoom.on(RoomEvent.Disconnected, (reason) => {
        if (activeRoom.value !== currentRoom) return;
        options?.events?.disconnected?.();
        leave();
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
          notice.value = '语音已在另一台设备连接。';
        } else if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          notice.value = '你已离开或被移出群聊，语音、共享和远控已结束。';
        } else {
          notice.value = '已与房间断开连接，请确认 LiveKit 正常运行后重新加入。';
        }
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
      listening.value = true;
      await setMediaEnabled(Track.Source.Microphone, true);
      if (request.signal.aborted || activeRoom.value !== currentRoom) return false;
      await synchronizeListeningAttribute(currentRoom);
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
      if (unassignedPlaybackContext) {
        await unassignedPlaybackContext.close().catch((error) => console.error('房间音频上下文关闭失败', error));
      }
      if (pendingJoin.value === request) pendingJoin.value = null;
    }
  }

  async function leave(): Promise<void> {
    microphoneVersion++;
    microphoneIntent.value = false;
    forbidMicrophone();
    // 先使旧会话失效，再停止发布与连接，防止迟到的事件覆盖下一次入房状态。
    pendingJoin.value?.abort();
    pendingJoin.value = null;
    // 先替换操作集合，使正在等待选择器或采集的任务立即进入旧会话清理路径。
    pendingMedia.value = new Set([Track.Source.Microphone, Track.Source.ScreenShare]);
    const currentRoom = activeRoom.value;
    if (currentRoom) {
      void remoteControl.cancelPending(undefined, currentRoom);
      void remoteControl.exitControl();
      await remoteControl.endShare(currentRoom, screenShareResource?.remoteShare ?? null);
    }
    activeRoom.value = null;
    const currentPlaybackContext = playbackContext.value;
    playbackContext.value = null;
    const roomTracks = currentRoom ? tracksByRoom.get(currentRoom) : undefined;
    roomTracks?.eligibleTracks.clear();
    roomTracks?.publishedSids.clear();
    roomTracks?.controllers.clear();
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
    microphoneTracks.clear();
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
    try {
      await nativeStop;
      await (currentRoom?.disconnect() ?? Promise.resolve());
    } finally {
      await currentPlaybackContext?.close().catch((error) => console.error('房间音频上下文关闭失败', error));
    }
  }

  function createScreenShareAudioSession(currentRoom: Room, resource: ScreenShareResource,
    desktop: NonNullable<Window['lycanDesktop']>) {
    const session = new NativeScreenAudioSession(desktop, {
      onError: (code) => {
        if (nativeScreenAudioSession !== session || activeRoom.value !== currentRoom) return;
        nativeScreenAudioSession = null;
        let reason = '声音采集连接已中断';
        if (code === 'screenShareAudioTargetUnavailable') {
          reason = resource.audioMode === 'systemMix' ? '默认播放设备已断开或切换'
            : resource.kind === 'window' ? '所选应用已关闭或声音目标不可用' : '共享声音目标不可用';
        } else if (code === 'screenShareAudioFormatUnsupported') {
          reason = '当前系统音频格式暂不支持';
        } else if (resource.audioMode === 'systemMix') {
          reason = '默认播放设备已断开或声音采集失败';
        }
        notice.value = `共享声音已停止，画面仍在共享（${reason}）。`;
        const track = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
        if (track) {
          retireRoomTrack(currentRoom, track);
          void currentRoom.localParticipant.unpublishTrack(track, true).catch(reportNativeAudioCleanupFailure);
        }
        revision.value++;
      },
    });
    return session;
  }

  async function suspendShareForControl(currentRoom: Room) {
    if (activeRoom.value !== currentRoom || currentRoom.state !== ConnectionState.Connected
        || pendingMedia.value.has(Track.Source.ScreenShare) || screenShareSourceBusy.value || screenShareQualityBusy.value
        || screenShareResource?.audioChanging) throw new Error('screenShareBusy');
    const version = screenShareIntentVersion;
    const resource = screenShareResource;
    const snapshot: NativeScreenSourceSelection | null = resource ? {
      sourceId: resource.sourceId, quality: resource.quality, customQuality: { ...resource.customQuality },
      shareAudio: Boolean(nativeScreenAudioSession?.track),
      ...(resource.captureSettings ? { captureSettings: { ...resource.captureSettings } } : {}),
    } : null;
    if (!resource && currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track) {
      throw new Error('screenShareCannotRestoreSource');
    }
    if (resource) await applyMediaEnabled(Track.Source.ScreenShare, false);
    if (screenShareResource || nativeScreenAudioSession) throw new Error('nativeVideoStopNotConfirmed');
    // 快照只属于本机本次操作；新意愿、离房和失效来源都不允许自动恢复。
    return async (replacement?: ScreenShareResource | null) => {
      if (activeRoom.value !== currentRoom) return;
      if (replacement && screenShareResource === replacement && !pendingMedia.value.has(Track.Source.ScreenShare)) {
        await applyMediaEnabled(Track.Source.ScreenShare, false);
        if (screenShareResource === replacement) throw new Error('nativeVideoStopNotConfirmed');
      }
      if (!snapshot || version !== screenShareIntentVersion || status.value !== 'connected'
          || currentRoom.state !== ConnectionState.Connected || screenShareResource
          || pendingMedia.value.has(Track.Source.ScreenShare)) return;
      const sources = await window.lycanDesktop!.listNativeVideoSources();
      if (activeRoom.value !== currentRoom || version !== screenShareIntentVersion || screenShareResource
          || status.value !== 'connected' || currentRoom.state !== ConnectionState.Connected) return;
      if (!sources.sources.some(source => source.sourceId === snapshot.sourceId)) throw new Error('videoSourceExpired');
      await applyMediaEnabled(Track.Source.ScreenShare, true, snapshot);
      if (activeRoom.value !== currentRoom) return;
      const restored = screenShareResource as ScreenShareResource | null;
      if (!restored && (version !== screenShareIntentVersion || status.value !== 'connected')) return;
      if (!restored || restored.stopping || restored.sourceId !== snapshot.sourceId) throw new Error('screenShareRestoreFailed');
    };
  }

  async function prepareRemoteControlShare(currentRoom: Room, identity: string, sourceId: string,
    publicVideo: boolean, current: () => boolean, signal: AbortSignal) {
    const desktop = window.lycanDesktop;
    if (!desktop || !current() || !sourceId.startsWith('monitor:')) throw new Error('invalidRemoteControlSource');
    const sources = await desktop.listNativeVideoSources();
    if (!current() || !sources.sources.some(source => source.sourceId === sourceId && source.kind === 'monitor')) {
      throw new Error('videoSourceExpired');
    }
    const existing = screenShareResource;
    const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    // 只有范围未变的普通公开整屏能沿用；私密必须先结束旧公开发布，建立新的默认拒绝 SID。
    if (publicVideo && existing?.kind === 'monitor' && existing.sourceId === sourceId
        && !existing.controllerIdentity && existing.remoteShare && !existing.stopping
        && publication?.track === existing.videoTrack && publication.trackSid) {
      if (existing.remoteShare.liveKitTrackId !== publication.trackSid) {
        existing.remoteShare = { ...existing.remoteShare, liveKitTrackId: publication.trackSid };
      }
      return { share: existing.remoteShare, restore: async () => {} };
    }
    const resume = await suspendShareForControl(currentRoom);
    let replacement: ScreenShareResource | null = null;
    try {
      if (!current()) throw new Error('remoteControlCancelled');
      await applyMediaEnabled(Track.Source.ScreenShare, true, { sourceId, shareAudio: false, quality: 'standard',
        controllerIdentity: publicVideo ? undefined : identity, controlTemporary: true }, signal);
      replacement = screenShareResource;
      if (!current() || !replacement?.remoteShare || replacement.kind !== 'monitor') throw new Error('remoteControlShareFailed');
      return { share: replacement.remoteShare, restore: () => resume(replacement) };
    } catch (error) {
      try { await resume(replacement); }
      catch (restoreError) { throw new Error('remoteControlShareRestoreFailed', { cause: restoreError }); }
      throw error;
    }
  }

  function setMediaEnabled(source: MediaSource, enabled: boolean, selectedSource?: NativeScreenSourceSelection): Promise<void> {
    if (source !== Track.Source.Microphone) {
      if (enabled && (remoteControl.granting.value || remoteControl.cleanupPending.value || remoteControl.restoring.value)) {
        notice.value = '远程控制正在准备或清理，请先结束当前操作。';
        return Promise.resolve();
      }
      if (enabled && pendingMedia.value.has(Track.Source.ScreenShare)) return Promise.resolve();
      const version = ++screenShareIntentVersion;
      const currentRoom = activeRoom.value;
      if (!enabled && pendingMedia.value.has(Track.Source.ScreenShare)) cancelPendingScreenShareSelection();
      if (enabled && (remoteControl.active.value || remoteControl.pending.value?.phase === 'preparing')) {
        const finish = remoteControl.active.value ? remoteControl.exitControl() : remoteControl.cancelPending();
        return finish.then(() => {
          if (activeRoom.value === currentRoom && version === screenShareIntentVersion && status.value === 'connected') {
            return applyMediaEnabled(source, true, selectedSource);
          }
        });
      }
      return applyMediaEnabled(source, enabled, selectedSource);
    }
    if (!activeRoom.value || (enabled && status.value !== 'connected')) return Promise.resolve();
    if (enabled && microphoneEnabled.value && listening.value) return Promise.resolve();
    if (microphoneTask?.room === activeRoom.value && microphoneIntent.value === enabled
      && (!enabled || listening.value)) return microphoneTask.promise;
    // 意愿只由明确的开关麦动作改变，停止收听不会覆盖它。
    microphoneIntent.value = enabled;
    microphoneVersion++;
    if (!enabled) forbidMicrophone();
    else if (!listening.value) return updateListeningState(true);
    return synchronizeMicrophone();
  }

  async function applyMediaEnabled(source: MediaSource, enabled: boolean, selectedSource?: NativeScreenSourceSelection,
    captureSignal?: AbortSignal) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || (currentRoom.state !== ConnectionState.Connected && enabled)
      || pendingMedia.value.has(source)) return;
    const operations = pendingMedia.value;
    operations.add(source);
    const version = microphoneVersion;
    const shareVersion = screenShareIntentVersion;
    const isCurrentTask = () => activeRoom.value === currentRoom && pendingMedia.value === operations
      && (source !== Track.Source.Microphone || !enabled || version === microphoneVersion)
      && (source !== Track.Source.ScreenShare || !enabled || (!screenShareSelectionCancelled.value
        && shareVersion === screenShareIntentVersion && !captureSignal?.aborted));
    const microphoneProcessorAtStart = source === Track.Source.Microphone ? microphoneProcessor : null;
    busySources.value = [...operations];
    notice.value = '';
    if (source === Track.Source.ScreenShare && enabled) screenShareSelectionCancelled.value = false;
    let capturedTracks: LocalTrack[] = [];
    let selectedQuality = options?.screenShareQuality ?? 'standard';
    let selectedCustomQuality = validateCustomScreenShareQuality(currentCustomScreenShareQuality.value);
    let sharePreset = screenShareVideoPreset(selectedQuality, selectedCustomQuality);
    let microphoneProcessorForTask: MicrophoneAudioProcessor | null = null;
    let nativeVideo: NativeScreenVideoSession | null = null;
    let shareResource: ScreenShareResource | null = null;
    let nativeAudio: NativeScreenAudioSession | null = null;
    let nativeMicrophone: NativeMicrophoneAudioSession | null = null;
    let nativeSourceId: string | null = null;
    let shareAudioRequested = false;
    let videoStartupStartedAt = 0;
    let published = false;
    let nativeVideoStopFailed = false;
    const roomTracks = tracksByRoom.get(currentRoom);
    const cancelCapture = () => {
      // 发布结果可能仍在等待 SDK，取消时先撤销本任务的视频资格，迟到 SID 不能得到权限。
      if (activeRoom.value === currentRoom && shareResource && screenShareResource === shareResource) {
        shareResource.stopping = true;
        retireRoomTrack(currentRoom, shareResource.videoTrack);
      }
    };
    captureSignal?.addEventListener('abort', cancelCapture, { once: true });
    try {
      if (source === Track.Source.Microphone && options?.events?.beforeMicrophoneChange) {
        try { await options.events.beforeMicrophoneChange(); }
        catch {
          if (isCurrentTask()) notice.value = '麦克风试听停止未确认，请重启客户端后再操作麦克风。';
          // 可选试听的清理失败不能阻止用户关麦；只拦住新采集。
          if (enabled || !isCurrentTask()) return;
        }
        if (!isCurrentTask()) return;
      }
      // 1. 关闭时取消发布并释放设备，而不是仅把采集中的音频静音。
      const participant = currentRoom.localParticipant;
      const existingTrack = participant.getTrackPublication(source)?.track;
      if (!enabled) {
        if (source === Track.Source.ScreenShare) {
          shareResource = screenShareResource;
          nativeVideo = shareResource?.videoSession ?? null;
          nativeAudio = nativeScreenAudioSession;
          if (shareResource) shareResource.stopping = true;
          const videoTrack = shareResource?.videoTrack ?? existingTrack;
          const shareAudioTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
          if (videoTrack) retireRoomTrack(currentRoom, videoTrack);
          if (shareAudioTrack) retireRoomTrack(currentRoom, shareAudioTrack);
          // 声音可能已交给 SDK 但尚未返回发布结果，也必须先撤销其公开资格。
          if (nativeAudio?.track && nativeAudio.track !== shareAudioTrack) retireRoomTrack(currentRoom, nativeAudio.track);
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
          disableMicrophoneTrack(existingTrack);
          retireRoomTrack(currentRoom, existingTrack);
          nativeMicrophone = nativeMicrophoneSession;
          if (nativeMicrophoneSession === nativeMicrophone) nativeMicrophoneSession = null;
          if (microphoneProcessor === microphoneProcessorAtStart) microphoneProcessor = null;
          // 采集停止不依赖取消发布的网络进度；每项释放都尝试并保留真实失败。
          const stops = await Promise.allSettled([
            microphoneMutes.get(existingTrack),
            participant.unpublishTrack(existingTrack, true),
            Promise.resolve().then(() => existingTrack.stop()),
            nativeMicrophone?.stop(),
          ]);
          nativeMicrophone = null;
          microphoneTracks.delete(existingTrack);
          const failures = stops.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '麦克风清理未完成');
        }
        if (source === Track.Source.Microphone && microphoneProcessor === microphoneProcessorAtStart) {
          microphoneProcessor = null;
        }
        return;
      }
      if (existingTrack) {
        if (source === Track.Source.Microphone) published = true;
        return;
      }
      if (source === Track.Source.ScreenShare && (screenShareResource || nativeScreenAudioSession)) {
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
              microphoneVersion++;
              forbidMicrophone();
              // 原生中断同样走房间的关麦清理，不留下另一条吞错的取消发布路径。
              void applyMediaEnabled(Track.Source.Microphone, false);
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
          capturedTracks.forEach((track) => {
            microphoneTracks.set(track, track.mediaStreamTrack);
            disableMicrophoneTrack(track);
          });
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
          capturedTracks.forEach((track) => {
            microphoneTracks.set(track, track.mediaStreamTrack);
            disableMicrophoneTrack(track);
          });
          if (!isCurrentTask()) return;
          const audioTrack = capturedTracks.find((track): track is LocalAudioTrack => track instanceof LocalAudioTrack);
          if (!audioTrack) throw new Error('麦克风采集未返回音频轨道');
          // LocalParticipant.createTracks 返回后才会给轨道注入房间的 AudioContext，此时接入处理器才可靠。
          await audioTrack.setProcessor(processor);
          disableMicrophoneTrack(audioTrack);
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
          if (!selectedSource && !selectSource) {
            const capabilities = await capabilitiesPromise;
            if (!isCurrentTask()) return;
            if (!capabilities.videoCapture?.available) {
              throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
            }
            throw new Error('nativeSourceSelectionUnavailable');
          }
          const selection = selectedSource ?? await selectSource!(capabilitiesPromise);
          if (!isCurrentTask() || screenShareSelectionCancelled.value || !selection) return;
          const capabilities = await capabilitiesPromise;
          if (!isCurrentTask() || screenShareSelectionCancelled.value) return;
          if (!capabilities.videoCapture?.available) {
            throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
          }
          const { sourceId } = selection;
          selectedQuality = selection.quality ?? selectedQuality;
          selectedCustomQuality = validateCustomScreenShareQuality(selection.customQuality ?? selectedCustomQuality);
          sharePreset = screenShareVideoPreset(selectedQuality, selectedCustomQuality);
          const selectedProfile = screenShareQuality(selectedQuality, selectedCustomQuality);
          nativeSourceId = sourceId;
          const kind = sourceId.startsWith('monitor:') ? 'monitor' : 'window';
          nativeVideo = new NativeScreenVideoSession(desktop, {
            maxFps: selectedProfile.fps,
            captureSettings: selection.captureSettings,
            resolution: { width: selectedProfile.width, height: selectedProfile.height },
            contentHint: 'motion',
            isCurrentCapture: () => activeRoom.value === currentRoom && screenShareResource === shareResource
              && shareResource != null && !shareResource.stopping,
            canReduceFrameRate: () => status.value === 'connected'
              && currentRoom.state === ConnectionState.Connected
              && shareResource?.liveKitTrackId != null && !remoteControl.owner.value && !remoteControl.granting.value
              && currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track === nativeVideo?.track,
            onFrameRateAdjustmentFailure: (frameRate) => {
              if (activeRoom.value === currentRoom && screenShareResource === shareResource && !shareResource?.stopping) {
                notice.value = `共享帧率自动调整失败，采集目标仍为 ${frameRate} FPS。请重新选择画质后重试。`;
              }
            },
            onError: (code) => {
              const failedShareResource = shareResource;
              const failedVideoSession = nativeVideo;
              if (!failedShareResource || !failedVideoSession || screenShareResource !== failedShareResource
                  || activeRoom.value !== currentRoom) return;
              failedShareResource.stopping = true;
              void remoteControl.endShare(currentRoom, failedShareResource.remoteShare);
              if (code !== 'captureTargetClosed') notice.value = `原生屏幕共享已停止（${code}）。`;
              retireRoomTrack(currentRoom, failedShareResource.videoTrack);
              void currentRoom.localParticipant.unpublishTrack(failedShareResource.videoTrack, true).catch(() => {});
              const screenAudioTrack = currentRoom.localParticipant
                .getTrackPublication(Track.Source.ScreenShareAudio)?.track ?? nativeScreenAudioSession?.track;
              if (screenAudioTrack) {
                retireRoomTrack(currentRoom, screenAudioTrack);
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
            captureSettings: selection.captureSettings ? { ...selection.captureSettings } : undefined,
            videoTrack: nativeVideo.track, liveKitTrackId: null, remoteShare: null, quality: selectedQuality, customQuality: selectedCustomQuality,
            audioMode: nativeScreenAudioMode(capabilities.screenShareAudioCapture), audioChanging: false, stopping: false,
            controllerIdentity: selection.controllerIdentity, controlTemporary: selection.controlTemporary };
          screenShareResource = shareResource;
          videoStartupStartedAt = performance.now();
          capturedTracks = [await nativeVideo.start(sourceId)];
          shareResource.captureSessionId = nativeVideo.captureSessionId ?? null;
          if (!isCurrentTask()) return;
          shareAudioRequested = selection.shareAudio;
        } else {
          // 仅浏览器使用 Chromium 采集；Electron 原生失败不会回退到此路径。
          capturedTracks = await participant.createScreenTracks({
            audio: false,
            contentHint: 'motion',
            resolution: sharePreset.resolution,
          });
          if (!isCurrentTask()) return;
        }
      }
      // 3. 采集期间可能已经离房或取消选择；失效任务不能再发布。
      if (!isCurrentTask() || (source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) return;
      capturedTracks.forEach((track) => unpublishedTracks.value.add(track));
      // 发布前登记范围，新 SID 默认拒绝；私密画面不能短暂进入全房间白名单。
      capturedTracks.forEach((track) => {
        if (source === Track.Source.ScreenShare && selectedSource?.controllerIdentity) {
          roomTracks?.controllers.set(track, selectedSource.controllerIdentity);
        }
        roomTracks?.eligibleTracks.add(track);
      });
      const publishResults = await Promise.allSettled(capturedTracks.map((track) => {
        if (nativeMicrophone && track === nativeMicrophone.track) {
          return participant.publishTrack(track, { source: Track.Source.Microphone });
        }
        if (track.source === Track.Source.ScreenShare || (nativeVideo && track === nativeVideo.track)) {
          return participant.publishTrack(track, {
            source: Track.Source.ScreenShare,
            screenShareEncoding: { ...sharePreset.encoding, priority: 'high' },
            videoCodec: 'h264', simulcast: true,
            screenShareSimulcastLayers: [screenShareThumbnailPreset()],
            // 降级偏好只作用于本次共享，不改变房间其他视频的策略。
            degradationPreference: screenShareDegradationPreference(selectedQuality),
          });
        }
        return participant.publishTrack(track);
      }));
      const failedPublish = publishResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failedPublish) throw failedPublish.reason;
      published = true;
      if (!isCurrentTask()) return;
      if (source === Track.Source.Microphone) {
        // 发布成功且任务仍属于当前意愿，才开放原始输入、处理输出和 sender。
        capturedTracks.forEach((track) => {
          microphoneTracks.get(track)!.enabled = true;
          track.mediaStreamTrack.enabled = true;
          if (track.sender?.track) track.sender.track.enabled = true;
        });
        microphoneEnabled.value = true;
      }
      if (source === Track.Source.ScreenShare) {
        currentScreenShareQuality.value = selectedQuality;
        currentCustomScreenShareQuality.value = selectedCustomQuality;
      }
      publishResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.track
          && roomTracks?.eligibleTracks.has(result.value.track)
          && typeof result.value.trackSid === 'string' && result.value.trackSid) {
          roomTracks.publishedSids.set(result.value.track, result.value.trackSid);
        }
      });
      updateTrackSubscriptionPermissions(currentRoom);
      if (nativeVideo && nativeSourceId && nativeVideo.captureSessionId) {
        window.lycanDesktop!.recordScreenShareStartupTiming(nativeVideo.captureSessionId, 'screenVideoPublished',
          performance.now() - videoStartupStartedAt);
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
          remoteControl.beginShare(currentRoom);
        }
      }
    } catch (error) {
      if (source === Track.Source.Microphone && enabled) {
        published = false;
        if (isCurrentTask()) forbidMicrophone();
      }
      if (source === Track.Source.Microphone && !enabled) {
        microphoneCleanupFailed = true;
        reportNativeAudioCleanupFailure(error);
        if (activeRoom.value === currentRoom) notice.value = MICROPHONE_STOP_NOTICE;
      }
      // 自定义选择器的取消会被 Chromium 以拒绝采集返回；这是正常结束，不能误报为权限或连接故障。
      const targetClosed = source === Track.Source.ScreenShare && error instanceof Error
        && /(?:^|: )captureTargetClosed$/.test(error.message);
      if (isCurrentTask() && !targetClosed
        && !(source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) {
        notice.value = enabled ? captureErrorMessage(error, source)
          : nativeVideoStopFailed
            ? '原生屏幕共享停止未确认，请重启客户端后再试。'
            : source === Track.Source.Microphone ? MICROPHONE_STOP_NOTICE
              : '屏幕共享停止未确认，请重新连接语音。';
      }
    } finally {
      captureSignal?.removeEventListener('abort', cancelCapture);
      // 4. 失败或旧房间的轨道只由本任务所属房间清理，避免碰到新房间的发布。
      const releaseTracks = !published || !isCurrentTask();
      if (source === Track.Source.Microphone && releaseTracks) capturedTracks.forEach(disableMicrophoneTrack);
      const releasedTracks = new Set<LocalTrack>();
      if (releaseTracks && capturedTracks.length) {
        capturedTracks.forEach((track) => retireRoomTrack(currentRoom, track));
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
            if (source === Track.Source.Microphone) microphoneCleanupFailed = true;
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
            if (source === Track.Source.Microphone) microphoneCleanupFailed = true;
          }
        }
        if (source === Track.Source.Microphone && releaseTracks) microphoneTracks.delete(track);
      });
      if (nativeVideo && releaseTracks) {
        try {
          await nativeVideo.stop();
          if (screenShareResource === shareResource) screenShareResource = null;
        } catch (error) {
          reportNativeAudioCleanupFailure(error);
          if (activeRoom.value === currentRoom && shareResource && screenShareResource === shareResource) {
            shareResource.stopping = true;
            notice.value = '原生屏幕共享停止未确认，请重启客户端后再试。';
          }
        }
      }
      if (nativeAudio && releaseTracks) {
        if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
        await nativeAudio.stop().catch(reportNativeAudioCleanupFailure);
      }
      if (source === Track.Source.Microphone && releaseTracks) {
        const muted = await Promise.allSettled(capturedTracks.map((track) => microphoneMutes.get(track)));
        if (muted.some((result) => result.status === 'rejected')) microphoneCleanupFailed = true;
        const processorToRelease = microphoneProcessorForTask ?? microphoneProcessorAtStart;
        if (processorToRelease && microphoneProcessor === processorToRelease) microphoneProcessor = null;
        if (nativeMicrophone) {
          if (nativeMicrophoneSession === nativeMicrophone) nativeMicrophoneSession = null;
          await nativeMicrophone.stop().catch((error) => {
            microphoneCleanupFailed = true;
            reportNativeAudioCleanupFailure(error);
          });
        }
        if (microphoneCleanupFailed && activeRoom.value === currentRoom) {
          notice.value = MICROPHONE_STOP_NOTICE;
          forbidMicrophone();
        }
      }
      if (releaseTracks) updateTrackSubscriptionPermissions(currentRoom);
      operations.delete(source);
      if (source === Track.Source.ScreenShare && activeRoom.value === currentRoom && pendingMedia.value === operations) {
        screenShareSelectionCancelled.value = false;
      }
      if (activeRoom.value === currentRoom && pendingMedia.value === operations) busySources.value = [...operations];
      revision.value++;
      if (enabled && published && !releaseTracks && isCurrentTask() && shareAudioRequested
          && shareResource && screenShareResource === shareResource) {
        // 画面发布完成才异步接入声音；不占用画面的操作锁，等待声音时仍可停止或切换来源。
        void applyScreenShareAudioEnabled(true);
      }
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

  function updateListeningState(enabled: boolean): Promise<void> {
    const currentRoom = activeRoom.value;
    if (!currentRoom || (enabled && status.value !== 'connected')) return Promise.resolve();
    if (listening.value === enabled && microphoneTask?.room === currentRoom) {
      return Promise.all([microphoneTask.promise,
        listeningTask?.room === currentRoom ? listeningTask.promise : Promise.resolve()]).then(() => {});
    }
    listening.value = enabled;
    microphoneVersion++;
    if (!enabled) forbidMicrophone();
    return Promise.all([synchronizeMicrophone(), synchronizeListeningAttribute(currentRoom)]).then(() => {});
  }

  function synchronizeListeningAttribute(currentRoom: Room): Promise<void> {
    if (listeningTask?.room === currentRoom) return listeningTask.promise;
    const task = { room: currentRoom, promise: Promise.resolve() };
    listeningTask = task;
    task.promise = (async () => {
      let applied: boolean;
      do {
        applied = listening.value;
        try {
          await currentRoom.localParticipant.setAttributes({ 'lycansync.listening': String(applied) });
        } catch {
          if (activeRoom.value === currentRoom && !microphoneCleanupFailed) {
            notice.value = '收听状态未能同步给其他成员，请稍后重试。';
          }
        }
      } while (activeRoom.value === currentRoom && applied !== listening.value);
    })().finally(() => { if (listeningTask === task) listeningTask = null; });
    return task.promise;
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
        && unappliedCaptureProcessing(settings, track.getSourceTrackSettings()).length > 0) {
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
    const enabled = source === Track.Source.Microphone
      ? microphoneEnabled.value || (busySources.value.includes(source) && microphoneIntent.value)
      : Boolean(currentRoom.localParticipant.getTrackPublication(source)?.track);
    await setMediaEnabled(source, !enabled);
  }

  async function setScreenShareQuality(quality: ScreenShareQualityId, customQuality = currentCustomScreenShareQuality.value): Promise<boolean> {
    const snapshot = validateCustomScreenShareQuality(customQuality);
    const currentRoom = activeRoom.value;
    const resource = screenShareResource;
    if (!currentRoom || !resource || screenShareQualityBusy.value || screenShareSourceBusy.value
        || pendingMedia.value.has(Track.Source.ScreenShare)
        || (!resource.videoSession.needsFrameRateRecovery && resource.quality === quality && (quality !== 'custom'
          || (resource.customQuality.resolution === snapshot.resolution && resource.customQuality.fps === snapshot.fps
            && resource.customQuality.bitrateMbps === snapshot.bitrateMbps)))
        || currentRoom.state !== ConnectionState.Connected
        || currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track !== resource.videoTrack) return false;
    screenShareQualityBusy.value = true;
    try {
      await resource.videoSession.configureQuality(quality, snapshot);
      if (activeRoom.value !== currentRoom || screenShareResource !== resource) return false;
      resource.quality = quality;
      resource.customQuality = snapshot;
      currentScreenShareQuality.value = quality;
      currentCustomScreenShareQuality.value = snapshot;
      if (notice.value.startsWith('共享帧率自动调整失败')) notice.value = '';
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

  async function changeScreenShareSource(): Promise<boolean> {
    const currentRoom = activeRoom.value;
    const resource = screenShareResource;
    if (resource?.controllerIdentity) {
      notice.value = '私密控制期间不能改为普通共享，请先停止控制后再选择来源。';
      return false;
    }
    const desktop = window.lycanDesktop;
    const selectSource = options?.events?.selectNativeScreenSource;
    if (!desktop || !selectSource || !currentRoom || !resource || screenShareSourceBusy.value
      || screenShareQualityBusy.value || pendingMedia.value.has(Track.Source.ScreenShare)
      || currentRoom.state !== ConnectionState.Connected) return false;
    screenShareSourceBusy.value = true;
    try {
      // 选择期间保留原共享；只有确认且原房间、采集仍有效时才撤销授权并重建。
      const selection = await selectSource(desktop.getNativeMediaCapabilities());
      if (!selection || activeRoom.value !== currentRoom || screenShareResource !== resource) return false;
      await setMediaEnabled(Track.Source.ScreenShare, false);
      if (activeRoom.value !== currentRoom || currentRoom.state !== ConnectionState.Connected
        || screenShareResource || nativeScreenAudioSession
        || currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track
        || currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track) return false;
      await setMediaEnabled(Track.Source.ScreenShare, true, selection);
      return activeRoom.value === currentRoom && screenShareResource !== null
        && Boolean(currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track);
    } catch (error) {
      if (activeRoom.value === currentRoom) notice.value = captureErrorMessage(error, Track.Source.ScreenShare);
      return false;
    } finally {
      screenShareSourceBusy.value = false;
    }
  }

  function setScreenShareAudioEnabled(enabled: boolean): Promise<boolean> {
    if (screenShareResource?.controlTemporary) {
      notice.value = '临时远控画面不共享电脑声音，频道语音保持不变。';
      return Promise.resolve(false);
    }
    // 选择新来源期间保留原声音；新画面发布后的自动接入不受该选择器锁阻挡。
    if (screenShareSourceBusy.value) return Promise.resolve(false);
    return applyScreenShareAudioEnabled(enabled);
  }

  async function applyScreenShareAudioEnabled(enabled: boolean): Promise<boolean> {
    const currentRoom = activeRoom.value;
    const resource = screenShareResource;
    const desktop = window.lycanDesktop;
    if (!desktop || !currentRoom || !resource?.captureSessionId || resource.audioChanging || resource.stopping
      || resource.controlTemporary
      || screenShareQualityBusy.value || pendingMedia.value.has(Track.Source.ScreenShare)
      || currentRoom.state !== ConnectionState.Connected
      || currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track !== resource.videoTrack) return false;
    const operations = pendingMedia.value;
    const isCurrentTask = () => activeRoom.value === currentRoom && pendingMedia.value === operations
      && screenShareResource === resource && !resource.stopping;
    resource.audioChanging = true;
    notice.value = '';
    let session: NativeScreenAudioSession | null = null;
    let audioTrack: LocalTrack | undefined;
    let published = false;
    let audioStartedAt: number | undefined;
    let audioStartupEndedAt: number | undefined;
    let publishStartedAt: number | undefined;
    let publishMs: number | undefined;
    try {
      const participant = currentRoom.localParticipant;
      const existingTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (!enabled) {
        session = nativeScreenAudioSession;
        if (existingTrack) retireRoomTrack(currentRoom, existingTrack);
        if (nativeScreenAudioSession === session) nativeScreenAudioSession = null;
        try {
          if (existingTrack) await participant.unpublishTrack(existingTrack, true);
        } finally {
          try {
            await session?.stop();
          } catch (error) {
            // 停止未确认时保留资源引用，不能再叠加第二路原生音频采集。
            if (isCurrentTask() && !nativeScreenAudioSession) nativeScreenAudioSession = session;
            throw error;
          }
        }
        session = null;
        return isCurrentTask();
      }
      if (existingTrack) return true;
      if (nativeScreenAudioSession) throw new Error('nativeAudioStopNotConfirmed');
      if (resource.audioMode === 'unavailable') throw new Error('screenShareAudioUnsupported');
      session = createScreenShareAudioSession(currentRoom, resource, desktop);
      nativeScreenAudioSession = session;
      audioStartedAt = performance.now();
      audioTrack = await session.start(resource.sourceId, resource.captureSessionId);
      if (!isCurrentTask() || nativeScreenAudioSession !== session) return false;
      const roomTracks = tracksByRoom.get(currentRoom);
      roomTracks?.eligibleTracks.add(audioTrack);
      publishStartedAt = performance.now();
      const publication = await participant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
      audioStartupEndedAt = performance.now();
      publishMs = audioStartupEndedAt - publishStartedAt;
      if (!isCurrentTask() || nativeScreenAudioSession !== session) return false;
      if (publication.trackSid) roomTracks?.publishedSids.set(audioTrack, publication.trackSid);
      updateTrackSubscriptionPermissions(currentRoom);
      published = true;
      return true;
    } catch (error) {
      audioStartupEndedAt = performance.now();
      if (publishStartedAt !== undefined) publishMs = audioStartupEndedAt - publishStartedAt;
      if (isCurrentTask()) {
        const code = error instanceof Error ? error.message : '';
        if (!enabled || code === 'nativeAudioStopNotConfirmed') {
          notice.value = '共享声音停止未确认，请停止共享后重试。';
        } else {
          let reason = '共享声音未能开启，请检查声音来源后重试';
          if (code === 'screenShareAudioUnsupported') reason = '当前 Windows 版本不支持屏幕共享声音捕获';
          else if (code === 'screenShareAudioTargetUnavailable') {
            reason = resource.kind === 'window' ? '无法确认所选应用的声音来源或应用已关闭'
              : resource.audioMode === 'systemMix' ? '默认播放设备不可用或已切换' : '共享声音目标不可用';
          } else if (code === 'screenShareAudioFormatUnsupported') reason = '当前系统音频格式暂不支持';
          notice.value = `仅共享画面：${reason}。`;
        }
      }
      return false;
    } finally {
      if (audioStartedAt !== undefined && audioStartupEndedAt !== undefined && session && isCurrentTask()) {
        // 首次声音尝试合并为一条摘要；停止、切房后的迟到结果不补写启动成功。
        desktop.recordScreenShareStartupTiming(resource.captureSessionId, 'screenAudioStartup', audioStartupEndedAt - audioStartedAt, {
          outcome: published ? 'published' : 'failed',
          phase: publishStartedAt !== undefined ? 'publish' : session.startupTiming ? 'graph' : 'capture',
          ...session.startupTiming,
          ...(publishMs !== undefined ? { publishMs } : {}),
        });
      }
      if (enabled && session && (!published || !isCurrentTask())) {
        if (audioTrack) {
          retireRoomTrack(currentRoom, audioTrack);
          const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
          if (publication?.track === audioTrack) {
            await currentRoom.localParticipant.unpublishTrack(audioTrack, true).catch(reportNativeAudioCleanupFailure);
          }
        }
        try {
          await session.stop();
          if (nativeScreenAudioSession === session) nativeScreenAudioSession = null;
        } catch (error) {
          reportNativeAudioCleanupFailure(error);
          if (isCurrentTask()) notice.value = '共享声音停止未确认，请停止共享后重试。';
        }
      }
      resource.audioChanging = false;
      revision.value++;
    }
  }

  function cancelPendingScreenShareSelection() {
    if (!pendingMedia.value.has(Track.Source.ScreenShare)) return;
    screenShareSelectionCancelled.value = true;
    const resource = screenShareResource;
    const currentRoom = activeRoom.value;
    if (resource && currentRoom) {
      resource.stopping = true;
      retireRoomTrack(currentRoom, resource.videoTrack);
    }
  }

  return { revision, room, playbackContext, status, participants, notice, needsAudioPlayback, busySources, screenShareActive,
    listening, microphoneIntent, microphoneEnabled,
    currentScreenShareQuality, currentCustomScreenShareQuality, screenShareQualityBusy, setScreenShareQuality,
    currentScreenShareAudioMode, screenShareSourceBusy, changeScreenShareSource, setScreenShareAudioEnabled,
    screenShareAudioRestricted,
    remoteControlRequest: remoteControl.request, remoteControlOwner: remoteControl.owner,
    remoteControlShares: remoteControl.shares, remoteControlActive: remoteControl.active,
    remoteControlAvailable: remoteControl.available, remoteControlPresentations: remoteControl.presentations,
    remoteControlRestoring: remoteControl.restoring,
    remoteControlPending: remoteControl.pending, remoteControlGranting: remoteControl.granting,
    join, leave, toggleMedia, setMediaEnabled, enableAudioPlayback, updateListeningState,
    setMicrophoneInputGain, setMicrophoneProcessing, setRemoteAudioSubscribed, sendEntranceSound,
    requestRemoteControl: (identity: string) => remoteControl.requestControl(identity),
    sendRemoteControlInput: (input: RemoteControlInput) => remoteControl.sendInput(input),
    exitRemoteControl: () => remoteControl.exitControl(),
    revokeRemoteControl: () => remoteControl.revokeOwner(),
    retryRemoteControlCleanup: () => remoteControl.retryCleanup(),
    remoteControlCleanupPending: remoteControl.cleanupPending,
    allowRemoteControl: (sourceId: string, publicVideo: boolean) => remoteControl.allow(sourceId, publicVideo),
    rejectRemoteControl: () => remoteControl.reject(),
    cancelPendingRemoteControl: (identity?: string) => remoteControl.cancelPending(identity),
    cancelPendingScreenShareSelection };
}

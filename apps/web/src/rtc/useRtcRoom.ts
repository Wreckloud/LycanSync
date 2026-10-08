import { markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import {
  ConnectionState, DisconnectReason, LocalAudioTrack, Room, RoomEvent, Track, VideoPreset, supportsAV1,
  type VideoCodec,
  type LocalTrack, type Participant, type RemoteParticipant,
} from 'livekit-client';
import { requestRtcToken, TokenRequestError } from './tokenApi';
import { DEFAULT_AUDIO_PREFERENCES, normalizeAudioVolume, unappliedCaptureProcessing,
  type AudioProcessingSettings } from './audioPreferences';
import { ENTRANCE_SOUND_MAX_BYTES, ENTRANCE_SOUND_TOPIC, isSupportedEntranceSoundType } from './entranceSound';
import { MicrophoneAudioProcessor } from './microphoneAudioProcessor';
import { NativeScreenVideoSession } from './nativeScreenVideo';
import { NativeScreenAudioSession } from './nativeScreenAudio';
import { NativeMicrophoneAudioSession, type NativeMicrophoneSettings } from './nativeMicrophoneAudio';
import { nativeScreenAudioMode } from './nativeScreenAudioMode';

type RoomStatus = 'idle' | 'joining' | 'connected' | 'reconnecting';
type MediaSource = Track.Source.Microphone | Track.Source.ScreenShare;
// 单路游戏共享的目标上限：12Mbps 只是“视觉近似无损”的起始码率，不保证实际恒定，也不保证无损。
const SCREEN_SHARE_PRESET = new VideoPreset(1920, 1080, 12_000_000, 60, 'medium');
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

interface NativeScreenSourceSelection { sourceId: string; shareAudio: boolean }

interface RtcRoomOptions {
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
      if (code) return `屏幕共享操作失败（${code}）。`;
    }
  }
  return `${label}操作失败，请检查设备、浏览器权限和 LiveKit 连接。`;
}

/** LiveKit 浏览器回退链路：集中管理入房、采集、发布和释放，不保存账号或入房凭证。 */
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
  let nativeScreenVideoSession: NativeScreenVideoSession | null = null;
  let nativeScreenAudioSession: NativeScreenAudioSession | null = null;

  function clearSpeakerRefreshTimer() {
    if (speakerRefreshTimer !== null) clearTimeout(speakerRefreshTimer);
    speakerRefreshTimer = null;
  }

  onScopeDispose(() => {
    pendingJoin.value?.abort();
    const currentRoom = activeRoom.value;
    activeRoom.value = null;
    const nativeVideo = nativeScreenVideoSession;
    nativeScreenVideoSession = null;
    const nativeAudio = nativeScreenAudioSession;
    nativeScreenAudioSession = null;
    const nativeMicrophone = nativeMicrophoneSession;
    nativeMicrophoneSession = null;
    void nativeAudio?.stop().catch(() => {});
    void nativeMicrophone?.stop().catch(() => {});
    void nativeVideo?.stop().catch(() => {});
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    clearSpeakerRefreshTimer();
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
      let remoteEventsEnabled = false;
      const receivedEntranceSounds = new Set<string>();

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
        if (remoteEventsEnabled) options?.events?.participantJoined?.(participant.identity);
        refresh();
      });
      currentRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        receivedEntranceSounds.delete(participant.identity);
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
        if (publication.source === Track.Source.ScreenShare) options?.events?.screenShareStarted?.();
        refresh();
      });
      currentRoom.on(RoomEvent.TrackUnpublished, (publication) => {
        if (remoteEventsEnabled && publication.source === Track.Source.ScreenShare) {
          options?.events?.screenShareStopped?.();
        }
        refresh();
      });
      currentRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
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
          || connectionState === ConnectionState.SignalReconnecting) status.value = 'reconnecting';
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
      refresh();
      status.value = 'connected';
      remoteEventsEnabled = true;

      // 5. 明确加入语音后默认开麦；权限失败只保持关麦，不退出已经建立的语音会话。
      await setMediaEnabled(Track.Source.Microphone, true);
      await updateListeningState(true);
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
    // 先使旧会话失效，再停止发布与连接，防止迟到的事件覆盖下一次入房状态。
    pendingJoin.value?.abort();
    pendingJoin.value = null;
    const currentRoom = activeRoom.value;
    activeRoom.value = null;
    const nativeVideo = nativeScreenVideoSession;
    nativeScreenVideoSession = null;
    const nativeAudio = nativeScreenAudioSession;
    nativeScreenAudioSession = null;
    const nativeMicrophone = nativeMicrophoneSession;
    nativeMicrophoneSession = null;
    const nativeStop = Promise.all([
      nativeAudio?.stop().catch(() => {}),
      nativeVideo?.stop().catch(() => {}),
      nativeMicrophone?.stop().catch(() => {}),
    ]);
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    clearSpeakerRefreshTimer();
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
    busySources.value = [...operations];
    notice.value = '';
    if (source === Track.Source.ScreenShare && enabled) screenShareSelectionCancelled.value = false;
    let capturedTracks: LocalTrack[] = [];
    let nativeVideo: NativeScreenVideoSession | null = null;
    let nativeAudio: NativeScreenAudioSession | null = null;
    let nativeMicrophone: NativeMicrophoneAudioSession | null = null;
    let published = false;
    try {
      // 1. 关闭时取消发布并释放设备，而不是仅把采集中的音频静音。
      const participant = currentRoom.localParticipant;
      const existingTrack = participant.getTrackPublication(source)?.track;
      if (!enabled) {
        if (source === Track.Source.ScreenShare) {
          nativeVideo = nativeScreenVideoSession;
          nativeScreenVideoSession = null;
          nativeAudio = nativeScreenAudioSession;
          nativeScreenAudioSession = null;
          // stop() marks the writer intentional synchronously, before unpublish stops its track.
          const nativeStop = nativeVideo?.stop();
          try {
            const shareAudioTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
            await Promise.all([
              existingTrack ? participant.unpublishTrack(existingTrack, true) : Promise.resolve(),
              shareAudioTrack ? participant.unpublishTrack(shareAudioTrack, true) : Promise.resolve(),
            ]);
          } finally {
            await Promise.all([nativeStop, nativeAudio?.stop()]);
          }
        } else if (existingTrack) {
          nativeMicrophone = nativeMicrophoneSession;
          nativeMicrophoneSession = null;
          try {
            await participant.unpublishTrack(existingTrack, true);
          } finally {
            await nativeMicrophone?.stop();
            nativeMicrophone = null;
          }
        }
        if (source === Track.Source.Microphone) microphoneProcessor = null;
        return;
      }
      if (existingTrack) return;

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
              const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
              if (publication?.track) void currentRoom.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
              void nativeMicrophone?.stop().catch(() => {});
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
          const audioTrack = capturedTracks.find((track): track is LocalAudioTrack => track instanceof LocalAudioTrack);
          if (!audioTrack) throw new Error('麦克风采集未返回音频轨道');
          // LocalParticipant.createTracks 返回后才会给轨道注入房间的 AudioContext，此时接入处理器才可靠。
          await audioTrack.setProcessor(processor);
          microphoneProcessor = processor;
        }
      } else {
        const desktop = window.lycanDesktop;
        if (desktop) {
          const selectSource = options?.events?.selectNativeScreenSource;
          const capabilitiesPromise = desktop.getNativeMediaCapabilities();
          if (!selectSource) {
            const capabilities = await capabilitiesPromise;
            if (!capabilities.videoCapture?.available) {
              throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
            }
            throw new Error('nativeSourceSelectionUnavailable');
          }
          const selectionPromise = selectSource(capabilitiesPromise);
          const selection = await selectionPromise;
          if (!selection) return;
          const capabilities = await capabilitiesPromise;
          if (!capabilities.videoCapture?.available) {
            throw new Error(capabilities.videoCapture?.reason || 'nativeVideoUnavailable');
          }
          const { sourceId } = selection;
          nativeVideo = new NativeScreenVideoSession(desktop, {
            maxFps: SCREEN_SHARE_PRESET.encoding.maxFramerate ?? 60,
            onError: (code) => {
              if (nativeScreenVideoSession !== nativeVideo || activeRoom.value !== currentRoom) return;
              nativeScreenVideoSession = null;
              if (code !== 'captureTargetClosed') notice.value = `原生屏幕共享已停止（${code}）。`;
              const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
              if (publication?.track) void currentRoom.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
              const screenAudioTrack = currentRoom.localParticipant
                .getTrackPublication(Track.Source.ScreenShareAudio)?.track;
              if (screenAudioTrack) {
                void currentRoom.localParticipant.unpublishTrack(screenAudioTrack, true).catch(() => {});
              }
              nativeAudio = nativeScreenAudioSession;
              nativeScreenAudioSession = null;
              void nativeAudio?.stop().catch(() => {});
              void nativeVideo?.stop().catch(() => {});
              revision.value++;
            },
          });
          nativeScreenVideoSession = nativeVideo;
          capturedTracks = [await nativeVideo.start(sourceId)];
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
                    void currentRoom.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
                  }
                  revision.value++;
                },
              });
              nativeScreenAudioSession = nativeAudio;
              try {
                const videoSessionId = nativeVideo.captureSessionId;
                if (!videoSessionId) throw new Error('nativeVideoSessionUnavailable');
                capturedTracks.push(await nativeAudio.start(sourceId, videoSessionId));
              } catch (error) {
                if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
                await nativeAudio.stop().catch(() => {});
                nativeAudio = null;
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
              notice.value = '仅共享画面：当前 Windows 版本不支持屏幕共享声音捕获。';
            }
          }
        } else {
          // 浏览器环境保留 Chromium 采集作为显式回滚路径；Electron 始终走上面的原生接口。
          capturedTracks = await participant.createScreenTracks({
            audio: false,
            contentHint: 'motion',
            resolution: SCREEN_SHARE_PRESET.resolution,
          });
        }
      }
      // 3. 选择器返回时可能已经离房，必须在发布前检查，不能只在发布后清理。
      if (activeRoom.value !== currentRoom) return;
      capturedTracks.forEach((track) => unpublishedTracks.value.add(track));
      await Promise.all(capturedTracks.map((track) => {
        if (nativeMicrophone && track === nativeMicrophone.track) {
          return participant.publishTrack(track, { source: Track.Source.Microphone });
        }
        if (nativeVideo && track === nativeVideo.track) {
          return participant.publishTrack(track, {
            source: Track.Source.ScreenShare,
            videoEncoding: { ...SCREEN_SHARE_PRESET.encoding, priority: 'high' },
          });
        }
        if (nativeAudio && track === nativeAudio.track) {
          return participant.publishTrack(track, { source: Track.Source.ScreenShareAudio });
        }
        return participant.publishTrack(track);
      }));
      published = true;
    } catch (error) {
      // 自定义选择器的取消会被 Chromium 以拒绝采集返回；这是正常结束，不能误报为权限或连接故障。
      const targetClosed = source === Track.Source.ScreenShare && error instanceof Error
        && /(?:^|: )captureTargetClosed$/.test(error.message);
      if (activeRoom.value === currentRoom && !targetClosed
        && !(source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) {
        notice.value = captureErrorMessage(error, source);
      }
    } finally {
      // 4. 失败或旧会话的采集立即停止；已发布的轨道交由房间管理生命周期。
      capturedTracks.forEach((track) => {
        unpublishedTracks.value.delete(track);
        if ((!published || activeRoom.value !== currentRoom) && !nativeVideo) track.stop();
      });
      if (nativeVideo && (!published || activeRoom.value !== currentRoom)) {
        const videoPublication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const audioPublication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
        const audioTrack = nativeAudio?.track;
        await Promise.all([
          videoPublication?.track === nativeVideo.track
            ? currentRoom.localParticipant.unpublishTrack(nativeVideo.track, true).catch(() => {}) : Promise.resolve(),
          audioTrack && audioPublication?.track === audioTrack
            ? currentRoom.localParticipant.unpublishTrack(audioTrack, true).catch(() => {}) : Promise.resolve(),
        ]);
        if (nativeScreenVideoSession === nativeVideo) nativeScreenVideoSession = null;
        await nativeVideo.stop().catch(() => {});
      }
      if (nativeAudio && (!published || activeRoom.value !== currentRoom)) {
        if (nativeScreenAudioSession === nativeAudio) nativeScreenAudioSession = null;
        await nativeAudio.stop().catch(() => {});
      }
      if (source === Track.Source.Microphone && (!published || activeRoom.value !== currentRoom)) {
        microphoneProcessor = null;
        if (nativeMicrophone) {
          if (nativeMicrophoneSession === nativeMicrophone) nativeMicrophoneSession = null;
          await nativeMicrophone.stop().catch(() => {});
        }
      }
      operations.delete(source);
      if (source === Track.Source.ScreenShare) screenShareSelectionCancelled.value = false;
      if (activeRoom.value === currentRoom) busySources.value = [...operations];
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
    if (nativeMicrophoneSession) {
      void nativeMicrophoneSession.configure({
        inputGain: microphoneInputGain,
        noiseSuppression: microphoneProcessing.noiseSuppression,
        autoGainControl: microphoneProcessing.autoGainControl,
        voiceEnhancement: microphoneProcessing.voiceEnhancement,
      }).catch(() => {
        if (nativeMicrophoneSession && activeRoom.value) notice.value = '麦克风设置未能应用。';
      });
    }
  }

  async function setMicrophoneProcessing(settings: AudioProcessingSettings) {
    microphoneProcessing = { ...settings };
    microphoneProcessor?.setVoiceEnhancement(settings.voiceEnhancement);
    if (nativeMicrophoneSession) {
      try {
        await nativeMicrophoneSession.configure({
          inputGain: microphoneInputGain,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          voiceEnhancement: settings.voiceEnhancement,
        });
      } catch {
        if (nativeMicrophoneSession && activeRoom.value) notice.value = '麦克风设置未能应用。';
      }
      return;
    }
    const track = activeRoom.value?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    if (notice.value === PROCESSING_RESTART_NOTICE || notice.value === PROCESSING_UNSUPPORTED_NOTICE) notice.value = '';
    try {
      await track.applyConstraints({
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      });
      if (unappliedCaptureProcessing(settings, track.mediaStreamTrack.getSettings()).length > 0
        && activeRoom.value) {
        notice.value = PROCESSING_RESTART_NOTICE;
      }
    } catch {
      if (activeRoom.value) notice.value = PROCESSING_UNSUPPORTED_NOTICE;
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

  function cancelPendingScreenShareSelection() {
    if (pendingMedia.value.has(Track.Source.ScreenShare)) screenShareSelectionCancelled.value = true;
  }

  return { revision, room, status, participants, notice, needsAudioPlayback, busySources, screenShareActive,
    join, leave, toggleMedia, setMediaEnabled, enableAudioPlayback, updateListeningState,
    setMicrophoneInputGain, setMicrophoneProcessing, setRemoteAudioSubscribed, sendEntranceSound,
    cancelPendingScreenShareSelection };
}

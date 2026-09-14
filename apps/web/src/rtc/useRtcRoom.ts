import { markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import {
  ConnectionState, DisconnectReason, Room, RoomEvent, Track, VideoPreset, supportsAV1,
  type VideoCodec,
  type LocalTrack, type Participant,
} from 'livekit-client';
import { requestRtcToken, TokenRequestError } from './tokenApi';

type RoomStatus = 'idle' | 'joining' | 'connected' | 'reconnecting';
type MediaSource = Track.Source.Microphone | Track.Source.ScreenShare;
// 单路游戏共享的目标上限：12Mbps 只是“视觉近似无损”的起始码率，不保证实际恒定，也不保证无损。
const SCREEN_SHARE_PRESET = new VideoPreset(1920, 1080, 12_000_000, 60, 'medium');
const SPEAKER_REFRESH_INTERVAL_MS = 120;

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
  }
  return `${label}操作失败，请检查设备、浏览器权限和 LiveKit 连接。`;
}

/** 管理一次临时入房及其媒体生命周期；不保存账号或入房凭证。 */
export function useRtcRoom() {
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
  const screenShareSelectionCancelled = ref(false);
  let speakerRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSpeakerRefreshTimer() {
    if (speakerRefreshTimer !== null) clearTimeout(speakerRefreshTimer);
    speakerRefreshTimer = null;
  }

  onScopeDispose(() => {
    pendingJoin.value?.abort();
    const currentRoom = activeRoom.value;
    activeRoom.value = null;
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
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
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

      // 3. SDK 实例保持原样；事件更新数组与版本，驱动 Vue 重读成员和轨道状态。
      const refresh = () => {
        if (activeRoom.value !== currentRoom) return;
        revision.value++;
        participants.value = [currentRoom.localParticipant, ...currentRoom.remoteParticipants.values()];
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
        RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
        RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
        RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
        RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
        RoomEvent.ParticipantAttributesChanged,
        RoomEvent.AudioPlaybackStatusChanged,
      ].forEach((event) => currentRoom.on(event, refresh));
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
      refresh();
      status.value = 'connected';

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

  function leave() {
    // 先使旧会话失效，再停止发布与连接，防止迟到的事件覆盖下一次入房状态。
    pendingJoin.value?.abort();
    pendingJoin.value = null;
    const currentRoom = activeRoom.value;
    activeRoom.value = null;
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    clearSpeakerRefreshTimer();
    pendingMedia.value = new Set();
    busySources.value = [];
    screenShareSelectionCancelled.value = false;
    room.value = null;
    participants.value = [];
    status.value = 'idle';
    needsAudioPlayback.value = false;
    notice.value = '';
    // 桌面关窗需等待离房信令发送完毕；本地状态和采集已在上方立即清理。
    return currentRoom?.disconnect() ?? Promise.resolve();
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
    let published = false;
    try {
      // 1. 关闭时取消发布并释放设备，而不是仅把采集中的音频静音。
      const participant = currentRoom.localParticipant;
      const existingTrack = participant.getTrackPublication(source)?.track;
      if (!enabled) {
        if (existingTrack) await participant.unpublishTrack(existingTrack, true);
        return;
      }
      if (existingTrack) return;

      // 2. 用户点击后才请求采集；首版屏幕只要视频，不请求系统音频。
      // TODO: 桌面端验证游戏窗口采集与可选游戏音频，区分麦克风和共享音频的音量控制。
      capturedTracks = source === Track.Source.Microphone
        ? await participant.createTracks({ audio: true, video: false })
        : await participant.createScreenTracks({
          audio: false,
          contentHint: 'motion',
          resolution: SCREEN_SHARE_PRESET.resolution,
        });
      // 3. 选择器返回时可能已经离房，必须在发布前检查，不能只在发布后清理。
      if (activeRoom.value !== currentRoom) return;
      capturedTracks.forEach((track) => unpublishedTracks.value.add(track));
      await Promise.all(capturedTracks.map((track) => participant.publishTrack(track)));
      published = true;
    } catch (error) {
      // 自定义选择器的取消会被 Chromium 以拒绝采集返回；这是正常结束，不能误报为权限或连接故障。
      if (activeRoom.value === currentRoom && !(source === Track.Source.ScreenShare && screenShareSelectionCancelled.value)) {
        notice.value = captureErrorMessage(error, source);
      }
    } finally {
      // 4. 失败或旧会话的采集立即停止；已发布的轨道交由房间管理生命周期。
      capturedTracks.forEach((track) => {
        unpublishedTracks.value.delete(track);
        if (!published || activeRoom.value !== currentRoom) track.stop();
      });
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

  async function toggleMedia(source: MediaSource) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || currentRoom.state !== ConnectionState.Connected) return;
    const enabled = Boolean(currentRoom.localParticipant.getTrackPublication(source)?.track);
    await setMediaEnabled(source, !enabled);
  }

  function cancelPendingScreenShareSelection() {
    if (pendingMedia.value.has(Track.Source.ScreenShare)) screenShareSelectionCancelled.value = true;
  }

  return { revision, room, status, participants, notice, needsAudioPlayback, busySources,
    join, leave, toggleMedia, setMediaEnabled, enableAudioPlayback, updateListeningState, cancelPendingScreenShareSelection };
}

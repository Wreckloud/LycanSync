import { markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import { ConnectionState, Room, RoomEvent, Track, type LocalTrack, type Participant } from 'livekit-client';
import { requestRtcToken, TokenRequestError } from './tokenApi';

type RoomStatus = 'idle' | 'joining' | 'connected' | 'reconnecting';
type MediaSource = Track.Source.Microphone | Track.Source.ScreenShare;

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

  onScopeDispose(() => {
    pendingJoin.value?.abort();
    const currentRoom = activeRoom.value;
    activeRoom.value = null;
    unpublishedTracks.value.forEach((track) => track.stop());
    unpublishedTracks.value.clear();
    currentRoom?.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    currentRoom?.removeAllListeners();
    void currentRoom?.disconnect();
  });

  async function join(groupId: string, displayName: string): Promise<boolean> {
    if (pendingJoin.value || activeRoom.value) return false;
    if (!displayName.trim() || displayName.length > 32) {
      notice.value = '请输入 1–32 个字符的昵称，不能全为空白。';
      return false;
    }

    // 1. 先申请临时凭证；取消入房时中止请求，过期请求不能建立新连接。
    const request = new AbortController();
    pendingJoin.value = request;
    notice.value = '';
    status.value = 'joining';
    let joiningRoom: Room | null = null;
    try {
      const credential = await requestRtcToken(groupId, displayName.trim(), request.signal);
      if (request.signal.aborted) return false;

      // 2. 建立独立的 RTC 会话；连接本身不采集麦克风、摄像头或屏幕。
      // TODO: 根据异地实测调整共享画质，并记录连接类型、RTT、丢包和码率以排查代理影响。
      joiningRoom = markRaw(new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        publishDefaults: {
          videoCodec: 'vp8',
          screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
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
      [
        RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
        RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
        RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
        RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
        RoomEvent.ActiveSpeakersChanged,
        RoomEvent.ParticipantAttributesChanged,
        RoomEvent.AudioPlaybackStatusChanged,
      ].forEach((event) => currentRoom.on(event, refresh));
      currentRoom.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
        if (activeRoom.value !== currentRoom) return;
        if (connectionState === ConnectionState.Connected) status.value = 'connected';
        else if (connectionState === ConnectionState.Reconnecting
          || connectionState === ConnectionState.SignalReconnecting) status.value = 'reconnecting';
        refresh();
      });
      currentRoom.on(RoomEvent.Disconnected, () => {
        if (activeRoom.value !== currentRoom) return;
        leave();
        notice.value = '已与房间断开连接，请确认 LiveKit 正常运行后重新加入。';
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
    void currentRoom?.disconnect();
    pendingMedia.value = new Set();
    busySources.value = [];
    room.value = null;
    participants.value = [];
    status.value = 'idle';
    needsAudioPlayback.value = false;
    notice.value = '';
  }

  async function setMediaEnabled(source: MediaSource, enabled: boolean) {
    const currentRoom = activeRoom.value;
    if (!currentRoom || currentRoom.state !== ConnectionState.Connected
      || pendingMedia.value.has(source)) return;
    const operations = pendingMedia.value;
    operations.add(source);
    busySources.value = [...operations];
    notice.value = '';
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
          resolution: { width: 1280, height: 720, frameRate: 15 },
        });
      // 3. 选择器返回时可能已经离房，必须在发布前检查，不能只在发布后清理。
      if (activeRoom.value !== currentRoom) return;
      capturedTracks.forEach((track) => unpublishedTracks.value.add(track));
      await Promise.all(capturedTracks.map((track) => participant.publishTrack(track)));
      published = true;
    } catch (error) {
      if (activeRoom.value === currentRoom) notice.value = captureErrorMessage(error, source);
    } finally {
      // 4. 失败或旧会话的采集立即停止；已发布的轨道交由房间管理生命周期。
      capturedTracks.forEach((track) => {
        unpublishedTracks.value.delete(track);
        if (!published || activeRoom.value !== currentRoom) track.stop();
      });
      operations.delete(source);
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

  return { revision, room, status, participants, notice, needsAudioPlayback, busySources,
    join, leave, toggleMedia, setMediaEnabled, enableAudioPlayback, updateListeningState };
}

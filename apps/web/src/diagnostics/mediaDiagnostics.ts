import { Track, type Participant, type Room } from 'livekit-client';
import { readTrackTarget, readVideoLayers, readVideoSourceFps, type TrackTarget, type VideoLayerStats } from '../rtc/mediaStats';

export interface StreamStats {
  identity: string;
  name: string;
  direction: '发送' | '接收';
  target: TrackTarget | null;
  sourceFps: number | null;
  playbackFps: number | null;
  playbackDrops: number | null;
  layers: VideoLayerStats[];
}

export interface MediaDiagnosticsSnapshot {
  time: string;
  pageVisible: boolean;
  participantCount: number;
  omittedParticipants: number;
  streams: StreamStats[];
  audio: { identity: string; source: 'microphone' | 'screen_share_audio'; direction: '发送' | '接收';
    sampleRate: number | null; channels: number | null; packetsLost: number | null; jitterMs: number | null }[];
  process: { cpuPercent: number; memoryMb: number } | null;
  native: NativeCaptureDiagnostics | null;
  failures: string[];
}

/** 面板和主动记录共用同一采样器；只读现有轨道，不创建采集、订阅或房间。 */
export function createMediaDiagnosticsSampler() {
  const previous: Parameters<typeof readVideoLayers>[2] = new Map();
  const previousSource: Parameters<typeof readVideoSourceFps>[2] = new Map();
  const previousPlayback = new WeakMap<HTMLVideoElement, { frames: number; timestamp: number }>();

  function readPlayback(track: Track) {
    const video = track.attachedElements.filter((element): element is HTMLVideoElement =>
      element instanceof HTMLVideoElement && element.isConnected && element.getBoundingClientRect().width > 0)
      .sort((left, right) => right.clientWidth - left.clientWidth)[0];
    if (!video) return { fps: null, dropped: null };
    const quality = video.getVideoPlaybackQuality();
    const timestamp = performance.now();
    const displayedFrames = quality.totalVideoFrames - quality.droppedVideoFrames;
    const last = previousPlayback.get(video);
    previousPlayback.set(video, { frames: displayedFrames, timestamp });
    const elapsedSeconds = last ? (timestamp - last.timestamp) / 1000 : 0;
    return { fps: last && elapsedSeconds > 0 && displayedFrames >= last.frames
      ? Math.round((displayedFrames - last.frames) / elapsedSeconds) : null, dropped: quality.droppedVideoFrames };
  }

  async function collect(room: Room, participants: Participant[]): Promise<MediaDiagnosticsSnapshot> {
    const snapshot: MediaDiagnosticsSnapshot = { time: new Date().toISOString(), pageVisible: !document.hidden,
      participantCount: participants.length, omittedParticipants: Math.max(0, participants.length - 32),
      streams: [], audio: [], process: null, native: null, failures: [] };
    const activeTrackIds = new Set<string>();
    await Promise.all(participants.slice(0, 32).map(async (participant) => {
      const local = participant === room.localParticipant;
      const direction = local ? '发送' as const : '接收' as const;
      await Promise.all([Track.Source.ScreenShare, Track.Source.Microphone, Track.Source.ScreenShareAudio].map(async (source) => {
        const track = participant.getTrackPublication(source)?.track;
        if (!track) return;
        const trackId = track.mediaStreamTrack.id;
        activeTrackIds.add(trackId);
        try {
          const report = await track.getRTCStatsReport();
          if (source === Track.Source.ScreenShare) {
            const playback = readPlayback(track);
            snapshot.streams.push({ identity: participant.identity, name: participant.name || participant.identity,
              direction, target: local ? readTrackTarget(track.mediaStreamTrack.getSettings()) : null,
              sourceFps: local && report ? readVideoSourceFps(report, trackId, previousSource) : null,
              playbackFps: playback.fps, playbackDrops: playback.dropped,
              layers: report ? readVideoLayers(report, local ? 'outbound-rtp' : 'inbound-rtp', previous, trackId) : [] });
          } else {
            const settings = track.mediaStreamTrack.getSettings();
            let packetsLost: number | null = null;
            let jitterMs: number | null = null;
            report?.forEach((stat) => {
              if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return;
              if (typeof stat.packetsLost === 'number') packetsLost = stat.packetsLost;
              if (typeof stat.jitter === 'number') jitterMs = Math.round(stat.jitter * 1000);
            });
            snapshot.audio.push({ identity: participant.identity, source: source === Track.Source.Microphone
              ? 'microphone' : 'screen_share_audio', direction, sampleRate: settings.sampleRate ?? null,
              channels: settings.channelCount ?? null, packetsLost, jitterMs });
          }
        } catch { snapshot.failures.push(source === Track.Source.ScreenShare ? 'videoStatsUnavailable' : 'audioStatsUnavailable'); }
      }));
    }));
    // 重发布或切换来源后不保留旧轨道统计，避免记录越久缓存越大。
    for (const key of previous.keys()) if (![...activeTrackIds].some((id) => key.startsWith(id + ':'))) previous.delete(key);
    for (const key of previousSource.keys()) if (!activeTrackIds.has(key)) previousSource.delete(key);
    const bridge = window.lycanDesktop;
    if (bridge) {
      await Promise.all([
        bridge.getProcessMetrics().then((value) => { snapshot.process = value; })
          .catch(() => { snapshot.failures.push('processMetricsUnavailable'); }),
        // 只有本机正在发送时读取helper，不能因为查看诊断而启动空闲采集进程。
        room.localParticipant.isMicrophoneEnabled || room.localParticipant.isScreenShareEnabled
          ? bridge.getNativeMediaDiagnostics().then((value) => { snapshot.native = value; })
            .catch(() => { snapshot.failures.push('nativeDiagnosticsUnavailable'); }) : Promise.resolve(),
      ]);
    }
    snapshot.streams.sort((left, right) => left.identity.localeCompare(right.identity));
    return snapshot;
  }
  return { collect };
}

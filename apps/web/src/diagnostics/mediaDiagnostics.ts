import { Track, type LocalVideoTrack, type Participant, type Room } from 'livekit-client';
import { readTrackTarget, readVideoLayers, readVideoSourceSample, type TrackTarget, type VideoLayerStats } from '../rtc/mediaStats';
import { readNativeVideoInput } from '../rtc/nativeScreenVideo';

export interface StreamStats {
  identity: string;
  name: string;
  direction: '发送' | '接收';
  target: TrackTarget | null;
  sourceFrames: number | null;
  sourceFps: number | null;
  sourceIntervalMs: number | null;
  playbackFrames: number | null;
  playbackFps: number | null;
  playbackIntervalMs: number | null;
  playbackDrops: number | null;
  layers: VideoLayerStats[];
  nativeInput: ReturnType<typeof readNativeVideoInput>;
  nativeInputInterval: { elapsedMs: number; receivedFrames: number; submittedFrames: number; backpressureDroppedFrames: number;
    receivedFps: number; submittedFps: number; backpressureDropRate: number | null } | null;
  /** 仅供本次报告识别轨道重建；不得导出。 */
  sessionKey: string | null;
  subscription: { subscribed: boolean | null; enabled: boolean | null; muted: boolean | null };
}

export interface MediaDiagnosticsSnapshot {
  time: string;
  pageVisible: boolean;
  participantCount: number;
  remoteParticipantCount: number | null;
  roomState: string | null;
  dynacast: boolean | null;
  omittedParticipants: number;
  streams: StreamStats[];
  audio: { identity: string; source: 'microphone' | 'screen_share_audio'; direction: '发送' | '接收';
    sampleRate: number | null; channels: number | null; packetsLost: number | null; jitterMs: number | null }[];
  process: { cpuPercent: number; memoryMb: number } | null;
  native: NativeCaptureDiagnostics | null;
  nativeInterval: { elapsedMs: number; framesReceived: number; framesProcessed: number;
    receivedFps: number; processedFps: number } | null;
  failures: string[];
}

/** 面板和主动记录共用同一采样器；只读现有轨道，不创建采集、订阅或房间。 */
export function createMediaDiagnosticsSampler() {
  const previous: Parameters<typeof readVideoLayers>[2] = new Map();
  const previousSource: Parameters<typeof readVideoSourceSample>[2] = new Map();
  const previousPlayback = new WeakMap<HTMLVideoElement, { trackId: string; frames: number; timestamp: number }>();
  const previousNativeInput = new Map<string, { receivedFrames: number; submittedFrames: number;
    backpressureDroppedFrames: number; timestamp: number }>();
  let previousNative: { signature: string; framesReceived: number; framesProcessed: number; timestamp: number } | null = null;

  function readNativeInterval(native: NativeCaptureDiagnostics | null) {
    const timestamp = performance.now();
    if (native?.state !== 'running' || typeof native.framesReceived !== 'number'
        || typeof native.framesProcessed !== 'number') {
      previousNative = null;
      return null;
    }
    const signature = [native.sessionId, native.helperVersion, native.captureBackend, native.sourceKind,
      native.frameWidth, native.frameHeight].join('|');
    const last = previousNative;
    previousNative = { signature, framesReceived: native.framesReceived, framesProcessed: native.framesProcessed, timestamp };
    const elapsedMs = last && signature === last.signature ? timestamp - last.timestamp : 0;
    if (!last || elapsedMs <= 0 || signature !== last.signature
        || native.framesReceived < last.framesReceived || native.framesProcessed < last.framesProcessed) return null;
    return { elapsedMs: Math.round(elapsedMs), framesReceived: native.framesReceived - last.framesReceived,
      framesProcessed: native.framesProcessed - last.framesProcessed,
      receivedFps: Math.round((native.framesReceived - last.framesReceived) * 1000 / elapsedMs),
      processedFps: Math.round((native.framesProcessed - last.framesProcessed) * 1000 / elapsedMs) };
  }

  function readPlayback(track: Track) {
    const video = track.attachedElements.filter((element): element is HTMLVideoElement =>
      element instanceof HTMLVideoElement && element.isConnected && element.getBoundingClientRect().width > 0)
      .sort((left, right) => right.clientWidth - left.clientWidth)[0];
    if (!video) return { frames: null, fps: null, intervalMs: null, dropped: null };
    const quality = video.getVideoPlaybackQuality();
    const timestamp = performance.now();
    const displayedFrames = quality.totalVideoFrames - quality.droppedVideoFrames;
    const trackId = track.mediaStreamTrack.id;
    const previous = previousPlayback.get(video);
    const last = previous?.trackId === trackId ? previous : undefined;
    previousPlayback.set(video, { trackId, frames: displayedFrames, timestamp });
    const elapsedSeconds = last ? (timestamp - last.timestamp) / 1000 : 0;
    const comparable = last && elapsedSeconds > 0 && displayedFrames >= last.frames;
    return { frames: displayedFrames, fps: comparable ? Math.round((displayedFrames - last.frames) / elapsedSeconds) : null,
      intervalMs: comparable ? Math.round(elapsedSeconds * 1000) : null, dropped: quality.droppedVideoFrames };
  }

  async function collect(room: Room, participants: Participant[]): Promise<MediaDiagnosticsSnapshot> {
    const snapshot: MediaDiagnosticsSnapshot = { time: new Date().toISOString(), pageVisible: !document.hidden,
      participantCount: participants.length, omittedParticipants: Math.max(0, participants.length - 32),
      remoteParticipantCount: room.remoteParticipants?.size ?? null, roomState: room.state ?? null,
      dynacast: typeof room.options?.dynacast === 'boolean' ? room.options.dynacast : null,
      streams: [], audio: [], process: null, native: null, nativeInterval: null, failures: [] };
    const activeTrackIds = new Set<string>();
    await Promise.all(participants.slice(0, 32).map(async (participant) => {
      const local = participant === room.localParticipant;
      const direction = local ? '发送' as const : '接收' as const;
      await Promise.all([Track.Source.ScreenShare, Track.Source.Microphone, Track.Source.ScreenShareAudio].map(async (source) => {
        const publication = participant.getTrackPublication(source);
        const track = publication?.track;
        const remote = !local && publication && 'isEnabled' in publication ? publication : null;
        const subscription = { subscribed: local ? null : publication?.isSubscribed ?? null,
          enabled: remote ? remote.isEnabled : null, muted: publication?.isMuted ?? null };
        if (!track) {
          // 未订阅的共享也保留状态，避免把“尚未接收”误看成房间里没有共享。
          if (source === Track.Source.ScreenShare && publication) {
            snapshot.streams.push({ identity: participant.identity, name: participant.name || participant.identity,
              direction, target: null, sourceFrames: null, sourceFps: null, playbackFrames: null, playbackFps: null,
              playbackDrops: null,
              sourceIntervalMs: null, playbackIntervalMs: null, nativeInput: null, nativeInputInterval: null,
              sessionKey: null, subscription, layers: [] });
          }
          return;
        }
        const trackId = track.mediaStreamTrack.id;
        activeTrackIds.add(trackId);
        try {
          const report = await track.getRTCStatsReport();
          if (source === Track.Source.ScreenShare) {
            const playback = readPlayback(track);
            const encodings = local ? (track as LocalVideoTrack).sender?.getParameters().encodings : undefined;
            const sourceSample = local && report ? readVideoSourceSample(report, trackId, previousSource)
              : { frames: null, fps: null, intervalMs: null };
            const nativeInput = local ? readNativeVideoInput(track.mediaStreamTrack) : null;
            const nativeTimestamp = performance.now();
            const previousInput = nativeInput ? previousNativeInput.get(trackId) : undefined;
            let nativeInputInterval: StreamStats['nativeInputInterval'] = null;
            if (nativeInput) {
              previousNativeInput.set(trackId, { receivedFrames: nativeInput.receivedFrames,
                submittedFrames: nativeInput.submittedFrames, backpressureDroppedFrames: nativeInput.backpressureDroppedFrames,
                timestamp: nativeTimestamp });
              const elapsedMs = previousInput ? nativeTimestamp - previousInput.timestamp : 0;
              if (previousInput && elapsedMs > 0
                  && nativeInput.receivedFrames >= previousInput.receivedFrames
                  && nativeInput.submittedFrames >= previousInput.submittedFrames
                  && nativeInput.backpressureDroppedFrames >= previousInput.backpressureDroppedFrames) {
                const received = nativeInput.receivedFrames - previousInput.receivedFrames;
                const submitted = nativeInput.submittedFrames - previousInput.submittedFrames;
                const backpressureDropped = nativeInput.backpressureDroppedFrames - previousInput.backpressureDroppedFrames;
                nativeInputInterval = { elapsedMs: Math.round(elapsedMs), receivedFrames: received,
                  submittedFrames: submitted, backpressureDroppedFrames: backpressureDropped,
                  receivedFps: Math.round(received * 1000 / elapsedMs),
                  submittedFps: Math.round(submitted * 1000 / elapsedMs),
                  backpressureDropRate: received > 0
                    ? Math.round(backpressureDropped / received * 10_000) / 100
                    : null };
              }
            }
            snapshot.streams.push({ identity: participant.identity, name: participant.name || participant.identity,
              direction, target: local ? readTrackTarget(track.mediaStreamTrack.getSettings()) : null,
              sourceFrames: sourceSample.frames, sourceFps: sourceSample.fps, sourceIntervalMs: sourceSample.intervalMs,
              playbackFrames: playback.frames, playbackFps: playback.fps, playbackIntervalMs: playback.intervalMs,
              playbackDrops: playback.dropped,
              nativeInput, nativeInputInterval,
              sessionKey: local ? `${trackId}:${nativeInput?.sessionId ?? ''}` : trackId,
              subscription,
              layers: report ? readVideoLayers(report, local ? 'outbound-rtp' : 'inbound-rtp', previous, trackId, encodings) : [] });
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
    for (const key of previousNativeInput.keys()) if (!activeTrackIds.has(key)) previousNativeInput.delete(key);
    const bridge = window.lycanDesktop;
    if (bridge) {
      await Promise.all([
        bridge.getProcessMetrics().then((value) => { snapshot.process = value; })
          .catch(() => { snapshot.failures.push('processMetricsUnavailable'); }),
        // 只有本机正在发送时读取helper，不能因为查看诊断而启动空闲采集进程。
        room.localParticipant.isMicrophoneEnabled || room.localParticipant.isScreenShareEnabled
          ? bridge.getNativeMediaDiagnostics().then((value) => {
            snapshot.native = value;
            snapshot.nativeInterval = readNativeInterval(value);
          })
            .catch(() => { snapshot.failures.push('nativeDiagnosticsUnavailable'); }) : Promise.resolve(),
      ]);
    }
    snapshot.streams.sort((left, right) => left.identity.localeCompare(right.identity));
    return snapshot;
  }
  return { collect };
}

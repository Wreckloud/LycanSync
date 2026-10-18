export interface VideoLayerStats {
  id: string;
  active: boolean | null;
  size: string;
  frameCount: number | null;
  fps: number | null;
  intervalMs: number | null;
  bitrateKbps: number | null;
  codec: string;
  limitation: string | null;
  lostPackets: number | null;
  encoder: string | null;
  averageEncodeMs: number | null;
  droppedFrames: number | null;
}

type PreviousSample = { bytes: number | null; frames: number | null; timestamp: number; encodeTime: number | null };
type PreviousSourceSample = { frames: number; timestamp: number };

export interface VideoSourceSample {
  frames: number | null;
  fps: number | null;
  intervalMs: number | null;
}

export interface TrackTarget {
  displaySurface: string | null;
  resolution: string | null;
  frameRate: number | null;
}

/** 轨道设置只是采集端的目标约束，其中的 frameRate 不能当作实际采集帧率展示。 */
export function readTrackTarget(settings: MediaTrackSettings): TrackTarget {
  const { width, height, frameRate } = settings;
  return {
    displaySurface: typeof settings.displaySurface === 'string' ? settings.displaySurface : null,
    resolution: typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
      ? `${width}×${height}` : null,
    frameRate: typeof frameRate === 'number' && frameRate > 0 ? Math.round(frameRate) : null,
  };
}

export function formatTrackTarget(target: TrackTarget): string {
  return `${target.resolution ?? '未知'}${target.frameRate === null ? '' : ` · ${target.frameRate} fps`}`;
}

/** 采集源帧率位于编码之前；轨道设置里的 frameRate 只是约束结果，不能替代此值。 */
export function readVideoSourceFps(
  report: RTCStatsReport,
  trackId: string,
  previous: Map<string, PreviousSourceSample>,
): number | null {
  return readVideoSourceSample(report, trackId, previous).fps;
}

export function readVideoSourceSample(
  report: RTCStatsReport,
  trackId: string,
  previous: Map<string, PreviousSourceSample>,
): VideoSourceSample {
  let fps: number | null = null;
  let intervalMs: number | null = null;
  let frames: number | null = null;
  report.forEach((stat) => {
    if (stat.type !== 'media-source' || stat.kind !== 'video' || stat.trackIdentifier !== trackId) return;
    const last = previous.get(trackId);
    if (typeof stat.frames === 'number') {
      frames = stat.frames;
      previous.set(trackId, { frames: stat.frames, timestamp: stat.timestamp });
    }
    const elapsedSeconds = last ? (stat.timestamp - last.timestamp) / 1000 : 0;
    if (last && elapsedSeconds > 0 && typeof stat.frames === 'number' && stat.frames >= last.frames) {
      intervalMs = Math.round(elapsedSeconds * 1000);
      fps = Math.round((stat.frames - last.frames) / elapsedSeconds);
    }
  });
  return { frames, fps, intervalMs };
}

/** 从一条视频轨道的 WebRTC 统计中读取实际编解码结果，而非发布时的目标配置。 */
export function readVideoLayers(
  report: RTCStatsReport,
  direction: 'outbound-rtp' | 'inbound-rtp',
  previous: Map<string, PreviousSample>,
  trackId: string,
  encodings?: RTCRtpEncodingParameters[],
): VideoLayerStats[] {
  const layers: VideoLayerStats[] = [];
  report.forEach((stat) => {
    if (stat.type !== direction || (stat.kind ?? stat.mediaType) !== 'video' || stat.isRemote) return;
    const bytes = direction === 'outbound-rtp' ? stat.bytesSent : stat.bytesReceived;
    const frames = direction === 'outbound-rtp' ? stat.framesEncoded : stat.framesDecoded;
    const encodeTime = direction === 'outbound-rtp' && typeof stat.totalEncodeTime === 'number'
      ? stat.totalEncodeTime : null;
    const sampleKey = `${trackId}:${stat.id}`;
    const last = previous.get(sampleKey);
    if (typeof bytes === 'number' || typeof frames === 'number' || encodeTime !== null) previous.set(sampleKey, {
      bytes: typeof bytes === 'number' ? bytes : last?.bytes ?? null,
      frames: typeof frames === 'number' ? frames : null, timestamp: stat.timestamp, encodeTime,
    });
    const elapsedSeconds = last ? (stat.timestamp - last.timestamp) / 1000 : 0;
    const bitrateKbps = last && last.bytes !== null && typeof bytes === 'number' && elapsedSeconds > 0 && bytes >= last.bytes
      ? Math.round((bytes - last.bytes) * 8 / elapsedSeconds / 1000) : null;
    const hasComparableFrames = last && last.frames !== null && typeof frames === 'number'
      && frames >= last.frames && elapsedSeconds > 0;
    const fps = hasComparableFrames && last && last.frames !== null && typeof frames === 'number'
      ? Math.round((frames - last.frames) / elapsedSeconds) : null;
    const codec = report.get(stat.codecId)?.mimeType;
    const encodedFrames = last && last.frames !== null && typeof frames === 'number'
      ? frames - last.frames : 0;
    const encoding = direction === 'outbound-rtp' ? encodings?.find((encoding) =>
      typeof stat.rid === 'string' ? encoding.rid === stat.rid : encodings.length === 1) : undefined;
    let active: boolean | null = null;
    if (direction === 'outbound-rtp') {
      if (typeof stat.active === 'boolean') active = stat.active;
      else if (typeof encoding?.active === 'boolean') active = encoding.active;
    }
    layers.push({
      id: stat.rid ?? stat.id,
      active,
      size: stat.frameWidth && stat.frameHeight ? `${stat.frameWidth}×${stat.frameHeight}` : '未知',
      frameCount: typeof frames === 'number' ? frames : null,
      fps,
      intervalMs: hasComparableFrames ? Math.round(elapsedSeconds * 1000) : null,
      bitrateKbps,
      codec: typeof codec === 'string' ? codec.replace(/^video\//i, '').toUpperCase() : '未知',
      limitation: direction === 'outbound-rtp' && stat.qualityLimitationReason !== 'none'
        ? stat.qualityLimitationReason ?? null : null,
      lostPackets: direction === 'inbound-rtp' && typeof stat.packetsLost === 'number'
        ? stat.packetsLost : null,
      encoder: direction === 'outbound-rtp' && typeof stat.encoderImplementation === 'string'
        ? stat.encoderImplementation : null,
      averageEncodeMs: encodeTime !== null && last?.encodeTime !== null && last?.encodeTime !== undefined
        && encodedFrames > 0 && encodeTime >= last.encodeTime
        ? Math.round((encodeTime - last.encodeTime) / encodedFrames * 1000 * 10) / 10 : null,
      droppedFrames: direction === 'inbound-rtp' && typeof stat.framesDropped === 'number'
        ? stat.framesDropped : null,
    });
  });
  return layers.sort((left, right) => left.size.localeCompare(right.size));
}

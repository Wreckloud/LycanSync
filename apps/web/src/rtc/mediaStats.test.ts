import { describe, expect, it } from 'vitest';
import { formatTrackTarget, readTrackTarget, readVideoLayers, readVideoSourceSample } from './mediaStats';

function report(stats: Record<string, unknown>[]): RTCStatsReport {
  return new Map(stats.map((stat) => [stat.id as string, stat])) as RTCStatsReport;
}

describe('屏幕共享媒体统计', () => {
  it('按编码层关联SFU接收报告，旧报告不重复计为新反馈，并保留报告年龄', () => {
    const previous = new Map();
    const sample = (timestamp: number, feedbackTimestamp: number) => report([
      { id: 'out', rid: 'h', type: 'outbound-rtp', kind: 'video', timestamp, remoteId: 'rr',
        powerEfficientEncoder: true, encoderImplementation: 'ExternalEncoder' },
      { id: 'rr', type: 'remote-inbound-rtp', kind: 'video', timestamp: feedbackTimestamp,
        localId: 'out', roundTripTime: 0.045, fractionLost: 0.025 },
      { id: 'other', type: 'remote-inbound-rtp', kind: 'video', timestamp, localId: 'different',
        roundTripTime: 9, fractionLost: 0.9 },
    ]);
    expect(readVideoLayers(sample(1000, 900), 'outbound-rtp', previous, 'track')[0]).toMatchObject({
      roundTripMs: 45, receiverReportedLossPercent: 2.5, feedbackAgeMs: 100, powerEfficientEncoder: true,
    });
    expect(readVideoLayers(sample(3000, 900), 'outbound-rtp', previous, 'track')[0]).toMatchObject({
      roundTripMs: null, receiverReportedLossPercent: null, feedbackAgeMs: 2100,
    });
    expect(readVideoLayers(sample(5000, 4900), 'outbound-rtp', previous, 'track')[0].roundTripMs).toBe(45);
    expect(readVideoLayers(sample(5000, 4900), 'outbound-rtp', previous, 'new-track')[0].roundTripMs).toBe(45);
    const missing = report([{ id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 7000 },
      { id: 'unrelated', type: 'remote-inbound-rtp', kind: 'video', timestamp: 6900, roundTripTime: 1, fractionLost: 0 }]);
    expect(readVideoLayers(missing, 'outbound-rtp', previous, 'track')[0]).toMatchObject({
      roundTripMs: null, receiverReportedLossPercent: null, feedbackAgeMs: null, powerEfficientEncoder: null,
    });
  });

  it('网络字段缺失或非法时不伪造零，不把false节能标志当成缺失', () => {
    const sample = report([
      { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, powerEfficientEncoder: false },
      { id: 'rr', type: 'remote-inbound-rtp', localId: 'out', timestamp: 900,
        roundTripTime: Infinity, fractionLost: 2 },
    ]);
    expect(readVideoLayers(sample, 'outbound-rtp', new Map(), 'track')[0]).toMatchObject({
      powerEfficientEncoder: false, roundTripMs: null, receiverReportedLossPercent: null,
    });
    const zero = report([
      { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000 },
      { id: 'rr', type: 'remote-inbound-rtp', localId: 'out', timestamp: 1000, roundTripTime: 0, fractionLost: 0 },
    ]);
    expect(readVideoLayers(zero, 'outbound-rtp', new Map(), 'track')[0]).toMatchObject({
      roundTripMs: 0, receiverReportedLossPercent: 0, feedbackAgeMs: 0,
    });
  });

  it('接收丢包与缓冲等待按实际区间计算，首次、无包及计数回退不制造有效数据', () => {
    const previous = new Map();
    const sample = (timestamp: number, packetsReceived: number, packetsLost: number, jitterBufferDelay: number,
      jitterBufferEmittedCount: number) => report([{ id: 'in', type: 'inbound-rtp', kind: 'video', timestamp,
      packetsReceived, packetsLost, jitterBufferDelay, jitterBufferEmittedCount }]);
    expect(readVideoLayers(sample(1000, 100, 2, 1, 50), 'inbound-rtp', previous, 'track')[0])
      .toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
    expect(readVideoLayers(sample(3500, 198, 4, 2, 100), 'inbound-rtp', previous, 'track')[0])
      .toMatchObject({ receiveLossPercent: 2, jitterBufferMs: 20 });
    expect(readVideoLayers(sample(5500, 198, 4, 2, 100), 'inbound-rtp', previous, 'track')[0])
      .toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
    // 迟到包可能让累计丢包下降；不能截成零丢包，也不能跨重置计算等待。
    expect(readVideoLayers(sample(7500, 200, 3, 0.1, 5), 'inbound-rtp', previous, 'track')[0])
      .toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
    expect(readVideoLayers(sample(7500, 200, 3, 0.1, 5), 'inbound-rtp', previous, 'other-track')[0])
      .toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
    expect(readVideoLayers(sample(7500, 300, 4, 1, 10), 'inbound-rtp', previous, 'track')[0])
      .toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
  });

  it('按RID匹配真实编码层开关，不把缺失状态或接收轨道伪造成启用', () => {
    const stats = report([
      { id: 'high', rid: 'h', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080 },
      { id: 'low', rid: 'q', type: 'outbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 360 },
      { id: 'unknown', rid: 'other', type: 'outbound-rtp', kind: 'video' },
    ]);
    const layers = readVideoLayers(stats, 'outbound-rtp', new Map(), 'track', [
      { rid: 'q', active: true }, { rid: 'h', active: false },
    ]);
    expect(layers.find((layer) => layer.id === 'h')?.active).toBe(false);
    expect(layers.find((layer) => layer.id === 'q')?.active).toBe(true);
    expect(layers.find((layer) => layer.id === 'other')?.active).toBeNull();
    expect(readVideoLayers(report([{ id: 'in', type: 'inbound-rtp', kind: 'video', active: true }]),
      'inbound-rtp', new Map(), 'remote')[0].active).toBeNull();
    expect(readVideoLayers(report([{ id: 'single', type: 'outbound-rtp', kind: 'video' }]),
      'outbound-rtp', new Map(), 'single', [{ active: false }])[0].active).toBe(false);
    expect(readVideoLayers(stats, 'outbound-rtp', new Map(), 'unknown').every((layer) => layer.active === null)).toBe(true);
    expect(readVideoLayers(report([{ id: 'single', type: 'outbound-rtp', kind: 'video', active: false }]),
      'outbound-rtp', new Map(), 'single', [{ active: true }])[0].active).toBe(false);
  });

  it('根据连续两次发送统计计算真实码率，并忽略音频', () => {
    const previous = new Map();
    const first = report([
      { id: 'video', type: 'outbound-rtp', kind: 'video', bytesSent: 100_000, timestamp: 1_000,
        frameWidth: 1920, frameHeight: 1080, framesPerSecond: 29.7, codecId: 'codec', qualityLimitationReason: 'cpu' },
      { id: 'audio', type: 'outbound-rtp', kind: 'audio', bytesSent: 500_000, timestamp: 1_000 },
      { id: 'codec', type: 'codec', mimeType: 'video/H264' },
    ]);
    expect(readVideoLayers(first, 'outbound-rtp', previous, 'track')[0]).toMatchObject({
      size: '1920×1080', fps: null, intervalMs: null, bitrateKbps: null, codec: 'H264', limitation: 'cpu',
    });
    const second = report([
      { id: 'video', type: 'outbound-rtp', kind: 'video', bytesSent: 200_000, timestamp: 3_000,
        frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30, codecId: 'codec' },
      { id: 'codec', type: 'codec', mimeType: 'video/H264' },
    ]);
    expect(readVideoLayers(second, 'outbound-rtp', previous, 'track')[0].bitrateKbps).toBe(400);
  });

  it('接收端展示实际解码尺寸及累计丢包，并隔离不同轨道', () => {
    const previous = new Map();
    readVideoLayers(report([{ id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 5_000, timestamp: 1_000 }]),
      'inbound-rtp', previous, 'old-track');
    const layers = readVideoLayers(report([{
      id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 10_000, timestamp: 3_000,
      frameWidth: 1280, frameHeight: 720, packetsLost: 3,
    }]), 'inbound-rtp', previous, 'new-track');
    expect(layers).toMatchObject([{ size: '1280×720', bitrateKbps: null, lostPackets: 3 }]);
  });

  it('区分采集源实际帧率与编码帧率，并计算每帧编码耗时', () => {
    const previous = new Map();
    const previousSource = new Map();
    const first = report([
      { id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'screen',
        frames: 100, timestamp: 1_000 },
      { id: 'outbound', type: 'outbound-rtp', kind: 'video', bytesSent: 10_000,
        framesEncoded: 80, totalEncodeTime: 1, timestamp: 1_000 },
    ]);
    expect(readVideoSourceSample(first, 'screen', previousSource).fps).toBeNull();
    readVideoLayers(first, 'outbound-rtp', previous, 'screen');
    const second = report([
      { id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'screen',
        frames: 220, timestamp: 3_000 },
      { id: 'outbound', type: 'outbound-rtp', kind: 'video', bytesSent: 20_000,
        framesEncoded: 178, totalEncodeTime: 2.96, timestamp: 3_000,
        encoderImplementation: 'Hardware H264' },
    ]);
    expect(readVideoSourceSample(second, 'screen', previousSource).fps).toBe(60);
    expect(readVideoLayers(second, 'outbound-rtp', previous, 'screen')).toMatchObject([
      { fps: 49, encoder: 'Hardware H264', averageEncodeMs: 20 },
    ]);
  });

  it('实际采集帧率独立于轨道目标帧率，两者必须分开展示', () => {
    const previousSource = new Map();
    readVideoSourceSample(report([{ id: 'source', type: 'media-source', kind: 'video',
      trackIdentifier: 'screen', frames: 40, timestamp: 1_000 }]), 'screen', previousSource);
    // 2 秒只前进 36 帧：目标写着 60fps，实际采集仍是 18fps。
    expect(readVideoSourceSample(report([{ id: 'source', type: 'media-source', kind: 'video',
      trackIdentifier: 'screen', frames: 76, timestamp: 3_000 }]), 'screen', previousSource).fps).toBe(18);
    expect(readTrackTarget({ width: 1920, height: 1080, frameRate: 60 }))
      .toEqual({ displaySurface: null, resolution: '1920×1080', frameRate: 60 });
  });

  it('读取共享源类型，缺失的显示面与尺寸按未知处理', () => {
    expect(readTrackTarget({ displaySurface: 'window', width: 1280, height: 720, frameRate: 29.97 }))
      .toEqual({ displaySurface: 'window', resolution: '1280×720', frameRate: 30 });
    expect(readTrackTarget({})).toEqual({ displaySurface: null, resolution: null, frameRate: null });
    expect(formatTrackTarget(readTrackTarget({}))).toBe('未知');
    expect(formatTrackTarget(readTrackTarget({ width: 1920, height: 1080 }))).toBe('1920×1080');
  });

  it('首次采样不产生假帧率或假码率，发送与接收分别累计', () => {
    const previous = new Map();
    expect(readVideoLayers(report([{ id: 'video', type: 'outbound-rtp', kind: 'video',
      bytesSent: 900, framesEncoded: 12, timestamp: 1_000 }]), 'outbound-rtp', previous, 'out-track')[0])
      .toMatchObject({ fps: null, bitrateKbps: null });
    expect(readVideoLayers(report([{ id: 'video', type: 'inbound-rtp', kind: 'video',
      bytesReceived: 900, framesDecoded: 12, timestamp: 1_000 }]), 'inbound-rtp', previous, 'in-track')[0])
      .toMatchObject({ fps: null, bitrateKbps: null });
  });

  it('使用真实计数差和单调统计时间计算区间帧率，不依赖固定两秒或瞬时FPS', () => {
    const previousSource = new Map();
    const first = report([{ id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'screen',
      frames: 100, framesPerSecond: 60, timestamp: 1_000 }]);
    expect(readVideoSourceSample(first, 'screen', previousSource).fps).toBeNull();
    const second = report([{ id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'screen',
      frames: 340, framesPerSecond: 30, timestamp: 3_400 }]);
    expect(readVideoSourceSample(second, 'screen', previousSource).fps).toBe(100);

    const layerPrevious = new Map();
    readVideoLayers(report([{ id: 'video', type: 'outbound-rtp', kind: 'video', framesEncoded: 100,
      framesPerSecond: 60, bytesSent: 100, timestamp: 1_000 }]), 'outbound-rtp', layerPrevious, 'track');
    expect(readVideoLayers(report([{ id: 'video', type: 'outbound-rtp', kind: 'video', framesEncoded: 340,
      framesPerSecond: 30, bytesSent: 1000, timestamp: 3_400 }]), 'outbound-rtp', layerPrevious, 'track')[0])
      .toMatchObject({ fps: 100, intervalMs: 2400 });
  });

  it('缺失的受限原因、编码器与丢帧统计按未知处理', () => {
    const previous = new Map();
    expect(readVideoLayers(report([{ id: 'video', type: 'outbound-rtp', kind: 'video',
      bytesSent: 1_000, framesEncoded: 10, timestamp: 1_000 }]), 'outbound-rtp', previous, 'out-missing')[0])
      .toMatchObject({ limitation: null, encoder: null, averageEncodeMs: null,
        droppedFrames: null, lostPackets: null });
    expect(readVideoLayers(report([{ id: 'video', type: 'outbound-rtp', kind: 'video', bytesSent: 1_000,
      framesEncoded: 10, timestamp: 1_000, qualityLimitationReason: 'none',
      encoderImplementation: 'OpenH264' }]), 'outbound-rtp', previous, 'out-none')[0])
      .toMatchObject({ limitation: null, encoder: 'OpenH264' });
    expect(readVideoLayers(report([{ id: 'video', type: 'inbound-rtp', kind: 'video',
      bytesReceived: 1_000, timestamp: 1_000 }]), 'inbound-rtp', previous, 'in-missing')[0])
      .toMatchObject({ lostPackets: null, droppedFrames: null });
  });
});

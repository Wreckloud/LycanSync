import { afterEach, expect, it, vi } from 'vitest';
import { Track, type Participant, type Room } from 'livekit-client';
import { createMediaDiagnosticsSampler } from './mediaDiagnostics';

afterEach(() => vi.unstubAllGlobals());

it('未入房的自动诊断只读取进程统计，不访问旧成员轨道或启动原生诊断', async () => {
  const { bridge, participants, track } = setup();
  const result = await createMediaDiagnosticsSampler().collect(null, participants);
  expect(result.streams).toEqual([]);
  expect(result.audio).toEqual([]);
  expect(result.participantCount).toBe(0);
  expect(result.process).toEqual({ cpuPercent: 3, memoryMb: 120, entries: [] });
  expect(bridge.getProcessMetrics).toHaveBeenCalledOnce();
  expect(bridge.getNativeMediaDiagnostics).not.toHaveBeenCalled();
  expect(track.getRTCStatsReport).not.toHaveBeenCalled();
});

it('OBS 延误时隙不算成功渲染，使用宿主实际区间，预热均值不进入统计', async () => {
  const { room, local, bridge } = setup();
  const sampler = createMediaDiagnosticsSampler();
  const sample = async (render: ObsRenderDiagnostics) => {
    bridge.getNativeMediaDiagnostics.mockResolvedValueOnce({ state: 'running', captureBackend: 'obsLibobs',
      sessionId: 'current', obsRender: render } as NativeCaptureDiagnostics);
    return sampler.collect(room, [local] as unknown as Participant[]);
  };
  const render = { configuration: 1, elapsedMs: 500, totalFrames: 100, laggedFrames: 1,
    activeFps: null, averageRenderMs: null };
  expect((await sample(render)).obsRenderInterval).toBeNull();
  const ready = { ...render, elapsedMs: 2500, totalFrames: 250, laggedFrames: 10, activeFps: 59, averageRenderMs: 1.5 };
  expect((await sample(ready)).obsRenderInterval).toBeNull();
  vi.stubGlobal('performance', { now: () => -99999 });
  const next = await sample({ ...ready, elapsedMs: 5000, totalFrames: 400, laggedFrames: 14 });
  expect(next.obsRenderInterval).toEqual({ elapsedMs: 2500, totalFrames: 150, laggedFrames: 4,
    renderedFps: 58, laggedPercent: 2.67 });
});

it('OBS 启停、重设配置、暂停恢复、计数重置和读取缺口均重新建立基线', async () => {
  const { room, local, bridge } = setup();
  const sampler = createMediaDiagnosticsSampler();
  let native = { state: 'running', captureBackend: 'obsLibobs', sessionId: 'first', captureSuspended: false,
    obsRender: { configuration: 1, elapsedMs: 2000, totalFrames: 100, laggedFrames: 0, activeFps: 60, averageRenderMs: 1 } };
  const sample = async () => {
    bridge.getNativeMediaDiagnostics.mockResolvedValueOnce(native as NativeCaptureDiagnostics);
    return sampler.collect(room, [local] as unknown as Participant[]);
  };
  const advance = () => { native.obsRender.elapsedMs += 2000; native.obsRender.totalFrames += 120; };
  expect((await sample()).obsRenderInterval).toBeNull();
  advance(); expect((await sample()).obsRenderInterval?.renderedFps).toBe(60);
  native.obsRender.configuration++;
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  advance(); expect((await sample()).obsRenderInterval?.renderedFps).toBe(60);
  native.captureSuspended = true;
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  native.captureSuspended = false;
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  advance(); expect((await sample()).obsRenderInterval?.renderedFps).toBe(60);
  native.obsRender.totalFrames = 0;
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  native.sessionId = 'next';
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  advance(); expect((await sample()).obsRenderInterval?.renderedFps).toBe(60);
  bridge.getNativeMediaDiagnostics.mockRejectedValueOnce(new Error('unavailable'));
  expect((await sampler.collect(room, [local] as unknown as Participant[])).failures).toContain('nativeDiagnosticsUnavailable');
  advance(); expect((await sample()).obsRenderInterval).toBeNull();
  native = { ...native, state: 'idle' };
  expect((await sample()).obsRenderInterval).toBeNull();
});
function setup() {
  vi.stubGlobal('document', { hidden: false });
  const bridge = { getProcessMetrics: vi.fn(async () => ({ cpuPercent: 3, memoryMb: 120, entries: [] })),
    getNativeMediaDiagnostics: vi.fn(async () => ({ state: 'running' })) };
  vi.stubGlobal('window', { lycanDesktop: bridge });
  const track = { attachedElements: [], mediaStreamTrack: { id: 'track', getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }) },
    getRTCStatsReport: vi.fn(async () => new Map([
      ['source', { id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'track', framesPerSecond: 57 }],
      ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', framesPerSecond: 55, frameWidth: 1920,
        frameHeight: 1080, framesEncoded: 100, bytesSent: 1000, timestamp: 1000, codecId: 'codec' }],
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ] as [string, Record<string, unknown>][])) };
  const local = { identity: 'self', name: '自己', isMicrophoneEnabled: false, isScreenShareEnabled: true,
    getTrackPublication: (source: Track.Source) => source === Track.Source.ScreenShare ? { track } : undefined };
  const bad = { identity: 'bad', name: '朋友', getTrackPublication: (source: Track.Source) => source === Track.Source.ScreenShare
    ? { track: { ...track, getRTCStatsReport: async () => { throw new Error('decode failed'); } } } : undefined };
  const room = { localParticipant: local, state: 'connected', options: { dynacast: true },
    remoteParticipants: new Map([['bad', bad]]) } as unknown as Room;
  return { bridge, track, local, room, participants: [local, bad] as unknown as Participant[] };
}

it('复用当前轨道统计补充网络反馈，不增加采样、连接或媒体采集', async () => {
  const { room, local, track, bridge } = setup();
  const stats = new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: 1000,
      powerEfficientEncoder: false, encoderImplementation: 'OpenH264' }],
    ['rr', { id: 'rr', type: 'remote-inbound-rtp', localId: 'video', timestamp: 950,
      roundTripTime: 0.05, fractionLost: 0.01 }],
  ] as [string, Record<string, unknown>][]);
  track.getRTCStatsReport.mockResolvedValue(stats);
  const sampler = createMediaDiagnosticsSampler();
  const first = await sampler.collect(room, [local] as unknown as Participant[]);
  expect(first.streams[0].layers[0]).toMatchObject({ roundTripMs: 50, receiverReportedLossPercent: 1,
    feedbackAgeMs: 50, powerEfficientEncoder: false });
  const next = await sampler.collect(room, [local] as unknown as Participant[]);
  expect(next.streams[0].layers[0]).toMatchObject({ roundTripMs: null, receiverReportedLossPercent: null });
  expect(track.getRTCStatsReport).toHaveBeenCalledTimes(2);
  expect(bridge.getNativeMediaDiagnostics).toHaveBeenCalledTimes(2);
});

it('首次样本显示等待统计，第二份样本按实际间隔计算编码前和编码FPS', async () => {
  const { room, participants, bridge } = setup();
  let now = 1000;
  vi.stubGlobal('performance', { now: () => now });
  bridge.getNativeMediaDiagnostics.mockResolvedValueOnce({ state: 'running', helperVersion: 'test',
    captureBackend: 'obsLibobs', sourceKind: 'window', frameWidth: 1920, frameHeight: 1080,
    framesReceived: 100, framesProcessed: 80 } as NativeCaptureDiagnostics)
    .mockResolvedValueOnce({ state: 'running', helperVersion: 'test',
      captureBackend: 'obsLibobs', sourceKind: 'window', frameWidth: 1920, frameHeight: 1080,
      framesReceived: 340, framesProcessed: 220 } as NativeCaptureDiagnostics);
  const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)!.track!;
  track.getRTCStatsReport = vi.fn()
    .mockResolvedValueOnce(new Map([
      ['source', { id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'track', frames: 100, timestamp: 1000 }],
      ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', frameWidth: 1920,
        frameHeight: 1080, framesEncoded: 100, bytesSent: 1000, timestamp: 1000, codecId: 'codec' }],
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ] as [string, Record<string, unknown>][]))
    .mockResolvedValueOnce(new Map([
      ['source', { id: 'source', type: 'media-source', kind: 'video', trackIdentifier: 'track', frames: 214, timestamp: 3000 }],
      ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', frameWidth: 1920,
        frameHeight: 1080, framesEncoded: 210, bytesSent: 1000, timestamp: 3000, codecId: 'codec' }],
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ] as [string, Record<string, unknown>][]));
  const sampler = createMediaDiagnosticsSampler();
  const initial = await sampler.collect(room, participants);
  now = 3400;
  const result = await sampler.collect(room, participants);
  expect(result.streams).toHaveLength(1);
  expect(initial.streams[0]).toMatchObject({ sourceFps: null, layers: [{ fps: null, intervalMs: null }] });
  expect(result.streams[0]).toMatchObject({ target: { frameRate: 60 }, sourceFps: 57, sourceIntervalMs: 2000,
    playbackFps: null, layers: [{ fps: 55, intervalMs: 2000, codec: 'H264', bitrateKbps: 0 }] });
  expect(initial.nativeInterval).toBeNull();
  expect(result.nativeInterval).toMatchObject({ elapsedMs: 2400, framesReceived: 240, framesProcessed: 140,
    receivedFps: 100, processedFps: 58 });
  expect(result.failures).toContain('videoStatsUnavailable');
  expect(result).toMatchObject({ remoteParticipantCount: 1, roomState: 'connected', dynacast: true });
  expect(result.process).toEqual({ cpuPercent: 3, memoryMb: 120, entries: [] });
  expect(bridge.getNativeMediaDiagnostics).toHaveBeenCalledTimes(2);
});

it('本机没有媒体时不启动helper读取；进程统计失败明确标记，不能伪造零占用', async () => {
  const { room, local, bridge } = setup(); local.isScreenShareEnabled = false;
  bridge.getProcessMetrics.mockRejectedValueOnce(new Error('unavailable'));
  const result = await createMediaDiagnosticsSampler().collect(room, []);
  expect(bridge.getNativeMediaDiagnostics).not.toHaveBeenCalled();
  expect(result.native).toBeNull(); expect(result.process).toBeNull();
  expect(result.failures).toContain('processMetricsUnavailable');
});

it('同尺寸的新原生会话重新建立基线，不与旧会话计数相减', async () => {
  const { room, local, bridge } = setup();
  let now = 1000;
  vi.stubGlobal('performance', { now: () => now });
  const native = { state: 'running', helperVersion: 'test', captureBackend: 'obsLibobs',
    sourceKind: 'window', frameWidth: 1920, frameHeight: 1080 } as NativeCaptureDiagnostics;
  bridge.getNativeMediaDiagnostics.mockResolvedValueOnce({ ...native, sessionId: 'old', framesReceived: 20, framesProcessed: 10 } as NativeCaptureDiagnostics)
    .mockResolvedValueOnce({ ...native, sessionId: 'new', framesReceived: 100, framesProcessed: 50 } as NativeCaptureDiagnostics)
    .mockResolvedValueOnce({ ...native, sessionId: 'new', framesReceived: 340, framesProcessed: 170 } as NativeCaptureDiagnostics);
  const sampler = createMediaDiagnosticsSampler();
  expect((await sampler.collect(room, [local] as unknown as Participant[])).nativeInterval).toBeNull();
  now = 3000;
  expect((await sampler.collect(room, [local] as unknown as Participant[])).nativeInterval).toBeNull();
  now = 5000;
  expect((await sampler.collect(room, [local] as unknown as Participant[])).nativeInterval).toEqual({
    elapsedMs: 2000, framesReceived: 240, framesProcessed: 120, receivedFps: 120, processedFps: 60 });
});

it('轨道消失后清理差分缓存，旧对象重新出现的首样本不会沿用旧码率', async () => {
  const { room, participants, track } = setup();
  const sampler = createMediaDiagnosticsSampler();
  await sampler.collect(room, participants.slice(0, 1));
  await sampler.collect(room, []);
  track.getRTCStatsReport.mockResolvedValueOnce(new Map([['video', { id: 'video', type: 'outbound-rtp', kind: 'video',
    framesEncoded: 500, bytesSent: 9000, timestamp: 9000 }]]));
  const result = await sampler.collect(room, participants.slice(0, 1));
  expect(result.streams[0].layers[0].bitrateKbps).toBeNull();
});

it('只采样有限成员并说明省略数量，音频格式和丢包读取自当前轨道', async () => {
  const { room } = setup();
  const audioTrack = { mediaStreamTrack: { id: 'audio', getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) },
    getRTCStatsReport: async () => new Map([['audio', { type: 'inbound-rtp', kind: 'audio', packetsLost: 3, jitter: 0.012 }]]) };
  const participants = Array.from({ length: 40 }, (_, index) => ({ identity: String(index), name: '',
    getTrackPublication: (source: Track.Source) => source === Track.Source.Microphone ? { track: audioTrack } : undefined })) as unknown as Participant[];
  const result = await createMediaDiagnosticsSampler().collect(room, participants);
  expect(result.participantCount).toBe(40); expect(result.omittedParticipants).toBe(8);
  expect(result.audio).toHaveLength(32);
  expect(result.audio[0]).toMatchObject({ sampleRate: 48000, channels: 1, packetsLost: 3, jitterMs: 12 });
});

it('无人观看时保留真实停层状态，不因bandwidth标签推断网络故障', async () => {
  const { room, local, track } = setup();
  Object.assign(track, { sender: { getParameters: () => ({ encodings: [{ active: false }] }) } });
  const result = await createMediaDiagnosticsSampler().collect(room, [local] as unknown as Participant[]);
  expect(result.streams[0].layers[0].active).toBe(false);
  expect(result.streams[0].subscription).toEqual({ subscribed: null, enabled: null, muted: null });
  expect(result.streams[0].nativeInput).toBeNull();
});

it('远端共享未订阅仍记录状态；读取不改变订阅或启动采集', async () => {
  const { room, local, bridge } = setup();
  local.isScreenShareEnabled = false;
  const publication = { isSubscribed: false, isEnabled: false, isMuted: true,
    setSubscribed: vi.fn(), setEnabled: vi.fn() };
  const remote = { identity: 'remote', name: '朋友', getTrackPublication: (source: Track.Source) =>
    source === Track.Source.ScreenShare ? publication : undefined };
  const result = await createMediaDiagnosticsSampler().collect(room, [remote] as unknown as Participant[]);
  expect(result.streams).toMatchObject([{ direction: '接收', subscription: { subscribed: false, enabled: false, muted: true },
    sourceFps: null, nativeInput: null, layers: [] }]);
  expect(publication.setSubscribed).not.toHaveBeenCalled();
  expect(publication.setEnabled).not.toHaveBeenCalled();
  expect(bridge.getNativeMediaDiagnostics).not.toHaveBeenCalled();
});

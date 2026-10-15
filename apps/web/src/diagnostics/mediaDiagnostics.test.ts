import { afterEach, expect, it, vi } from 'vitest';
import { Track, type Participant, type Room } from 'livekit-client';
import { createMediaDiagnosticsSampler } from './mediaDiagnostics';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal('document', { hidden: false });
  const bridge = { getProcessMetrics: vi.fn(async () => ({ cpuPercent: 3, memoryMb: 120 })),
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
  const room = { localParticipant: local } as unknown as Room;
  return { bridge, track, local, room, participants: [local, bad] as unknown as Participant[] };
}

it('复用实际统计区分轨道目标/编码前输入/编码帧率，单路失败不抹掉其他路', async () => {
  const { room, participants, bridge } = setup();
  const result = await createMediaDiagnosticsSampler().collect(room, participants);
  expect(result.streams).toHaveLength(1);
  expect(result.streams[0]).toMatchObject({ target: { frameRate: 60 }, sourceFps: 57,
    playbackFps: null, layers: [{ fps: 55, codec: 'H264', bitrateKbps: null }] });
  expect(result.failures).toContain('videoStatsUnavailable');
  expect(result.process).toEqual({ cpuPercent: 3, memoryMb: 120 });
  expect(bridge.getNativeMediaDiagnostics).toHaveBeenCalledOnce();
});

it('本机没有媒体时不启动helper读取；进程统计失败明确标记，不能伪造零占用', async () => {
  const { room, local, bridge } = setup(); local.isScreenShareEnabled = false;
  bridge.getProcessMetrics.mockRejectedValueOnce(new Error('unavailable'));
  const result = await createMediaDiagnosticsSampler().collect(room, []);
  expect(bridge.getNativeMediaDiagnostics).not.toHaveBeenCalled();
  expect(result.native).toBeNull(); expect(result.process).toBeNull();
  expect(result.failures).toContain('processMetricsUnavailable');
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

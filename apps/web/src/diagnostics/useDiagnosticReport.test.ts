import { effectScope, shallowRef } from 'vue';
import type { Room } from 'livekit-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaDiagnosticsSnapshot } from './mediaDiagnostics';
import { diagnosticReportSample, useDiagnosticReport } from './useDiagnosticReport';
import type { CustomScreenShareQuality } from '../rtc/screenShareQuality';

const { collect } = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock('./mediaDiagnostics', () => ({ createMediaDiagnosticsSampler: () => ({ collect }) }));
const scopes: ReturnType<typeof effectScope>[] = [];
function snapshot(): MediaDiagnosticsSnapshot {
  return { time: new Date().toISOString(), pageVisible: true, participantCount: 1, omittedParticipants: 0,
    remoteParticipantCount: 0, roomState: 'connected', dynacast: true,
    nativeInterval: null,
    streams: [{ identity: 'private-user-id', name: '私人昵称', direction: '发送', target: null,
      nativeInput: null, subscription: { subscribed: null, enabled: null, muted: false },
      sourceFrames: 200, sourceFps: 59, sourceIntervalMs: 2000, playbackFrames: null,
      playbackFps: null, playbackIntervalMs: null, playbackDrops: null,
      nativeInputInterval: { elapsedMs: 2000, receivedFrames: 200, submittedFrames: 150,
        backpressureDroppedFrames: 50, receivedFps: 100, submittedFps: 75, backpressureDropRate: 25 },
      sessionKey: null, layers: [{ id: 'private-track-id', active: true, size: '1920×1080', frameCount: 180,
        fps: 58, intervalMs: 2000, bitrateKbps: 8000, codec: 'H264', limitation: null, lostPackets: null, encoder: 'testEncoder',
        averageEncodeMs: 2, droppedFrames: null }] }],
    audio: [], process: null, native: null, failures: [] };
}
function setup() {
  const scope = effectScope(); scopes.push(scope);
  const room = shallowRef<Room | null>({} as Room);
  const settings = { quality: 'standard', customQuality: { resolution: 1080, fps: 60 } as CustomScreenShareQuality,
    inputGain: 1, outputVolume: 1, screenShareVolume: 1,
    voiceVolumeBalance: false,
    noiseSuppression: true, autoGainControl: true, voiceEnhancement: true, echoCancellation: false,
    stageCount: 1, focused: false };
  const exportDiagnosticReport = vi.fn(async (_text: string) => ({ saved: true }));
  vi.stubGlobal('window', { lycanDesktop: { exportDiagnosticReport } });
  const report = scope.run(() => useDiagnosticReport({ room: () => room.value, participants: () => [], settings: () => ({ ...settings }) }))!;
  return { scope, room, settings, report, exportDiagnosticReport };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: false });
  collect.mockReset().mockImplementation(async () => snapshot());
});
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('默认不采样；查看时读取，隐藏后停止；主动记录返回应用后继续', async () => {
  const { report } = setup();
  await vi.advanceTimersByTimeAsync(4000);
  expect(collect).not.toHaveBeenCalled();
  report.setViewing(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(collect).toHaveBeenCalledOnce();
  report.setViewing(false);
  await vi.advanceTimersByTimeAsync(4000);
  expect(collect).toHaveBeenCalledOnce();
  report.start();
  await vi.advanceTimersByTimeAsync(0);
  vi.stubGlobal('document', { hidden: true });
  await vi.advanceTimersByTimeAsync(2000);
  expect(report.sampleCount.value).toBe(2);
  report.stop();
  await vi.advanceTimersByTimeAsync(4000);
  expect(report.sampleCount.value).toBe(2);
});

it('切房停止本次记录，旧房间迟到结果不进入新快照或报告', async () => {
  let finish!: (sample: MediaDiagnosticsSnapshot) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { report, room, exportDiagnosticReport } = setup();
  report.start();
  room.value = {} as Room;
  expect(report.recording.value).toBe(false);
  expect(report.reason.value).toBe('roomChanged');
  finish(snapshot());
  await vi.advanceTimersByTimeAsync(0);
  expect(report.latest.value).toBeNull();
  expect(report.sampleCount.value).toBe(0);
  await report.save('未读到统计也可导出故障阶段');
  expect(JSON.parse(exportDiagnosticReport.mock.calls[0][0]).samples).toEqual([]);
});

it('结束及销毁后不追加迟到采样，重新开始不能混入上一轮', async () => {
  let finish!: (sample: MediaDiagnosticsSnapshot) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { report, scope } = setup();
  report.start(); report.stop();
  finish(snapshot());
  await vi.advanceTimersByTimeAsync(0);
  expect(report.sampleCount.value).toBe(0);
  report.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(report.sampleCount.value).toBe(1);
  scope.stop();
  await vi.advanceTimersByTimeAsync(6000);
  expect(report.sampleCount.value).toBe(1);
});

it('上限自动结束，停止后不再增加采样；保存取消保留报告并可重试', async () => {
  const { report, exportDiagnosticReport } = setup();
  report.start();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(report.recording.value).toBe(false);
  expect(report.reason.value).toBe('limit');
  expect(report.sampleCount.value).toBe(900);
  exportDiagnosticReport.mockResolvedValueOnce({ saved: false });
  await report.save('卡顿');
  expect(report.error.value).toBe('');
  await report.save('卡顿');
  expect(exportDiagnosticReport).toHaveBeenCalledTimes(2);
});

it('导出按记录时参数保存，匿名化身份/轨道ID，不使用导出时的新参数', async () => {
  const { report, settings, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(0);
  settings.quality = 'economy';
  settings.voiceVolumeBalance = true;
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); settings.quality = 'custom';
  await report.save('四路略卡');
  const text = exportDiagnosticReport.mock.calls[0][0];
  expect(text).not.toContain('private-user-id'); expect(text).not.toContain('private-track-id');
  expect(text).not.toContain('私人昵称');
  const result = JSON.parse(text);
  expect(result.schemaVersion).toBe(4);
  expect(result.measurements.process).toEqual({ scope: 'electron-app-metrics', memory: 'sum-working-set',
    includesNativeHelpers: false, sharedPagesMayBeCountedMoreThanOnce: true });
  expect(result.samples[0]).toMatchObject({ remoteParticipantCount: 0, roomState: 'connected', dynacast: true });
  expect(result.startSettings.quality).toBe('standard'); expect(result.endSettings.quality).toBe('economy');
  expect(result.startSettings.voiceVolumeBalance).toBe(false);
  expect(result.endSettings.voiceVolumeBalance).toBe(true);
  expect(result.startSettings.preset).toEqual({ width: 1920, height: 1080, maxFrameRate: 60, maxBitrate: 12_000_000 });
  expect(result.endSettings.preset).toEqual({ width: 1280, height: 720, maxFrameRate: 30, maxBitrate: 3_000_000 });
  expect(result.samples.map((sample: { requestedSettings: { quality: string } }) => sample.requestedSettings.quality)).toEqual(['standard', 'economy']);
  expect(result.samples[0].actualIntervalMs).toBeNull();
  expect(result.samples[1].actualIntervalMs).toBeGreaterThan(0);
  expect(result.samples[0].streams[0].segmentId).not.toBe(result.samples[1].streams[0].segmentId);
  expect(result.samples[1].streams[0].segmentReason).toBe('quality-change');
  expect(result.summary.segments).toHaveLength(2);
  expect(result.summary.segments[0]).toMatchObject({ clientVersion: expect.any(String), quality: 'standard',
    sampleCount: 1, validSampleCounts: { sourceFps: 0 }, pageBackpressureDropRate: null,
    typicalFps: { pageReceived: null, pageSubmitted: null } });
  expect(result.samples[0].streams[0].member).toBe('member-1');
});

it('累计帧计数重置后另起匿名分段，不把前后区间合并', async () => {
  const first = snapshot();
  const reset = snapshot();
  reset.streams[0].sourceFrames = 10;
  reset.streams[0].layers[0].frameCount = 20;
  collect.mockResolvedValueOnce(first).mockResolvedValueOnce(reset);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.samples[1].streams[0].segmentReason).toBe('counter-reset');
  expect(result.samples[0].streams[0].segmentId).not.toBe(result.samples[1].streams[0].segmentId);
  expect(result.summary.segments).toHaveLength(2);
  expect(result.summary.segments[1].warnings).toContain('计数器重置后已另起分段。');
  expect(result.samples[1].streams[0]).toMatchObject({ sourceFrames: 10, sourceFps: null,
    nativeInputInterval: null, layers: [{ frameCount: 20, fps: null, intervalMs: null }] });
});

it.each(['quality-change', 'dimensions-change', 'source-change', 'sampling-gap'])(
  '%s 后首样本只保留累计计数，下一完整区间才进入摘要', async (change) => {
    const initial = snapshot();
    const boundary = snapshot();
    boundary.nativeInterval = { elapsedMs: 2000, framesReceived: 180, framesProcessed: 180,
      receivedFps: 90, processedFps: 90 };
    if (change === 'dimensions-change') boundary.streams[0].layers[0].size = '1280×720';
    if (change === 'source-change') boundary.streams[0].sessionKey = 'private-new-session';
    const following = structuredClone(boundary);
    collect.mockResolvedValueOnce(initial);
    if (change === 'sampling-gap') collect.mockResolvedValueOnce({ ...snapshot(), streams: [] });
    collect.mockResolvedValueOnce(boundary).mockResolvedValueOnce(following);
    const { report, settings, exportDiagnosticReport } = setup();
    report.start(); await vi.advanceTimersByTimeAsync(0);
    if (change === 'quality-change') settings.quality = 'highFrameRate';
    if (change === 'sampling-gap') await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    report.stop(); await report.save('');
    const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
    const boundaryIndex = change === 'sampling-gap' ? 2 : 1;
    expect(result.samples[boundaryIndex].nativeInterval).toBeNull();
    expect(result.samples[boundaryIndex].streams[0]).toMatchObject({ segmentReason: change,
      sourceFrames: 200, sourceFps: null, sourceIntervalMs: null, nativeInputInterval: null,
      layers: [{ frameCount: 180, fps: null, intervalMs: null, bitrateKbps: null, averageEncodeMs: null }] });
    expect(result.samples[boundaryIndex + 1].streams[0]).toMatchObject({ segmentReason: 'continuation',
      sourceFps: 59, nativeInputInterval: { receivedFrames: 200, submittedFrames: 150 } });
    expect(result.summary.segments[1]).toMatchObject({ sampleCount: 2, validSampleCounts: { sourceFps: 1 },
      typicalFps: { source: 59, pageReceived: 100, pageSubmitted: 75 },
      pageReceivedFrames: 200, pageBackpressureDroppedFrames: 50, pageBackpressureDropRate: 25 });
  });

it('自定义同模式切换帧率时另起分段，摘要记录确认参数而非默认 1080p60', async () => {
  const { report, settings, exportDiagnosticReport } = setup();
  settings.quality = 'custom';
  settings.customQuality = { resolution: 1440, fps: 180 };
  report.start(); await vi.advanceTimersByTimeAsync(0);
  settings.customQuality.fps = 120;
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.startSettings.preset).toEqual({ width: 2560, height: 1440, maxFrameRate: 180, maxBitrate: 40_000_000 });
  expect(result.samples[1].streams[0].segmentReason).toBe('quality-change');
  expect(result.summary.segments).toHaveLength(2);
  expect(result.summary.segments[0].preset.maxFrameRate).toBe(180);
  expect(result.summary.segments[1].preset.maxFrameRate).toBe(120);
  expect(result.samples[1].streams[0].sourceFps).toBeNull();
});

it('手动码率变化及恢复推荐另起分段，报告同时记录来源与实际配置上限', async () => {
  const { report, settings, exportDiagnosticReport } = setup();
  settings.quality = 'custom';
  settings.customQuality = { resolution: 1080, fps: 60, bitrateMbps: 6 };
  report.start(); await vi.advanceTimersByTimeAsync(0);
  settings.customQuality.bitrateMbps = 10;
  await vi.advanceTimersByTimeAsync(2000);
  settings.customQuality = { resolution: 1080, fps: 60 };
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.startSettings).toMatchObject({ bitrateMode: 'manual', preset: { maxBitrate: 6_000_000 } });
  expect(result.summary.segments.map((segment: { bitrateMode: string; preset: { maxBitrate: number } }) =>
    [segment.bitrateMode, segment.preset.maxBitrate])).toEqual([['manual', 6_000_000], ['manual', 10_000_000], ['recommended', 12_000_000]]);
  expect(result.samples[1].streams[0].segmentReason).toBe('quality-change');
  expect(result.samples[2].streams[0].segmentReason).toBe('quality-change');
});

it.each(['capture', 'unsubscribed', 'disabled', 'muted'])(
  '%s 暂停及恢复边界不计入摘要，原始区间与累计数仍保留', async (pause) => {
    const normal = snapshot();
    normal.native = { state: 'running', sessionId: 'private-native-session', captureSuspended: false } as NativeCaptureDiagnostics;
    normal.nativeInterval = { elapsedMs: 2000, framesReceived: 120, framesProcessed: 100, receivedFps: 60, processedFps: 50 };
    normal.streams[0].nativeInput = { sessionId: 'private-native-session', receivedFrames: 200, submittedFrames: 150,
      backpressureDroppedFrames: 50, suspendedDroppedFrames: 0, completedWrites: 150, writeFailures: 0,
      placeholderFrames: 0, pendingWrite: false, firstFrameMs: 20 };
    if (pause !== 'capture') normal.streams[0].direction = '接收';
    normal.streams[0].playbackFps = 60;
    normal.streams[0].playbackIntervalMs = 2000;
    const paused = structuredClone(normal);
    paused.nativeInterval = { elapsedMs: 2000, framesReceived: 0, framesProcessed: 0, receivedFps: 0, processedFps: 0 };
    paused.streams[0].sourceFps = 0;
    paused.streams[0].playbackFps = 0;
    paused.streams[0].layers[0].fps = 0;
    Object.assign(paused.streams[0].nativeInputInterval!, { receivedFps: 0, submittedFps: 0,
      receivedFrames: 100, submittedFrames: 0, backpressureDroppedFrames: 100 });
    if (pause === 'capture') paused.native!.captureSuspended = true;
    if (pause === 'unsubscribed') paused.streams[0].subscription.subscribed = false;
    if (pause === 'disabled') paused.streams[0].subscription.enabled = false;
    if (pause === 'muted') paused.streams[0].subscription.muted = true;
    const resumed = structuredClone(paused);
    resumed.native!.captureSuspended = false;
    resumed.streams[0].subscription = normal.streams[0].subscription;
    collect.mockResolvedValueOnce(normal).mockResolvedValueOnce(normal).mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(paused).mockResolvedValueOnce(resumed).mockResolvedValueOnce(normal);
    const { report, exportDiagnosticReport } = setup();
    report.start(); await vi.advanceTimersByTimeAsync(10_000);
    report.stop(); await report.save('');
    const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
    expect(result.summary.segments).toHaveLength(1);
    expect(result.summary.segments[0]).toMatchObject({ sampleCount: 6, validSampleCounts: { sourceFps: 2, playbackFps: 2 },
      typicalFps: { source: 59, pageReceived: 100, pageSubmitted: 75, playback: 60,
        encodingLayers: [{ typicalFps: 58, validSamples: 2 }] },
      pageReceivedFrames: 400, pageBackpressureDroppedFrames: 100, pageBackpressureDropRate: 25 });
    if (pause === 'capture') expect(result.summary.segments[0]).toMatchObject({
      validSampleCounts: { nativeCaptureFps: 2, nativeProcessedFps: 2 }, typicalFps: { nativeCapture: 60, nativeProcessed: 50 } });
    expect(result.samples[2].streams[0]).toMatchObject({ sourceFrames: 200, sourceFps: 0,
      nativeInputInterval: { submittedFps: 0, backpressureDroppedFrames: 100 } });
    expect(result.summary.segments[0].warnings.length).toBeGreaterThan(0);
  });

it('正常运行的零帧区间仍计入摘要，本机采集暂停不能排除远端播放', async () => {
  const zero = snapshot();
  zero.streams[0].direction = '接收';
  zero.streams[0].playbackFps = 0;
  zero.streams[0].playbackIntervalMs = 2000;
  zero.native = { captureSuspended: true } as NativeCaptureDiagnostics;
  collect.mockResolvedValueOnce(zero).mockResolvedValueOnce(zero);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.summary.segments[0]).toMatchObject({ validSampleCounts: { playbackFps: 1 }, typicalFps: { playback: 0 } });
  expect(result.summary.segments[0].warnings).not.toContain('记录期间存在暂停或静音状态。');
});

it('正常发送时的零帧与背压仍计入摘要，不把卡顿过滤掉', async () => {
  const zero = snapshot();
  zero.streams[0].sourceFps = 0;
  zero.streams[0].layers[0].fps = 0;
  Object.assign(zero.streams[0].nativeInputInterval!, { receivedFrames: 100, submittedFrames: 0,
    backpressureDroppedFrames: 100, receivedFps: 50, submittedFps: 0, backpressureDropRate: 100 });
  collect.mockResolvedValueOnce(zero).mockResolvedValueOnce(zero);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.summary.segments[0]).toMatchObject({ validSampleCounts: { sourceFps: 1, pageSubmittedFps: 1 },
    typicalFps: { source: 0, pageSubmitted: 0, encodingLayers: [{ typicalFps: 0 }] }, pageBackpressureDropRate: 100 });
});

it('未知指标保留null，不把非有限数值或原始异常当成有效统计', () => {
  const input = snapshot(); input.streams[0].sourceFps = NaN;
  input.streams[0].layers[0].encoder = 'https://private/path?token=secret';
  const exported = diagnosticReportSample(input, new Map());
  expect(exported.streams[0].sourceFps).toBeNull();
  expect(exported.streams[0].layers[0].encoder).toBeNull();
  expect(exported.native).toBeNull();
});

it('新增诊断只导出版本、后端和计数，不导出会话、帧对象或附加身份字段', () => {
  const input = snapshot();
  input.native = { helperVersion: '0.1.0', captureBackend: 'windowsGraphicsCapture', state: 'running',
    sessionId: 'private-native-session', available: true, sourceKind: 'window' } as NativeCaptureDiagnostics;
  input.streams[0].nativeInput = { sessionId: 'private-session', receivedFrames: 10, submittedFrames: 7, completedWrites: 6,
    backpressureDroppedFrames: 2, suspendedDroppedFrames: 1, writeFailures: 0, placeholderFrames: 3,
    pendingWrite: true, firstFrameMs: 20 };
  Object.assign(input.streams[0].nativeInput!, { frame: { secret: 'private-frame' }, sessionId: 'private-session' });
  Object.assign(input.streams[0].subscription, { identity: 'private-identity' });
  const exported = diagnosticReportSample(input, new Map());
  expect(exported.native).toMatchObject({ helperVersion: '0.1.0', captureBackend: 'windowsGraphicsCapture' });
  expect(exported.streams[0].nativeInput).toEqual({ receivedFrames: 10, submittedFrames: 7, completedWrites: 6,
    backpressureDroppedFrames: 2, suspendedDroppedFrames: 1, writeFailures: 0, placeholderFrames: 3,
    pendingWrite: true, firstFrameMs: 20 });
  expect(exported.streams[0].layers[0].active).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/private|secret|sessionId/);
});

it('OBS 摘要分开记录宿主、页面和编码帧率，槽位丢帧只取本段增量', async () => {
  const first = snapshot();
  first.native = { helperVersion: '32.2.2', captureBackend: 'obsLibobs', state: 'running',
    sessionId: 'private-obs-session', captureSuspended: false, frameWidth: 1920, frameHeight: 1080,
    framesReceived: 200, framesProcessed: 180, obsBridgeDroppedFrames: 20 } as NativeCaptureDiagnostics;
  first.streams[0].sessionKey = 'private-obs-session';
  first.streams[0].nativeInput = { sessionId: 'private-obs-session', receivedFrames: 180, submittedFrames: 160,
    backpressureDroppedFrames: 20, suspendedDroppedFrames: 0, completedWrites: 160, writeFailures: 0,
    placeholderFrames: 0, pendingWrite: false, firstFrameMs: 30 };
  const next = structuredClone(first);
  Object.assign(next.native!, { framesReceived: 320, framesProcessed: 270, obsBridgeDroppedFrames: 50 });
  next.nativeInterval = { elapsedMs: 2000, framesReceived: 120, framesProcessed: 90, receivedFps: 60, processedFps: 45 };
  next.streams[0].sourceFps = 40;
  Object.assign(next.streams[0].nativeInput!, { receivedFrames: 264, submittedFrames: 240, backpressureDroppedFrames: 24 });
  next.streams[0].nativeInputInterval = { elapsedMs: 2000, receivedFrames: 84, submittedFrames: 80,
    backpressureDroppedFrames: 4, receivedFps: 42, submittedFps: 40, backpressureDropRate: 4.8 };
  next.streams[0].layers[0].fps = 39;
  collect.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const text = exportDiagnosticReport.mock.calls[0][0];
  const result = JSON.parse(text);
  expect(result.schemaVersion).toBe(4);
  expect(result.summary.segments).toHaveLength(1);
  expect(result.samples[0].native).toMatchObject({ helperVersion: '32.2.2', captureBackend: 'obsLibobs' });
  expect(result.summary.segments[0]).toMatchObject({ captureMode: 'obsLibobs',
    typicalFps: { nativeCapture: 60, nativeProcessed: 45, pageReceived: 42, pageSubmitted: 40,
      encodingLayers: [{ typicalFps: 39 }] } });
  expect(result.summary.segments[0].observations).toContain('记录期间 OBS 共享纹理槽位累计丢帧 30。');
  expect(result.summary.segments[0].warnings).toContain('OBS 帧计数截至宿主事件发出，不代表 Electron 已成功导入纹理或 LiveKit 已编码。');
  expect(result.samples.map((sample: { native: { obsBridgeDroppedFrames: number } }) => sample.native.obsBridgeDroppedFrames))
    .toEqual([20, 50]);
  expect(text).not.toContain('private-obs-session');
});

it('导出失败保留原记录，采样处理中不会重复启动或积压任务', async () => {
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(0); report.stop();
  exportDiagnosticReport.mockRejectedValueOnce(new Error('disk full'));
  await report.save('');
  expect(report.error.value).toContain('无法导出'); expect(report.sampleCount.value).toBe(1);
  let finish!: (sample: MediaDiagnosticsSnapshot) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  report.start();
  const count = collect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000); report.start();
  expect(collect).toHaveBeenCalledTimes(count);
  report.stop(); finish(snapshot()); await vi.advanceTimersByTimeAsync(0);
});

it('统计体积达到预算时结束，保留已收集的报告供导出', async () => {
  collect.mockImplementation(async () => {
    const result = snapshot();
    result.streams[0].layers = Array.from({ length: 1000 }, () => result.streams[0].layers[0]);
    return result;
  });
  const { report, exportDiagnosticReport } = setup();
  report.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(report.reason.value).toBe('limit');
  expect(report.sampleCount.value).toBeGreaterThan(0);
  expect(report.sampleCount.value).toBeLessThan(60);
  await report.save('');
  expect(new TextEncoder().encode(exportDiagnosticReport.mock.calls[0][0]).byteLength).toBeLessThan(8 * 1024 * 1024);
});

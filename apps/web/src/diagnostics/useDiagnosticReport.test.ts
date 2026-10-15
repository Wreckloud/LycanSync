import { effectScope, shallowRef } from 'vue';
import type { Room } from 'livekit-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaDiagnosticsSnapshot } from './mediaDiagnostics';
import { diagnosticReportSample, useDiagnosticReport } from './useDiagnosticReport';

const { collect } = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock('./mediaDiagnostics', () => ({ createMediaDiagnosticsSampler: () => ({ collect }) }));
const scopes: ReturnType<typeof effectScope>[] = [];
function snapshot(): MediaDiagnosticsSnapshot {
  return { time: new Date().toISOString(), pageVisible: true, participantCount: 1, omittedParticipants: 0,
    streams: [{ identity: 'private-user-id', name: '私人昵称', direction: '发送', target: null,
      sourceFps: 59, playbackFps: null, playbackDrops: null, layers: [{ id: 'private-track-id', size: '1920×1080',
        fps: 58, bitrateKbps: 8000, codec: 'H264', limitation: null, lostPackets: null, encoder: 'testEncoder',
        averageEncodeMs: 2, droppedFrames: null }] }],
    audio: [], process: null, native: null, failures: [] };
}
function setup() {
  const scope = effectScope(); scopes.push(scope);
  const room = shallowRef<Room | null>({} as Room);
  const settings = { quality: 'standard', inputGain: 1, outputVolume: 1, screenShareVolume: 1,
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
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); settings.quality = 'text';
  await report.save('四路略卡');
  const text = exportDiagnosticReport.mock.calls[0][0];
  expect(text).not.toContain('private-user-id'); expect(text).not.toContain('private-track-id');
  expect(text).not.toContain('私人昵称');
  const result = JSON.parse(text);
  expect(result.startSettings.quality).toBe('standard'); expect(result.endSettings.quality).toBe('economy');
  expect(result.startSettings.preset).toEqual({ width: 1920, height: 1080, maxFrameRate: 60, maxBitrate: 12_000_000 });
  expect(result.endSettings.preset).toEqual({ width: 1280, height: 720, maxFrameRate: 30, maxBitrate: 3_000_000 });
  expect(result.samples.map((sample: { requestedSettings: { quality: string } }) => sample.requestedSettings.quality)).toEqual(['standard', 'economy']);
  expect(result.samples[0].streams[0].member).toBe('member-1');
});

it('未知指标保留null，不把非有限数值或原始异常当成有效统计', () => {
  const input = snapshot(); input.streams[0].sourceFps = NaN;
  input.streams[0].layers[0].encoder = 'https://private/path?token=secret';
  const exported = diagnosticReportSample(input, new Map());
  expect(exported.streams[0].sourceFps).toBeNull();
  expect(exported.streams[0].layers[0].encoder).toBeNull();
  expect(exported.native).toBeNull();
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

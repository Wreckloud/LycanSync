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
    nativeInterval: null, obsRenderInterval: null,
    streams: [{ identity: 'private-user-id', name: '私人昵称', direction: '发送', target: null,
      nativeInput: null, subscription: { subscribed: null, enabled: null, muted: false },
      sourceFrames: 200, sourceFps: 59, sourceIntervalMs: 2000, playbackFrames: null,
      playbackFps: null, playbackIntervalMs: null, playbackDrops: null,
      nativeInputInterval: { elapsedMs: 2000, receivedFrames: 200, submittedFrames: 150,
        backpressureDroppedFrames: 50, receivedFps: 100, submittedFps: 75, backpressureDropRate: 25 },
      sessionKey: null, layers: [{ id: 'private-track-id', active: true, size: '1920×1080', frameCount: 180,
        fps: 58, intervalMs: 2000, bitrateKbps: 8000, codec: 'H264', limitation: null, lostPackets: null, encoder: 'testEncoder',
        averageEncodeMs: 2, droppedFrames: null, powerEfficientEncoder: true,
        roundTripMs: 25, receiverReportedLossPercent: 1.5, feedbackAgeMs: 20,
        receiveLossPercent: null, jitterBufferMs: null }] }],
    audio: [], process: null, native: null, failures: [] };
}
function setup(automaticDefault = false) {
  const scope = effectScope(); scopes.push(scope);
  const room = shallowRef<Room | null>({} as Room);
  const settings = { quality: 'standard', customQuality: { resolution: 1080, fps: 60 } as CustomScreenShareQuality,
    inputGain: 1, outputVolume: 1, screenShareVolume: 1,
    voiceVolumeBalance: false,
    noiseSuppression: true, autoGainControl: true, voiceEnhancement: true, echoCancellation: false,
    viewerCount: 1 };
  const exportDiagnosticReport = vi.fn(async (_text: string) => ({ saved: true }));
  vi.stubGlobal('window', { lycanDesktop: { exportDiagnosticReport } });
  const report = scope.run(() => useDiagnosticReport({ room: () => room.value, participants: () => [],
    automaticDefault, settings: () => ({ ...settings }) }))!;
  return { scope, room, settings, report, exportDiagnosticReport };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: false });
  const preferences = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => { preferences.set(key, value); } });
  collect.mockReset().mockImplementation(async () => snapshot());
});
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function persistenceBridge() {
  const bridge = window.lycanDesktop!;
  bridge.saveDiagnosticSnapshot = vi.fn(async () => 2048);
  bridge.getSavedDiagnosticReport = vi.fn(async () => ({ startedAt: '2026-10-25T00:00:00Z',
    endedAt: '2026-10-25T00:01:00Z', savedAt: '2026-10-25T00:01:00Z', clientVersion: '0.1.18', bytes: 4096 }));
  bridge.exportSavedDiagnosticReport = vi.fn(async () => ({ saved: true }));
  bridge.clearSavedDiagnosticReports = vi.fn(async () => {});
  return bridge;
}

it('复用现有采样低频保存脱敏报告，正常关闭补存，体验说明不自动落盘', async () => {
  const { report } = setup(true);
  const bridge = persistenceBridge();
  report.notes.value = 'private feedback';
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.saveDiagnosticSnapshot).toHaveBeenCalledOnce();
  expect(report.savedSizeBytes.value).toBe(2048);
  await vi.advanceTimersByTimeAsync(14000);
  expect(bridge.saveDiagnosticSnapshot).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(bridge.saveDiagnosticSnapshot).toHaveBeenCalledTimes(2);
  await report.flush();
  expect(bridge.saveDiagnosticSnapshot).toHaveBeenCalledTimes(3);
  const text = vi.mocked(bridge.saveDiagnosticSnapshot).mock.calls.at(-1)![0];
  const stored = JSON.parse(text);
  expect(stored.stopReason).toBe('closed');
  expect(stored.notes).toBe('');
  expect(stored.samples.length).toBeGreaterThan(1);
  expect(text).not.toMatch(/private feedback|private-user-id|私人昵称|private-track-id/);
  expect(report.recording.value).toBe(false);
});

it('无媒体使用只读取进程的启动不覆盖上次报告，恢复入口仍可导出', async () => {
  const { report, room } = setup(true);
  const bridge = persistenceBridge();
  room.value = null;
  collect.mockImplementation(async () => ({ ...snapshot(), roomState: null, participantCount: 0, streams: [] }));
  await vi.advanceTimersByTimeAsync(32000);
  expect(bridge.saveDiagnosticSnapshot).not.toHaveBeenCalled();
  expect(report.savedSizeBytes.value).toBeNull();
  await report.flush();
  expect(bridge.saveDiagnosticSnapshot).not.toHaveBeenCalled();
  report.notes.value = '上次使用卡顿';
  await report.savePrevious();
  expect(bridge.exportSavedDiagnosticReport).toHaveBeenCalledWith('上次使用卡顿');
});

it('持久化失败明确提示且保留内存导出；关闭开关后才可清除，旧样本不回写', async () => {
  const { report, exportDiagnosticReport } = setup(true);
  const bridge = persistenceBridge();
  vi.mocked(bridge.saveDiagnosticSnapshot).mockRejectedValueOnce(new Error('disk full'));
  await vi.advanceTimersByTimeAsync(0);
  expect(report.persistenceError.value).toContain('自动保存失败');
  expect(report.savedSizeBytes.value).toBeNull();
  await report.save('仍可导出');
  expect(exportDiagnosticReport).toHaveBeenCalledOnce();
  await report.clearSaved();
  expect(bridge.clearSavedDiagnosticReports).not.toHaveBeenCalled();
  report.setAutomatic(false);
  await report.clearSaved();
  expect(bridge.clearSavedDiagnosticReports).toHaveBeenCalledOnce();
  expect(report.sampleCount.value).toBe(0);
  expect(report.savedSizeBytes.value).toBeNull();
  const writes = vi.mocked(bridge.saveDiagnosticSnapshot).mock.calls.length;
  await vi.advanceTimersByTimeAsync(20000);
  expect(bridge.saveDiagnosticSnapshot).toHaveBeenCalledTimes(writes);
});

it('桌面首次进入默认自动记录，显式保存的关闭选择优先于默认值', async () => {
  const { scope, room, settings } = setup();
  scope.stop();
  const enter = () => {
    const next = effectScope(); scopes.push(next);
    return next.run(() => useDiagnosticReport({ room: () => room.value, participants: () => [], settings: () => settings }))!;
  };
  const first = enter();
  expect(first.automaticEnabled.value).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.sampleCount.value).toBe(1);
  first.setAutomatic(false);
  expect(enter().automaticEnabled.value).toBe(false);
});

it('自动记录在进入页面时开始，未入房、离房、再次入房和后台均继续，共用一个采样定时器', async () => {
  const { report, room, scope } = setup(true);
  expect(report.automaticEnabled.value).toBe(true);
  expect(report.recording.value).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(report.sampleCount.value).toBe(1);
  room.value = null;
  await vi.advanceTimersByTimeAsync(2000);
  expect(collect).toHaveBeenLastCalledWith(null, []);
  expect(report.recording.value).toBe(true);
  const timers = vi.getTimerCount();
  report.setViewing(true); report.setViewing(false);
  expect(vi.getTimerCount()).toBe(timers);
  vi.stubGlobal('document', { hidden: true });
  await vi.advanceTimersByTimeAsync(2000);
  expect(report.sampleCount.value).toBeGreaterThan(2);
  room.value = {} as Room;
  await vi.advanceTimersByTimeAsync(2000);
  expect(report.recording.value).toBe(true);
  scope.stop();
  const count = collect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(collect).toHaveBeenCalledTimes(count);
});

it('自动记录中导出快照不停止、不重置样本；保存等待期间继续记录，重复导出不并发', async () => {
  const { report, exportDiagnosticReport } = setup(true);
  await vi.advanceTimersByTimeAsync(2000);
  let complete!: (result: { saved: boolean }) => void;
  exportDiagnosticReport.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const saving = report.save('自动记录');
  const frozen = exportDiagnosticReport.mock.calls[0][0];
  const exported = JSON.parse(frozen);
  expect(exported.stopReason).toBe('automaticSnapshot');
  expect(exported.recordingMode).toBe('automatic');
  expect(exported.samples).toHaveLength(2);
  await report.save('重复');
  await vi.advanceTimersByTimeAsync(4000);
  expect(report.recording.value).toBe(true);
  expect(report.sampleCount.value).toBe(4);
  expect(exportDiagnosticReport).toHaveBeenCalledOnce();
  expect(exportDiagnosticReport.mock.calls[0][0]).toBe(frozen);
  complete({ saved: false }); await saving;
  expect(report.sampleCount.value).toBe(4);
  await report.save('再次导出');
  expect(JSON.parse(exportDiagnosticReport.mock.calls[1][0]).samples).toHaveLength(4);
});

it('自动开关保存选择，关闭时保留记录并丢弃在途结果，重新开启继续；新页面尊重关闭选择', async () => {
  const { report } = setup(true);
  await vi.advanceTimersByTimeAsync(0);
  let finish!: (value: MediaDiagnosticsSnapshot) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(2000);
  report.setAutomatic(false);
  expect(report.recording.value).toBe(false);
  finish(snapshot()); await vi.advanceTimersByTimeAsync(0);
  expect(report.sampleCount.value).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(report.sampleCount.value).toBe(1);
  const next = setup(true);
  expect(next.report.automaticEnabled.value).toBe(false);
  report.setAutomatic(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(report.recording.value).toBe(true);
  expect(report.sampleCount.value).toBe(2);
});

it('设置读取失败保守停用；写入失败仍允许本次关闭并说明未记住，不影响导出', async () => {
  vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => { throw new Error('read unavailable'); });
  const { report, exportDiagnosticReport } = setup(true);
  expect(report.automaticEnabled.value).toBe(false);
  expect(report.error.value).toContain('无法读取');
  report.setAutomatic(true); await vi.advanceTimersByTimeAsync(0);
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('write unavailable'); });
  report.setAutomatic(false);
  expect(report.recording.value).toBe(false);
  expect(report.error.value).toContain('本次自动诊断选择已生效');
  await report.save('');
  expect(exportDiagnosticReport).toHaveBeenCalledOnce();
});

it('自动记录超过三十分钟持续滚动且不超过900份，导出窗口首样本不混入窗外基线', async () => {
  const { report, exportDiagnosticReport } = setup(true);
  await vi.advanceTimersByTimeAsync(35 * 60_000);
  expect(report.recording.value).toBe(true);
  expect(report.sampleCount.value).toBe(900);
  expect(report.discardedSamples.value).toBeGreaterThan(0);
  await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.samples).toHaveLength(900);
  expect(result.samples[0]).toMatchObject({ elapsedMs: 0, actualIntervalMs: null, nativeInterval: null, obsRenderInterval: null });
  expect(result.samples[0].streams[0]).toMatchObject({ segmentReason: 'retained-window', sourceFps: null, layers: [{ fps: null, bitrateKbps: null }] });
  expect(result.samples.at(-1).streams[0].segmentReason).toBe('continuation');
  expect(result.samples.at(-1).elapsedMs).toBeLessThanOrEqual(30 * 60_000);
  expect(result.startedAt).toBe(result.samples[0].time);
});

it('滚动淘汰后仍区分新旧成员编号，换房另起来源段', async () => {
  collect.mockImplementation(async () => {
    const next = snapshot();
    next.streams[0].identity = `person-${collect.mock.calls.length}`;
    return next;
  });
  const { report, exportDiagnosticReport, room } = setup(true);
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  room.value = null;
  await vi.advanceTimersByTimeAsync(2000);
  room.value = {} as Room;
  await vi.advanceTimersByTimeAsync(2000);
  await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  const members = result.samples.flatMap((sample: { streams: { member: string }[] }) => sample.streams.map((stream) => stream.member));
  expect(new Set(members).size).toBe(members.length);
  expect(result.samples.at(-1).streams[0].segmentReason).toBe('initial');
});

it.each(['发送', '接收'] as const)('摘要按%s方向区分编码和解码，不把观看端当作发送端', async (direction) => {
  collect.mockImplementation(async () => {
    const next = snapshot();
    next.streams[0].direction = direction;
    return next;
  });
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000); report.stop(); await report.save('');
  const segment = JSON.parse(exportDiagnosticReport.mock.calls[0][0]).summary.segments[0];
  const expected = direction === '发送' ? '编码' : '解码';
  const unexpected = direction === '发送' ? '解码' : '编码';
  expect(segment.observations).toContain(`${expected}层 FPS 分别记录为 第 1 层 58，不跨层相加。`);
  expect(segment.observations.some((text: string) => text.startsWith(`${unexpected}层 FPS`))).toBe(false);
});

it('未入房或开始记录也能导出自动事件，不启动媒体采样', async () => {
  const { report, room, exportDiagnosticReport } = setup();
  room.value = null;
  await report.save('停止后不能再次共享');
  expect(collect).not.toHaveBeenCalled();
  const exported = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(exported.stopReason).toBe('automaticEvents');
  expect(exported.samples).toEqual([]);
  expect(Number.isFinite(Date.parse(exported.startedAt))).toBe(true);
  expect(Date.parse(exported.endedAt)).toBeGreaterThanOrEqual(Date.parse(exported.startedAt));
});

it('报告只导出诊断字段，摘要包含各阶段证据和编码网络统计，不推断硬件编码或端到端延迟', async () => {
  const next = snapshot();
  next.streams[0].layers[0].averageEncodeMs = 2.4;
  Object.assign(next.streams[0].layers[0], { receiveLossPercent: 3, jitterBufferMs: 18.5 });
  Object.assign(next.streams[0].layers[0], { address: 'private-ip-address', remoteId: 'private-remote-id' });
  collect.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(next);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000); report.stop(); await report.save('');
  const text = exportDiagnosticReport.mock.calls[0][0];
  const result = JSON.parse(text);
  expect(result.samples[1].streams[0].layers[0]).toMatchObject({ powerEfficientEncoder: true,
    roundTripMs: 25, receiverReportedLossPercent: 1.5, receiveLossPercent: 3, jitterBufferMs: 18.5 });
  const segment = result.summary.segments[0];
  expect(segment.typicalFps.encodingLayers[0]).toMatchObject({ typicalBitrateKbps: 8000, typicalEncodeMs: 2.4,
    encoderImplementations: ['testEncoder'], powerEfficientEncoderValues: [true],
    network: { typicalRoundTripMs: 25, typicalReceiverReportedLossPercent: 1.5, typicalReceiveLossPercent: 3,
      typicalJitterBufferMs: 18.5, validSamples: { receiveLoss: 1, jitterBuffer: 1 } } });
  expect(segment.evidence).toContainEqual({ stage: '网络反馈', available: true });
  expect(segment.evidence).toContainEqual({ stage: '本机播放', available: false });
  expect(result.measurements.powerEfficientEncoder).toContain('not-proof');
  expect(text).not.toMatch(/private-ip-address|private-remote-id/);
  expect(result.samples[0].streams[0].layers[0]).toMatchObject({ receiveLossPercent: null, jitterBufferMs: null });
});

it('分进程内存只导出角色、状态和数值，不泄露PID、路径或任意进程字段', () => {
  const next = snapshot();
  next.process = { cpuPercent: 2, memoryMb: 100, entries: [
    { role: 'obs', state: 'running', workingSetMiB: 20, privateCommitMiB: 30 },
    { role: 'activity', state: 'unavailable', workingSetMiB: null, privateCommitMiB: null },
  ] };
  Object.assign(next.process.entries[0], { pid: 987654, path: 'private-process-path', commandLine: 'private-command' });
  const exported = diagnosticReportSample(next, new Map());
  expect(exported.process).toEqual({ cpuPercent: 2, memoryMb: 100, entries: [
    { role: 'obs', state: 'running', workingSetMiB: 20, privateCommitMiB: 30 },
    { role: 'activity', state: 'unavailable', workingSetMiB: null, privateCommitMiB: null },
  ] });
  expect(JSON.stringify(exported)).not.toMatch(/987654|private-process-path|private-command/);
});

it('暂停、停层与恢复边界不进入诊断摘要，缺失网络反馈不当作正常网络', async () => {
  const paused = snapshot(); paused.streams[0].subscription.muted = true;
  Object.assign(paused.streams[0].layers[0], { roundTripMs: 999, receiverReportedLossPercent: 99 });
  const resumed = snapshot(); Object.assign(resumed.streams[0].layers[0], { roundTripMs: 888 });
  const active = snapshot(); Object.assign(active.streams[0].layers[0], { roundTripMs: null, receiverReportedLossPercent: null });
  collect.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(paused).mockResolvedValueOnce(resumed).mockResolvedValueOnce(active);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(6000); report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  // 初始接收报告仍是有效快照，但暂停与恢复时的极端值不得污染摘要。
  expect(result.summary.segments[0].typicalFps.encodingLayers[0].network.typicalRoundTripMs).toBe(25);
  const unavailable = snapshot(); Object.assign(unavailable.streams[0].layers[0], { roundTripMs: null, receiverReportedLossPercent: null });
  collect.mockResolvedValue(unavailable);
  report.start(); await vi.advanceTimersByTimeAsync(2000); report.stop(); await report.save('');
  const missing = JSON.parse(exportDiagnosticReport.mock.calls[1][0]).summary.segments[0];
  expect(missing.evidence).toContainEqual({ stage: '网络反馈', available: false });
  expect(missing.warnings).toContain('没有有效的新接收报告，不能据此判断发送网络正常或异常。');
});

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
  expect(result.schemaVersion).toBe(9);
  expect(result.measurements.process).toEqual({ scope: 'electron-and-owned-native-processes', memoryUnit: 'MiB',
    memoryMb: 'electron-only-sum-working-set', nativeMemory: 'GetProcessMemoryInfo; private-commit-not-resident',
    sharedPagesMayBeCountedMoreThanOnce: true, includesGpuMemory: false, includesNativeCpu: false });
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
  settings.customQuality = { resolution: 1440, fps: 120 };
  report.start(); await vi.advanceTimersByTimeAsync(0);
  settings.customQuality.fps = 60;
  await vi.advanceTimersByTimeAsync(2000);
  report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.startSettings.preset).toEqual({ width: 2560, height: 1440, maxFrameRate: 120, maxBitrate: 30_000_000 });
  expect(result.samples[1].streams[0].segmentReason).toBe('quality-change');
  expect(result.summary.segments).toHaveLength(2);
  expect(result.summary.segments[0].preset.maxFrameRate).toBe(120);
  expect(result.summary.segments[1].preset.maxFrameRate).toBe(60);
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
      placeholderFrames: 0, pendingWrite: false, firstFrameMs: 20,
      requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: false };
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
  input.native = { helperVersion: '32.2.2', captureBackend: 'obsLibobs', state: 'running',
    sessionId: 'private-native-session', available: true, sourceKind: 'window' } as NativeCaptureDiagnostics;
  input.streams[0].nativeInput = { sessionId: 'private-session', receivedFrames: 10, submittedFrames: 7, completedWrites: 6,
    backpressureDroppedFrames: 2, suspendedDroppedFrames: 1, writeFailures: 0, placeholderFrames: 3,
    pendingWrite: true, firstFrameMs: 20, requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: true };
  Object.assign(input.streams[0].nativeInput!, { frame: { secret: 'private-frame' }, sessionId: 'private-session' });
  Object.assign(input.streams[0].subscription, { identity: 'private-identity' });
  const exported = diagnosticReportSample(input, new Map());
  expect(exported.native).toMatchObject({ helperVersion: '32.2.2', captureBackend: 'obsLibobs' });
  expect(exported.streams[0].nativeInput).toEqual({ receivedFrames: 10, submittedFrames: 7, completedWrites: 6,
    backpressureDroppedFrames: 2, suspendedDroppedFrames: 1, writeFailures: 0, placeholderFrames: 3,
    pendingWrite: true, firstFrameMs: 20, requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: true });
  expect(exported.streams[0].layers[0].active).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/private|secret|sessionId/);
});

it('自动恢复失败保留最后确认帧率并在摘要提示，不把用户目标当作已应用', async () => {
  const next = snapshot();
  next.streams[0].nativeInput = { sessionId: 'session', receivedFrames: 10, submittedFrames: 7, completedWrites: 6,
    backpressureDroppedFrames: 2, suspendedDroppedFrames: 1, writeFailures: 0, placeholderFrames: 0,
    pendingWrite: false, firstFrameMs: 20, requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: true };
  collect.mockResolvedValue(next);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(2000); report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.schemaVersion).toBe(9);
  expect(result.samples[1].streams[0].nativeInput).toMatchObject({ requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: true });
  expect(result.summary.segments[0].warnings).toContain('采集帧率自动调整失败，保留最后确认的运行目标；不代表已恢复用户帧率。');
});

it('OBS 摘要分开记录宿主、页面和编码帧率，纹理桥丢帧只取本段增量', async () => {
  const first = snapshot();
  first.native = { helperVersion: '32.2.2', captureBackend: 'obsLibobs', state: 'running',
    sessionId: 'private-obs-session', captureSuspended: false, frameWidth: 1920, frameHeight: 1080,
    framesReceived: 200, framesProcessed: 180, obsBridgeDroppedFrames: 20 } as NativeCaptureDiagnostics;
  first.native.obsRender = { configuration: 1, elapsedMs: 2000, totalFrames: 120, laggedFrames: 0,
    activeFps: 60, averageRenderMs: 1 };
  Object.assign(first.native.obsRender, { windowTitle: 'private-title', luid: 'private-device' });
  first.streams[0].sessionKey = 'private-obs-session';
  first.streams[0].nativeInput = { sessionId: 'private-obs-session', receivedFrames: 180, submittedFrames: 160,
    backpressureDroppedFrames: 20, suspendedDroppedFrames: 0, completedWrites: 160, writeFailures: 0,
    placeholderFrames: 0, pendingWrite: false, firstFrameMs: 30,
    requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: false };
  const next = structuredClone(first);
  Object.assign(next.native!, { framesReceived: 320, framesProcessed: 270, obsBridgeDroppedFrames: 50 });
  Object.assign(next.native!.obsRender!, { elapsedMs: 4000, totalFrames: 240, laggedFrames: 4, averageRenderMs: 2 });
  next.obsRenderInterval = { elapsedMs: 2000, totalFrames: 120, laggedFrames: 4, renderedFps: 58, laggedPercent: 3.33 };
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
  expect(result.schemaVersion).toBe(9);
  expect(result.summary.segments).toHaveLength(1);
  expect(result.samples[0].native).toMatchObject({ helperVersion: '32.2.2', captureBackend: 'obsLibobs' });
  expect(result.summary.segments[0]).toMatchObject({ captureMode: 'obsLibobs',
    typicalFps: { nativeCapture: 60, nativeProcessed: 45, pageReceived: 42, pageSubmitted: 40,
      encodingLayers: [{ typicalFps: 39 }] } });
  expect(result.summary.segments[0].observations).toContain('记录期间 OBS 纹理桥累计丢帧 30（槽位忙或 GPU 等待跳过）。');
  expect(result.summary.segments[0].warnings).toContain('OBS 帧计数截至宿主事件发出，不代表 Electron 已成功导入纹理或 LiveKit 已编码。');
  expect(result.samples.map((sample: { native: { obsBridgeDroppedFrames: number } }) => sample.native.obsBridgeDroppedFrames))
    .toEqual([20, 50]);
  expect(text).not.toContain('private-obs-session');
  expect(text).not.toMatch(/private-title|private-device|windowTitle|luid/);
  expect(result.samples[1].obsRenderInterval).toEqual(next.obsRenderInterval);
  expect(result.samples[1].native.obsRender).toEqual({ configuration: 1, elapsedMs: 4000, totalFrames: 240,
    laggedFrames: 4, activeFps: 60, averageRenderMs: 2 });
  expect(result.summary.segments[0].obsRender).toEqual({ typicalFps: 58, typicalRenderMs: 1.5, validSamples: 1,
    averageValidSamples: 2, totalFrames: 120, laggedFrames: 4, laggedPercent: 3.33 });
  expect(result.summary.segments[0].evidence).toContainEqual({ stage: 'OBS 渲染', available: true });
});

it('相同来源与画质的 OBS 重设也另起分段，首区间及无法匹配的本机统计不混入摘要', async () => {
  const first = snapshot();
  first.native = { state: 'running', sessionId: 'private-session', captureBackend: 'obsLibobs',
    obsRender: { configuration: 1, elapsedMs: 4000, totalFrames: 240, laggedFrames: 0,
      activeFps: 60, averageRenderMs: 1 } } as NativeCaptureDiagnostics;
  first.streams[0].nativeInput = { sessionId: 'private-session' } as NonNullable<typeof first.streams[0]['nativeInput']>;
  first.obsRenderInterval = { elapsedMs: 2000, totalFrames: 120, laggedFrames: 0, renderedFps: 60, laggedPercent: 0 };
  const second = structuredClone(first);
  second.native!.obsRender!.configuration = 2;
  second.obsRenderInterval!.renderedFps = 999;
  const third = structuredClone(second);
  third.native!.sessionId = 'another-session';
  const { report, exportDiagnosticReport } = setup();
  collect.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
  report.start(); await vi.advanceTimersByTimeAsync(4000); report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.samples[1].streams[0].segmentReason).toBe('render-configuration-change');
  expect(result.samples[1].obsRenderInterval).toBeNull();
  expect(result.samples[2].nativeVideoSessionMatched).toBe(false);
  expect(result.summary.segments.every((segment: { obsRender: { typicalFps: number | null; totalFrames: number | null } }) =>
    segment.obsRender.typicalFps === null && segment.obsRender.totalFrames === null)).toBe(true);
});

it('首样本缺失的 OBS 配置在可用后补记，暂时缺失不分段也不抹掉已知编号', async () => {
  const first = snapshot();
  first.native = { state: 'running', sessionId: 'private-session', captureBackend: 'obsLibobs',
    obsRender: null } as NativeCaptureDiagnostics;
  first.streams[0].nativeInput = { sessionId: 'private-session' } as NonNullable<typeof first.streams[0]['nativeInput']>;
  const known = structuredClone(first);
  known.native!.obsRender = { configuration: 1, elapsedMs: 4000, totalFrames: 240, laggedFrames: 0,
    activeFps: 60, averageRenderMs: 1 };
  const reset = structuredClone(known);
  reset.native!.obsRender!.configuration = 2;
  reset.obsRenderInterval = { elapsedMs: 2000, totalFrames: 120, laggedFrames: 0, renderedFps: 999, laggedPercent: 0 };
  collect.mockResolvedValueOnce(first).mockResolvedValueOnce(known).mockResolvedValueOnce(structuredClone(first))
    .mockResolvedValueOnce(reset);
  const { report, exportDiagnosticReport } = setup();
  report.start(); await vi.advanceTimersByTimeAsync(6000); report.stop(); await report.save('');
  const result = JSON.parse(exportDiagnosticReport.mock.calls[0][0]);
  expect(result.samples.map((sample: { streams: { segmentReason: string }[] }) => sample.streams[0].segmentReason))
    .toEqual(['initial', 'continuation', 'continuation', 'render-configuration-change']);
  expect(result.summary.segments).toHaveLength(2);
  expect(result.samples[3].obsRenderInterval).toBeNull();
  expect(result.summary.segments[1].obsRender.typicalFps).toBeNull();
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

it('自动记录达到体积预算时淘汰旧样本而不停采样，导出仍在容量限制内', async () => {
  collect.mockImplementation(async () => {
    const result = snapshot();
    result.streams[0].layers = Array.from({ length: 1000 }, () => result.streams[0].layers[0]);
    return result;
  });
  const { report, exportDiagnosticReport } = setup(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(report.recording.value).toBe(true);
  expect(report.discardedSamples.value).toBeGreaterThan(0);
  expect(report.sampleCount.value).toBeGreaterThan(0);
  expect(report.sampleCount.value).toBeLessThan(60);
  await report.save('');
  expect(new TextEncoder().encode(exportDiagnosticReport.mock.calls[0][0]).byteLength).toBeLessThan(8 * 1024 * 1024);
});

it('自动记录跨房间时相同身份不继承上个房间的统计区间', async () => {
  const { report, room, exportDiagnosticReport } = setup(true);
  await vi.advanceTimersByTimeAsync(2000);
  room.value = {} as Room;
  await vi.advanceTimersByTimeAsync(0);
  await report.save('');
  const samples = JSON.parse(exportDiagnosticReport.mock.calls[0][0]).samples;
  expect(samples.at(-1).streams[0].member).toBe(samples[0].streams[0].member);
  expect(samples.at(-1).streams[0].segmentReason).toBe('initial');
  expect(samples.at(-1).streams[0].segmentId).not.toBe(samples[0].streams[0].segmentId);
  expect(samples.at(-1).streams[0].sourceFps).toBeNull();
  expect(samples.at(-1).streams[0].nativeInputInterval).toBeNull();
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

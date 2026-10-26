const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader } = require('./media-diagnostics.cjs');
const { EventEmitter } = require('node:events');

test('导出保留 DXGI、显卡匹配及停止方式证据，丢弃窗口名和设备标识', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lycan-dxgi-diagnostics-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  const time = new Date().toISOString();
  await writeFile(path, [
    { stage: 'obsSourceReady', captureMethod: 'dxgi', captureApi: 'DuplicateOutput', adapterIndex: 1,
      adapterMatched: true, sourceWidth: 1920, sourceHeight: 1080, monitorName: 'private-screen', luid: 'private-device' },
    { stage: 'obsHostExited', stopMode: 'forced', stopReason: 'stopTimeout' },
    { stage: 'obsCaptureHost', code: 'obsGameTargetMismatch', message: 'private-window-name' },
    { stage: 'obsCaptureConfigured', captureMethod: 'unknown-private', captureApi: 'private-api', stopMode: 'fake' },
  ].map(entry => JSON.stringify({ time, ...entry })).join('\n'));
  assert.deepEqual(await readDiagnosticEvents(path, Date.parse(time) - 1, Date.parse(time) + 1), [
    { time, stage: 'obsSourceReady', hresults: [], captureMethod: 'dxgi', captureApi: 'DuplicateOutput', adapterIndex: 1,
      adapterMatched: true, sourceWidth: 1920, sourceHeight: 1080 },
    { time, stage: 'obsHostExited', hresults: [], stopMode: 'forced', stopReason: 'stopTimeout' },
    { time, stage: 'obsCaptureHost', hresults: [], code: 'obsGameTargetMismatch' },
    { time, stage: 'obsCaptureConfigured', hresults: [] },
  ]);
});

test('权限导致的采集选择只导出布尔原因，不导出生命周期或进程身份', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lycan-window-permission-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  const time = new Date().toISOString();
  await writeFile(path, JSON.stringify({ time, stage: 'screenSourceReserved', requiresWindowCapture: true,
    lifetimeName: 'private-lifetime', processId: 12345, processCreationTime: 'private-process',
    message: 'private-window' }));
  assert.deepEqual(await readDiagnosticEvents(path, 0, Date.parse(time)), [
    { time, stage: 'screenSourceReserved', hresults: [], requiresWindowCapture: true },
  ]);
});

test('采集设置、边框授权和正常目标退出保留固定原因，不放行任意错误正文', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lycan-capture-error-codes-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  const time = new Date().toISOString();
  const codes = ['captureSettingsUnsupported', 'captureBorderAccessDenied', 'obsCaptureHostFailed',
    'obsStartupFailed', 'obsWindowRuntimeUnavailable', 'sharedTextureGpuWaitFailed', 'obsCaptureProtocolJsonInvalid',
    'captureTargetClosed', 'obsWindowBindingUnavailable', 'obsWindowTargetMismatch',
    'sharedTextureGpuStalled', 'sharedTextureReleaseFailed'];
  await writeFile(path, [...codes, 'private-code'].map(code => JSON.stringify({ time,
    stage: code === 'captureTargetClosed' ? 'screenTargetClosed' : 'screenVideoStartFailed',
    code, message: 'private-window-title-and-path' })).join('\n'));
  const events = await readDiagnosticEvents(path, 0, Date.parse(time));
  assert.deepEqual(events.slice(0, codes.length).map(entry => entry.code), codes);
  assert.equal(events.find(entry => entry.code === 'captureTargetClosed').stage, 'screenTargetClosed');
  assert.equal(events.at(-1).code, undefined);
  assert.doesNotMatch(JSON.stringify(events), /private-code|private-window/);
});

test('快照保存失败只导出固定的存储错误，不导出路径或未知错误正文', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lycan-storage-diagnostics-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  const time = new Date().toISOString();
  await writeFile(path, ['ENOSPC', 'private-path'].map(storageError =>
    JSON.stringify({ time, stage: 'diagnosticSnapshotFailed', storageError, message: 'private-path' })).join('\n'));
  const events = await readDiagnosticEvents(path, 0, Date.parse(time));
  assert.equal(events[0].storageError, 'ENOSPC');
  assert.equal(events[1].storageError, undefined);
  assert.doesNotMatch(JSON.stringify(events), /private-path/);
});

test('分进程内存复用校验后的句柄，进程退出释放，不导出PID或路径，不重复计算原生工作集', () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  let opens = 0, releases = 0, reads = 0;
  const collect = createProcessMetricsReader((pid, path) => {
    assert.equal(pid, 123); assert.equal(path, 'owned.exe'); opens++;
    return { readMemory: () => { reads++; return { workingSetBytes: 4 * 1024 ** 2, privateCommitBytes: 8 * 1024 ** 2 }; },
      release: () => { releases++; } };
  });
  const metrics = [{ type: 'GPU', pid: 999, memory: { workingSetSize: 2048, privateBytes: 1024 }, cpu: { percentCPUUsage: 2.1 } }];
  const helpers = [{ role: 'obs', children: [child], executablePath: 'owned.exe' }, { role: 'media', children: [] }];
  const first = collect(metrics, helpers, true);
  assert.deepEqual(first, { cpuPercent: 2.1, memoryMb: 2, entries: [
    { role: 'electron-GPU', state: 'running', workingSetMiB: 2, privateCommitMiB: 1 },
    { role: 'obs', state: 'running', workingSetMiB: 4, privateCommitMiB: 8 },
    { role: 'media', state: 'stopped', workingSetMiB: null, privateCommitMiB: null },
  ] });
  collect(metrics, helpers, true);
  assert.equal(opens, 1); assert.equal(reads, 2);
  child.exitCode = 0; child.emit('close');
  assert.equal(releases, 1);
  assert.equal(collect(metrics, helpers, true).entries[1].state, 'stopped');
  assert.equal(opens, 1);
  assert.ok(!JSON.stringify(first).includes('pid'));
  assert.ok(!JSON.stringify(first).includes('owned.exe'));
});

test('原生读取失败和平台不支持均为不可用，不伪报未运行或零内存，不会启动进程', () => {
  let opens = 0;
  const collect = createProcessMetricsReader(() => { opens++; throw new Error('identity mismatch'); });
  const helpers = [{ role: 'activity', children: [Object.assign(new EventEmitter(), { pid: 12 })], executablePath: 'activity.exe' }];
  const result = collect([], helpers, true);
  assert.deepEqual(result.entries, [{ role: 'activity', state: 'unavailable', workingSetMiB: null, privateCommitMiB: null }]);
  collect([], helpers, false);
  assert.equal(opens, 1);
  const invalid = createProcessMetricsReader(() => ({ readMemory: () => ({ workingSetBytes: NaN, privateCommitBytes: -1 }), release() {} }));
  assert.equal(invalid([], helpers, true).entries[0].state, 'unavailable');
});

test('诊断IPC只读取现存的三类子进程，不接受页面指定PID和不可信来源', () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('diagnostics:process-metrics'");
  const end = main.indexOf("ipcMain.handle('diagnostics:checkpoint'", start);
  let handler, captured;
  const scope = {
    ipcMain: { handle: (_name, callback) => { handler = callback; } }, trustedSender: (event) => event.trusted,
    app: { getAppMetrics: () => ['electron'] }, obsCaptureHost: { state: { child: 'obs-child' } },
    obsHostSettings: { executablePath: 'obs.exe' }, mediaHelper: { children: new Set([{ child: 'media-child' }]) },
    mediaHelperPath: () => 'media.exe', activityMonitor: { diagnosticProcesses: () => ['activity-child'] },
    activityHelperPath: () => 'activity.exe', process: { platform: 'win32' },
    readProcessMetrics: (...args) => { captured = JSON.parse(JSON.stringify(args)); return 'result'; },
  };
  runInNewContext(main.slice(start, end), scope);
  assert.throws(() => handler({ trusted: false }, 12345), /无效/);
  assert.equal(handler({ trusted: true }, 12345), 'result');
  assert.deepEqual(captured, [['electron'], [
    { role: 'obs', children: ['obs-child'], executablePath: 'obs.exe' },
    { role: 'media', children: ['media-child'], executablePath: 'media.exe' },
    { role: 'activity', children: ['activity-child'], executablePath: 'activity.exe' },
  ], true]);
});

test('启动计时只接受当前可信采集会话和固定阶段，每阶段只记录一次', () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.on('media:screen-share-startup'");
  const end = main.indexOf("ipcMain.handle('media:native-video:stop'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const entries = [];
  const state = { closing: false, nativeVideoSession: { sessionId: 'current', starting: false, stopping: false },
    trustedSender: event => event.trusted, writeMediaDiagnostic: async entry => entries.push(entry),
    ipcMain: { on: (_name, callback) => { handler = callback; } } };
  runInNewContext(main.slice(start, end), state);
  const send = (sessionId = 'current', stage = 'screenVideoFirstFrame', duration = 551.7, trusted = true, audioTiming) =>
    handler({ trusted }, sessionId, stage, duration, audioTiming);
  send('old');
  send('current', 'arbitraryLog');
  send('current', 'screenVideoFirstFrame', 10, false);
  for (const duration of [-1, Infinity, NaN, 300001, '500', {}]) send('current', 'screenVideoFirstFrame', duration);
  state.nativeVideoSession.starting = true;
  send();
  state.nativeVideoSession.starting = false;
  state.nativeVideoSession.stopping = true;
  send();
  state.nativeVideoSession.stopping = false;
  state.closing = true;
  send();
  assert.equal(entries.length, 0);
  state.closing = false;
  send();
  send('current', 'screenVideoFirstFrame', 999);
  send('current', 'screenVideoPublished', 630.2);
  const audioTiming = { outcome: 'published', phase: 'publish', pluginLoadMs: 12.4, captureReadyMs: 340,
    graphReadyMs: 20, publishMs: 50, windowTitle: 'private-window' };
  send('current', 'screenAudioReady', 2120.4);
  send('current', 'screenAudioStartup', 500);
  send('current', 'screenAudioStartup', 500, true, { ...audioTiming, outcome: 'unknown' });
  for (const value of [NaN, -1, Infinity, 300001, '5']) {
    send('current', 'screenAudioStartup', 500, true, { ...audioTiming, graphReadyMs: value });
  }
  send('current', 'screenAudioStartup', 500.4, true, audioTiming);
  send('current', 'screenAudioStartup', 700, true, { outcome: 'failed', phase: 'capture' });
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    { stage: 'screenVideoFirstFrame', durationMs: 552 },
    { stage: 'screenVideoPublished', durationMs: 630 },
    { stage: 'screenAudioStartup', durationMs: 500, outcome: 'published', phase: 'publish',
      pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: 20, publishMs: 50 },
  ]);
  state.nativeVideoSession = { sessionId: 'next', starting: false, stopping: false };
  send();
  send('next');
  assert.equal(entries.length, 4);
  assert.doesNotMatch(JSON.stringify(entries), /current|next|sessionId|private-window|windowTitle/);
  send('next', 'screenAudioStartup', 100, true, { outcome: 'failed', phase: 'graph', pluginLoadMs: 0, captureReadyMs: 10 });
  assert.deepEqual(JSON.parse(JSON.stringify(entries.at(-1))), { stage: 'screenAudioStartup', durationMs: 100,
    outcome: 'failed', phase: 'graph', pluginLoadMs: 0, captureReadyMs: 10 });
  const beforeFailure = entries.length;
  send('old', 'screenVideoStartupFailed', 100, true, { code: 'nativeVideoFirstFrameTimeout' });
  send('next', 'screenVideoStartupFailed', 100, true, { code: 'private-body' });
  assert.equal(entries.length, beforeFailure);
  send('next', 'screenVideoStartupFailed', 100, true, { code: 'nativeVideoFirstFrameTimeout', message: 'private-body' });
  send('next', 'screenVideoStartupFailed', 200, true, { code: 'nativeVideoFirstFrameTimeout' });
  assert.equal(entries.length, beforeFailure + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(entries.at(-1))), { stage: 'screenVideoStartupFailed',
    durationMs: 100, code: 'nativeVideoFirstFrameTimeout' });
});

test('preload 的启动计时只转发固定 IPC，不向页面开放任意日志通道', () => {
  let desktop;
  const calls = [];
  runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => {
      if (name === 'lycanDesktop') desktop = value;
    } }, ipcRenderer: { on() {}, send: (...args) => calls.push(args) } }),
  });
  desktop.recordScreenShareStartupTiming('capture', 'screenVideoPublished', 630);
  const timing = { outcome: 'failed', phase: 'capture' };
  desktop.recordScreenShareStartupTiming('capture', 'screenAudioStartup', 400, timing);
  assert.deepEqual(calls, [['media:screen-share-startup', 'capture', 'screenVideoPublished', 630, undefined],
    ['media:screen-share-startup', 'capture', 'screenAudioStartup', 400, timing]]);
});

test('启动前桥接或来源失败也记录终止阶段，不泄露来源，并保留失败而不报成功', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('media:native-video:start'");
  const end = main.indexOf("ipcMain.on('media:screen-share-startup'", start);
  let handler;
  const entries = [];
  const failure = new Error('nativeVideoBridgeUnavailable');
  const sandbox = { performance, closing: false, trustedSender: event => event.trusted,
    startNativeVideo: async () => { throw failure; }, writeMediaDiagnostic: async entry => entries.push(entry),
    ipcMain: { handle: (_name, callback) => { handler = callback; } } };
  runInNewContext(main.slice(start, end), sandbox);
  assert.throws(() => handler({ trusted: false }, 'private-window'), /无效/);
  assert.equal(entries.length, 0);
  await assert.rejects(handler({ trusted: true }, 'private-window'), error => error === failure);
  assert.equal(entries[0].stage, 'screenVideoStartFailed');
  assert.equal(entries[0].code, 'nativeVideoBridgeUnavailable');
  assert.doesNotMatch(JSON.stringify(entries), /private-window/);
});

test('声音启动只导出固定摘要字段，缺失阶段不补零，不泄露附加正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-audio-startup-'));
  try {
    const path = join(directory, 'error.log');
    const time = '2026-10-20T00:00:01.000Z';
    const base = { time, stage: 'screenAudioStartup', durationMs: 500, outcome: 'failed', phase: 'graph',
      pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: -1, publishMs: 'not measured',
      title: 'private-window', error: 'private-message' };
    await writeFile(path, JSON.stringify(base));
    assert.deepEqual(await readDiagnosticEvents(path, 0, Date.parse(time)), [{ time, stage: 'screenAudioStartup',
      durationMs: 500, hresults: [], outcome: 'failed', phase: 'graph', pluginLoadMs: 12, captureReadyMs: 340 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('故障日志串行写入并轮转，保留最近一份历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-diagnostics-'));
  try {
    const path = join(directory, 'nested', 'screen-share-error.log');
    const write = createMediaDiagnostics(path, 200);
    await Promise.all([write({ stage: 'first', message: 'a'.repeat(80) }),
      write({ stage: 'second', message: 'b'.repeat(80) }),
      write({ stage: 'third', message: 'c'.repeat(80) })]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).stage, 'third');
    assert.equal(JSON.parse(await readFile(`${path}.previous`, 'utf8')).stage, 'second');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('重复宿主警告合并计数，不新增定时器，导出前刷新且不吞掉不同错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-dedup-'));
  try {
    const path = join(directory, 'error.log');
    const write = createMediaDiagnostics(path);
    await Promise.all(Array.from({ length: 50 }, () => write({ stage: 'obsCaptureHostStderr', message: 'same warning' })));
    await write({ stage: 'obsCaptureHostStderr', message: 'different warning' });
    await write({ stage: 'screenVideoStartupFailed', code: 'nativeVideoFirstFrameTimeout' });
    await write.flush();
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.length, 4);
    assert.equal(entries.at(-1).repeatCount, 49);
    assert.ok(entries.some(entry => entry.code === 'nativeVideoFirstFrameTimeout'));
    const exported = await readDiagnosticEvents(path, 0, Date.now());
    assert.ok(exported.some(entry => entry.repeatCount === 49));
    assert.ok(exported.some(entry => entry.code === 'nativeVideoFirstFrameTimeout'));
    assert.doesNotMatch(JSON.stringify(exported), /same warning|different warning/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('自动启动与共享事件导出保留有效字段，附加正文和未知错误不进入报告', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-events-'));
  try {
    const path = join(directory, 'error.log');
    const write = createMediaDiagnostics(path);
    await write({ stage: 'applicationReady', appVersion: '0.1.10', electronVersion: '44.2.0', osVersion: '10.0.19045',
      platform: 'win32', arch: 'x64', account: 'private-account' });
    await write({ stage: 'screenVideoStartRequested', sourceKind: 'window', width: 1920, height: 1080, maxFps: 60,
      title: 'private-window', sessionId: 'private-session' });
    await write({ stage: 'screenVideoStopFailed', code: 'private-secret', message: 'private-message' });
    const events = await readDiagnosticEvents(path, 0, Date.now());
    assert.equal(events[0].appVersion, '0.1.10');
    assert.equal(events[1].width, 1920);
    assert.equal(events[1].sourceKind, 'window');
    assert.equal(events[2].code, undefined);
    assert.doesNotMatch(JSON.stringify(events), /private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('报告日志只保留时间/阶段/HRESULT，忽略坏行并限制数量与时间范围', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-report-'));
  try {
    const path = join(directory, 'error.log');
    const time = '2026-10-15T00:00:01.000Z';
    const entry = { time, stage: 'helperStderr', message: 'private-user https://server/#token=secret C:\\private 0x80070005',
      sessionId: 'private-session', durationMs: 3 };
    await writeFile(path, ['null', 'invalid-json', ...Array(250).fill(JSON.stringify(entry)),
      JSON.stringify({ ...entry, time: '2026-10-14T00:00:00Z' })].join('\n'));
    const events = await readDiagnosticEvents(path, Date.parse('2026-10-15T00:00:00Z'), Date.parse('2026-10-15T00:00:02Z'));
    assert.equal(events.length, 200);
    assert.deepEqual(events[0], { time, stage: 'helperStderr', hresults: ['0x80070005'], durationMs: 3 });
    assert.doesNotMatch(JSON.stringify(events), /secret|private|token|server/);
    assert.deepEqual(await readDiagnosticEvents(join(directory, 'missing'), 0, Date.now()), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function exportFixture() {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('diagnostics:export'");
  const end = main.indexOf("ipcMain.handle('presence:system-idle-state'", start);
  assert.ok(start >= 0 && end > start);
  let exportReport;
  const calls = { read: 0, dialog: 0, writes: [], ranges: [], flushed: 0, exportDirectory: null, dialogOptions: null };
  const state = { closing: false, diagnosticExportPending: false, trustedSender: () => true,
    diagnosticStartedAt: Date.parse('2026-10-14T00:00:00Z'), writeMediaDiagnostic: { flush: async () => { calls.flushed++; } },
    Buffer, JSON, Date, Error, resolve: join, mainWindow: {}, process: { versions: { electron: 'test' }, platform: 'win32', arch: 'x64' },
    osRelease: () => 'test-os', app: { getPath: () => '/private', getVersion: () => 'test-version', getGPUFeatureStatus: () => ({ video_encode: 'enabled' }) },
    readDiagnosticEvents: async (_path, start, end) => {
      calls.read++; calls.ranges.push([start, end]); assert.ok(calls.flushed >= calls.read);
      return [{ stage: 'test' }];
    },
    mkdir: async directory => { calls.exportDirectory = directory; },
    dialog: { showSaveDialog: async (_window, options) => {
      calls.dialog++; calls.dialogOptions = options; return { canceled: false, filePath: '/selected/report.json' };
    } },
    writeFile: async (...args) => { calls.writes.push(args); },
    ipcMain: { handle: (_name, callback) => { exportReport = callback; } },
  };
  runInNewContext(main.slice(start, end), state);
  const text = JSON.stringify({ kind: 'lycansync-diagnostics', schemaVersion: 9,
    startedAt: '2026-10-15T00:00:00Z', endedAt: '2026-10-15T00:00:01Z', samples: [] });
  return { state, calls, text, exportReport: (...args) => exportReport(...args) };
}

test('诊断导出仅允许可信页面，验证格式并通过用户选址写入，不泄露系统路径', async () => {
  const { state, calls, text, exportReport } = exportFixture();
  state.trustedSender = () => false;
  await assert.rejects(exportReport({}, text), /不能导出/);
  assert.equal(calls.read, 0);
  state.trustedSender = () => true;
  await assert.rejects(exportReport({}, '{}'), /无效/);
  await assert.rejects(exportReport({}, text.replace('"schemaVersion":9', '"schemaVersion":8')), /无效/);
  await assert.rejects(exportReport({}, 'x'.repeat(8 * 1024 * 1024 + 1)), /过大/);
  await exportReport({}, text);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0][0], '/selected/report.json');
  assert.equal(calls.exportDirectory, join('/private', 'exports'));
  assert.ok(calls.dialogOptions.defaultPath.startsWith(join('/private', 'exports') + require('node:path').sep));
  const report = JSON.parse(calls.writes[0][1]);
  assert.equal(calls.ranges[0][0], state.diagnosticStartedAt);
  assert.ok(calls.ranges[0][1] > Date.parse(report.endedAt));
  assert.equal(Date.parse(report.eventWindow.endedAt), calls.ranges[0][1]);
  assert.equal(report.environment.appVersion, 'test-version');
  assert.equal(report.environment.gpuUtilization, null);
  assert.equal(Object.hasOwn(report.environment, 'helperVersion'), false);
  assert.doesNotMatch(calls.writes[0][1], /\/private|\/selected/);
});

test('选址取消或关闭期间迟到结果不写入，保存失败后仍可重试', async () => {
  const { state, calls, text, exportReport } = exportFixture();
  state.dialog.showSaveDialog = async () => ({ canceled: true });
  await exportReport({}, text);
  assert.equal(calls.writes.length, 0);
  state.dialog.showSaveDialog = async () => { state.closing = true; return { canceled: false, filePath: '/selected/report.json' }; };
  await exportReport({}, text);
  assert.equal(calls.writes.length, 0);
  state.closing = false;
  state.dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/selected/report.json' });
  state.writeFile = async () => { throw new Error('disk full'); };
  await assert.rejects(exportReport({}, text), /disk full/);
  assert.equal(state.diagnosticExportPending, false);
  state.writeFile = async (...args) => { calls.writes.push(args); };
  await exportReport({}, text);
  assert.equal(calls.writes.length, 1);
});

test('默认导出目录准备期间关闭窗口，不再弹出迟到的保存对话框', async () => {
  const { state, calls, text, exportReport } = exportFixture();
  state.mkdir = async () => { state.closing = true; };
  await exportReport({}, text);
  assert.equal(calls.dialog, 0);
  assert.equal(calls.writes.length, 0);
});

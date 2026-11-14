const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { ObsCaptureHostManager } = require('./obs-capture-host.cjs');

const sessionId = '12345678-1234-1234-1234-123456789abc';
const monitorName = '\\\\.\\DISPLAY2';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const idleAudio = { state: 'idle', sampleRate: null, channels: null, packetsReceived: 0, framesReceived: 0,
  silentPackets: 0, droppedAudioChunks: 0, lastError: null };
const obsRender = { configuration: 1, elapsedMs: 4000, totalFrames: 240, laggedFrames: 2, activeFps: 59.5, averageRenderMs: 1.25 };

function fixture(context, { closeOnShutdown = true, closeOnKill = true, blockShutdownWrite = false, shutdownDelayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const commands = [];
  const captureCommands = [];
  const spawns = [];
  const failures = [];
  const audioFailures = [];
  const captureDiagnostics = [];
  let kills = 0;
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const command = chunk.toString('utf8').trim();
    if (command.startsWith('start|')) captureCommands.push(command);
    else commands.push(command);
    if ((command === 'shutdown' || command.startsWith('stop:')) && blockShutdownWrite) return;
    callback();
    if (command.startsWith('stop:') && closeOnShutdown) {
      const stopped = () => child.stdout.write(JSON.stringify({ event: 'captureStopped', sessionId: command.slice(5) }) + '\n');
      if (shutdownDelayMs) setTimeout(stopped, shutdownDelayMs);
      else queueMicrotask(stopped);
    }
    if (command === 'shutdown' && closeOnShutdown) {
      if (shutdownDelayMs) setTimeout(() => child.emit('close', 0), shutdownDelayMs);
      else queueMicrotask(() => child.emit('close', 0));
    }
  } });
  child.kill = () => {
    kills++;
    if (closeOnKill) queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  const frames = [];
  const manager = new ObsCaptureHostManager({ executablePath: 'C:\\obs\\host.exe', modulePath: 'C:\\obs\\win-capture.dll',
    dataPath: 'C:\\obs\\data', configPath: 'C:\\user-data\\obs-capture\\32.2.2',
    platform: 'win32', clientProcessId: 4321, spawnProcess: (...args) => {
      spawns.push(args);
      queueMicrotask(() => child.stdout.write('{"event":"coreReady"}\n'));
      return child;
    },
    onAudioFailure: (_state, failure) => audioFailures.push(failure),
    onCaptureDiagnostic: (_state, entry) => captureDiagnostics.push(entry),
    onFrame: (_state, frame) => frames.push(frame), onFailure: (_state, error) => failures.push(error.message) });
  const emit = (event) => {
    const output = () => child.stdout.write(JSON.stringify(event.event === 'diagnostics'
    ? { screenShareAudio: { ...idleAudio }, obsRender: { ...obsRender }, ...event }
    : ['captureConfigured', 'captureConfigurationRejected'].includes(event.event)
      ? { width: 1920, height: 1080, ...event } : { sessionId, ...event }) + '\n');
    if (event.event === 'captureStarted') queueMicrotask(output);
    else output();
  };
  const start = (maxFps = 60) => manager.start('monitor:7:0', maxFps, sessionId,
    { kind: 'monitor', monitorName }, { hideCursor: true, hideBorder: false });
  const ready = async (maxFps = 60) => {
    const started = start(maxFps);
    emit({ event: 'captureStarted', helperVersion: '32.2.2' });
    await started;
  };
  context.after(() => {
    if (manager.state) manager.state.shuttingDown = true;
    child.emit('close', 0);
  });
  return { child, commands, captureCommands, spawns, failures, audioFailures, captureDiagnostics, frames, manager, emit, start, ready, killCount: () => kills };
}

function adapterFixture(context) {
  const children = [], diagnostics = [], failures = [];
  const emit = (child, event) => child.stdout.write(JSON.stringify({ sessionId, ...event }) + '\n');
  const manager = new ObsCaptureHostManager({ executablePath: 'C:\\obs\\host.exe', modulePath: 'C:\\obs\\win-capture.dll',
    dataPath: 'C:\\obs\\data', configPath: 'C:\\user-data\\obs', platform: 'win32',
    onCaptureDiagnostic: (_state, entry) => diagnostics.push(entry), onFailure: (_state, error) => failures.push(error.message),
    spawnProcess: (_path, args) => {
      const child = Object.assign(new EventEmitter(), { pid: 1234 + children.length, args, commands: [],
        stdout: new PassThrough(), stderr: new PassThrough(), kills: 0 });
      child.stdin = new Writable({ write(chunk, _encoding, callback) { child.commands.push(String(chunk).trim()); callback(); } });
      child.kill = () => { child.kills++; return true; };
      children.push(child);
      queueMicrotask(() => emit(child, { event: 'coreReady' }));
      return child;
    } });
  const start = () => manager.start('monitor:7:0', 120, sessionId, { kind: 'monitor', monitorName },
    { hideCursor: true, hideBorder: true }, { width: 2560, height: 1440 });
  context.after(() => { for (const child of children) child.emit('close', 0); });
  return { manager, children, diagnostics, failures, start, emit };
}

test('录像输出只接受当前会话，文件路径用有界协议传递，停止确认保留真实帧数', async context => {
  const f = fixture(context); await f.ready();
  const id = '12345678-1234-1234-1234-123456789001';
  const starting = f.manager.startRecording(sessionId, id, 'C:\\recordings\\test.mkv', false, true);
  f.emit({ event: 'recordingStarted', recordingId: 'old' });
  assert.ok(f.manager.state.recording);
  f.emit({ event: 'recordingStarted', recordingId: id, width: 1220, height: 786, configuredFrameRate: 60,
    encoder: 'nvenc', configuredRateControl: 'CQP', configuredLookahead: false });
  assert.deepEqual(await starting, { changed: true, width: 1220, height: 786, frameRate: 60,
    encoder: 'nvenc', configuredRateControl: 'CQP', configuredLookahead: false });
  assert.ok(f.commands.some(command => command.startsWith(`recordStart|${id}|`) && command.endsWith(`|01|${id}|1080|60`)));
  assert.equal(f.commands.some(command => command.includes('C:\\recordings')), false);
  const stopping = f.manager.stopRecording(sessionId, id);
  f.emit({ event: 'recordingStopped', recordingId: id, outputFrames: 120, code: 'recordingDiskFull' });
  assert.equal((await stopping).outputFrames, 120);
  assert.equal(f.manager.state.recording, undefined);
});

test('回放保存绑定当前来源和快照身份，旧回复不能结束新任务，停止录像保留回放', async context => {
  const f = fixture(context); await f.ready();
  const id = '12345678-1234-1234-1234-123456789001';
  const file = '12345678-1234-1234-1234-123456789002';
  const profile = { videoHeight: 1080, videoFps: 60 };
  const starting = f.manager.startReplay(sessionId, id, 60, true, false, id, profile);
  f.emit({ event: 'replayStarted', replayId: id, width: 1920, height: 1080, configuredFrameRate: 60, memoryBudgetMb: 512 });
  const started = await starting;
  assert.equal(started.frameRate, 60); assert.equal(started.memoryBudgetMb, 512);
  const recording = f.manager.startRecording(sessionId, file, 'C:\\recordings\\file.mkv', true, false, id, profile);
  f.emit({ event: 'recordingStarted', recordingId: file }); await recording;
  const stopped = f.manager.stopRecording(sessionId, file);
  f.emit({ event: 'recordingStopped', recordingId: file, outputFrames: 10 }); await stopped;
  assert.equal(f.manager.state.replay.id, id);
  const saving = f.manager.saveReplay(sessionId, id, file, 'C:\\recordings\\replay.mkv');
  await assert.rejects(f.manager.saveReplay(sessionId, id, file, 'C:\\recordings\\another.mkv'), /recordingBusy/);
  f.emit({ event: 'replaySaved', replayId: id, saveId: 'old' });
  assert.equal(f.manager.state.replay.save.id, file);
  f.emit({ event: 'replaySaved', replayId: id, saveId: file }); await saving;
  assert.equal(f.manager.state.replay.save, undefined);
  assert.ok(f.commands.some(command => command.startsWith(`replaySave|${file}|`) && !command.includes('recordings')));
  const closing = f.manager.stopReplay(sessionId, id);
  f.emit({ event: 'replayStopped', replayId: id }); await closing;
  assert.equal(f.manager.state.replay, undefined);
});

test('宿主退出拒绝进行中的回放保存并解除输出资源，不假报保存成功', async context => {
  const f = fixture(context); await f.ready();
  const id = '12345678-1234-1234-1234-123456789001';
  const starting = f.manager.startReplay(sessionId, id, 30, false, false, id, { videoHeight: 720, videoFps: 30 });
  f.emit({ event: 'replayStarted', replayId: id, width: 1280, height: 720 }); await starting;
  const saving = f.manager.saveReplay(sessionId, id, id, 'C:\\recordings\\replay.mkv');
  const rejected = assert.rejects(saving, /recordingHostExited/);
  f.child.emit('close', 1); await rejected;
});

test('窗口测试模式即使运行整个设备测试文件也不会注册可执行的整屏用例', () => {
  const source = readFileSync(join(__dirname, 'obs-capture.test.cjs'), 'utf8');
  for (const mode of ['LYCANSYNC_CAPTURE_WINDOW_CHECK', 'LYCANSYNC_CAPTURE_GAME_CHECK', 'LYCANSYNC_CAPTURE_APPLICATION_CHECK', undefined]) {
    const registered = [];
    runInNewContext(source, { __dirname, process: { env: { LYCANSYNC_RUN_OBS_CAPTURE_TEST: '1', ...(mode ? { [mode]: '1' } : {}) } },
      require: id => id === 'node:test' ? { test: (name, options) => registered.push({ name, options }) } : require(id) });
    const monitor = registered.find(entry => entry.name.startsWith('OBS 真实宿主固定三槽'));
    assert.equal(Boolean(monitor.options.skip), Boolean(mode));
    assert.equal(registered.length, 2);
  }
});

test('设置拒绝返回固定原因，保留宿主供下次共享，不通知运行时故障', async context => {
  for (const code of ['captureBorderUnsupported', 'captureBorderAccessDenied', 'captureSettingsUnsupported']) {
    const f = fixture(context);
    const rejected = assert.rejects(f.start(), new RegExp(code));
    await flush();
    f.emit({ event: 'captureRejected', code });
    await rejected;
    assert.equal(f.manager.state.videoSessionId, undefined);
    assert.equal(f.manager.state.startSent, false);
    assert.equal(f.killCount(), 0);
    assert.deepEqual(f.failures, []);
    assert.equal(f.captureDiagnostics.at(-1).code, code);
    const next = '00000000-0000-0000-0000-000000000009';
    const started = f.manager.start('monitor:7:0', 60, next, { kind: 'monitor', monitorName }, { hideCursor: true, hideBorder: true });
    f.emit({ event: 'captureStarted', sessionId: next, helperVersion: '32.2.2' });
    await started;
    f.emit({ event: 'captureRejected', code });
    assert.equal(f.manager.state.videoSessionId, next);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.killCount(), 0);
  }
});

test('设置拒绝与主动停止重叠，空闲确认完成清理，不等待超时杀宿主', async context => {
  const f = fixture(context, { closeOnShutdown: false });
  const rejected = assert.rejects(f.start(), /obsCaptureStopping/);
  await flush();
  const stopped = f.manager.stop(sessionId);
  f.emit({ event: 'captureRejected', code: 'captureBorderUnsupported' });
  await Promise.all([rejected, stopped]);
  assert.equal(f.manager.state.videoSessionId, undefined);
  assert.equal(f.manager.state.stopRequested, false);
  assert.equal(f.killCount(), 0);
  assert.deepEqual(f.failures, []);
});

test('拒绝事件不放行未知错误、错误会话和已经启动的采集', async context => {
  for (const variation of ['code', 'session', 'started']) {
    const f = fixture(context);
    if (variation === 'started') await f.ready();
    const rejected = variation === 'started' ? undefined : assert.rejects(f.start(), /obsCaptureProtocolEventInvalid/);
    await flush();
    f.emit({ event: 'captureRejected', code: variation === 'code' ? 'private-error' : 'captureBorderUnsupported',
      ...(variation === 'session' ? { sessionId: '00000000-0000-0000-0000-000000000009' } : {}) });
    await rejected;
    assert.equal(f.killCount(), 1);
    assert.deepEqual(f.failures, ['obsCaptureProtocolEventInvalid']);
  }
});

test('目标关闭等待正常停止确认，不杀宿主；复用后仍报告真正错误，旧结束事件无效', async context => {
  const f = fixture(context);
  await f.ready();
  f.emit({ event: 'captureTargetClosed' });
  await flush();
  assert.equal(f.killCount(), 0);
  assert.notEqual(f.manager.state.failed, true);
  assert.equal(f.manager.state.videoSessionId, undefined);
  assert.ok(f.captureDiagnostics.some(entry => entry.stage === 'obsCaptureStopped' && entry.stopMode === 'graceful'));
  assert.deepEqual(f.failures, ['captureTargetClosed']);
  const next = '00000000-0000-0000-0000-000000000007';
  const started = f.manager.start('monitor:7:0', 60, next, { kind: 'monitor', monitorName }, { hideCursor: true, hideBorder: true });
  f.emit({ event: 'captureStarted', sessionId: next, helperVersion: '32.2.2' });
  await started;
  f.emit({ event: 'captureTargetClosed', sessionId });
  assert.equal(f.manager.state.videoSessionId, next);
  f.emit({ event: 'obsGameTargetMismatch', sessionId: next });
  assert.deepEqual(f.failures, ['captureTargetClosed', 'obsGameTargetMismatch']);
  assert.equal(f.killCount(), 1);
});

test('主动停止期间的目标退出不通知故障，仍等待原停止确认', async context => {
  const f = fixture(context, { closeOnShutdown: false });
  await f.ready();
  const stopped = f.manager.stop(sessionId);
  f.emit({ event: 'captureTargetClosed' });
  assert.deepEqual(f.failures, []);
  assert.equal(f.killCount(), 0);
  f.emit({ event: 'captureStopped' });
  await stopped;
  assert.equal(f.manager.state.videoSessionId, undefined);
});

test('录像提高渲染帧率但保留共享30帧，最后一路结束后恢复共享预算', async context => {
  const f = fixture(context);
  await f.ready(30);
  const preparing = f.manager.setRecordingFrameRate(sessionId, 60);
  assert.equal(f.commands.at(-1), 'configure:1:30:1920:1080:60');
  f.emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 30 });
  await preparing;
  assert.equal(f.manager.state.maxFps, 30);
  assert.equal(f.manager.state.recordingFps, 60);
  const starting = f.manager.startRecording(sessionId, sessionId, 'C:\\recordings\\test.mkv', false);
  f.emit({ event: 'recordingStarted', recordingId: sessionId, configuredFrameRate: 60 });
  await starting;
  await assert.rejects(f.manager.setRecordingFrameRate(sessionId, 0), /recordingBusy/);
  const stopping = f.manager.stopRecording(sessionId, sessionId);
  f.emit({ event: 'recordingStopped', recordingId: sessionId, outputFrames: 600 });
  await stopping;
  const restoring = f.manager.setRecordingFrameRate(sessionId, 0);
  assert.equal(f.commands.at(-1), 'configure:2:30:1920:1080:30');
  f.emit({ event: 'captureConfigured', requestId: '2', sessionId, maxFps: 30 });
  await restoring;
  assert.equal(f.manager.state.recordingFps, 0);
  assert.equal(f.killCount(), 0);
});

test('目标关闭先等待主进程录制收尾，重复关闭事件不抢先停止宿主', async context => {
  const { manager, ready, emit, commands, killCount } = fixture(context);
  let finishRecording;
  let notified = 0;
  manager.onFailure = () => {
    notified++;
    return new Promise(resolve => { finishRecording = resolve; });
  };
  await ready();
  emit({ event: 'captureTargetClosed' });
  emit({ event: 'captureTargetClosed' });
  await flush();
  assert.equal(notified, 1);
  assert.equal(commands.some(command => command.startsWith('stop:')), false);
  finishRecording();
  await flush();
  assert.equal(commands.filter(command => command.startsWith('stop:')).length, 1);
  assert.equal(killCount(), 0);
});

test('目标关闭时给录像留足原生收尾时间，四秒后仍等待正常确认', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context, { closeOnShutdown: false });
  await f.ready();
  const starting = f.manager.startRecording(sessionId, sessionId, 'C:\\recordings\\test.mkv', false);
  f.emit({ event: 'recordingStarted', recordingId: sessionId });
  await starting;
  f.emit({ event: 'captureTargetClosed' });
  await flush();
  context.mock.timers.tick(5000);
  await flush();
  assert.equal(f.killCount(), 0);
  f.emit({ event: 'recordingStopped', recordingId: sessionId, outputFrames: 600 });
  f.emit({ event: 'captureStopped' });
  await flush();
  assert.equal(f.manager.state.videoSessionId, undefined);
  assert.equal(f.killCount(), 0);
});

test('录像准备等待已有纹理交付调整完成，不与低频共享配置竞争', async context => {
  const f = fixture(context);
  await f.ready(60);
  const delivering = f.manager.configureVideo(sessionId, 30, { width: 1920, height: 1080 }, true);
  const preparing = f.manager.setRecordingFrameRate(sessionId, 60);
  assert.equal(f.commands.at(-1), 'delivery:1:30');
  f.emit({ event: 'deliveryConfigured', requestId: '1', sessionId, maxFps: 30, width: 1920, height: 1080 });
  await delivering; await preparing;
  assert.equal(f.manager.state.recordingFps, 60);
  assert.equal(f.manager.state.maxFps, 60);
  assert.equal(f.commands.at(-1), 'delivery:1:30');
});

test('热宿主再次启动时目标退出，保留正常结束错误码而不是通用停止错误', async context => {
  const f = fixture(context);
  await f.ready();
  await f.manager.stop(sessionId);
  const next = '00000000-0000-0000-0000-000000000008';
  const starting = assert.rejects(f.manager.start('monitor:7:0', 60, next, { kind: 'monitor', monitorName },
    { hideCursor: true, hideBorder: true }), /captureTargetClosed/);
  await flush();
  f.emit({ event: 'captureTargetClosed', sessionId: next });
  await starting;
  assert.equal(f.failures.at(-1), 'captureTargetClosed');
});

test('预热显卡不匹配先等待旧宿主退出，再按原来源和画质重建，不切换采集范围', async (context) => {
  const { manager, children, diagnostics, failures, start, emit } = adapterFixture(context);
  const started = start();
  await flush();
  const first = children[0];
  emit(first, { event: 'adapterRequired', adapterIndex: 2 });
  await flush();
  assert.deepEqual(first.commands.slice(-1), ['shutdown']);
  assert.equal(children.length, 1);
  first.emit('close', 0);
  await flush();
  const second = children[1];
  assert.equal(second.args.at(-1), '2');
  assert.equal(second.commands[0], first.commands[0]);
  assert.match(second.commands[0], /\|120\|\|\|2560\|1440\|auto\|$/);
  emit(second, { event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.equal(manager.state.child, second);
  assert.deepEqual(failures, []);
  assert.deepEqual(diagnostics.map(entry => entry.stage), ['obsAdapterRebuildRequired', 'obsHostExited']);
  assert.equal(diagnostics[1].stopMode, 'graceful');
  assert.equal(diagnostics[1].stopReason, 'adapterChange');
});

test('换显卡重建期间取消，不会在旧宿主迟到退出后重新采集', async (context) => {
  const { manager, children, start, emit } = adapterFixture(context);
  const rejected = assert.rejects(start(), /obsCaptureStopping/);
  await flush();
  emit(children[0], { event: 'adapterRequired', adapterIndex: 1 });
  await flush();
  await manager.stop(sessionId);
  children[0].emit('close', 0);
  await rejected;
  assert.equal(children.length, 1);
  assert.equal(manager.state, undefined);
});

test('旧宿主退出未确认时禁止重建，重复显卡不匹配最多重建一次', async (context) => {
  const { manager, children, start, emit } = adapterFixture(context);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(start(), /obsCaptureStopUnconfirmed/);
  await flush();
  emit(children[0], { event: 'adapterRequired', adapterIndex: 1 });
  await flush();
  context.mock.timers.tick(4000);
  await flush();
  context.mock.timers.tick(1500);
  await rejected;
  assert.equal(children.length, 1);
  assert.equal(children[0].kills, 1);
  await assert.rejects(start(), /AlreadyRunning/);
  assert.equal(manager.state.closed, false);
});

test('重建后仍不匹配时明确失败，不无限重试或改用窗口采集', async (context) => {
  const { children, start, emit } = adapterFixture(context);
  const rejected = assert.rejects(start(), /dxgiAdapterMismatch/);
  await flush();
  emit(children[0], { event: 'adapterRequired', adapterIndex: 1 });
  await flush();
  children[0].emit('close', 0);
  await flush();
  emit(children[1], { event: 'adapterRequired', adapterIndex: 1 });
  await flush();
  children[1].emit('close', 0);
  await rejected;
  assert.equal(children.length, 2);
});

test('采集证据仅接受当前会话固定阶段和字段，每阶段一次，停止后不记作活动采集', async (context) => {
  const { manager, ready, emit, captureDiagnostics, failures } = fixture(context);
  await ready();
  const entry = { event: 'captureEvidence', stage: 'sourceReady', captureMethod: 'dxgi', captureApi: 'DuplicateOutput',
    adapterIndex: 1, adapterMatched: true, sourceWidth: 1920, sourceHeight: 1080, windowTitle: 'private' };
  emit(entry);
  emit(entry);
  assert.deepEqual(captureDiagnostics, [{ stage: 'obsSourceReady', captureMethod: 'dxgi', captureApi: 'DuplicateOutput',
    adapterIndex: 1, adapterMatched: true, sourceWidth: 1920, sourceHeight: 1080 }]);
  await manager.stop(sessionId);
  emit({ ...entry, stage: 'rendering' });
  assert.equal(captureDiagnostics.length, 2);
  assert.equal(captureDiagnostics[1].stopMode, 'graceful');
  assert.deepEqual(failures, []);
});

test('GPU 短暂延迟只记录一次证据，真实持续卡死和设备错误仍结束共享', async (context) => {
  for (const code of ['sharedTextureGpuStalled', 'sharedTextureGpuWaitFailed', 'sharedTextureReleaseFailed']) {
    const { manager, ready, emit, captureDiagnostics, failures } = fixture(context);
    await ready();
    const delayed = { event: 'captureEvidence', stage: 'gpuDelayed', captureMethod: 'dxgi',
      adapterIndex: 0, adapterMatched: true, sourceWidth: 0, sourceHeight: 0 };
    emit(delayed); emit(delayed);
    assert.deepEqual(failures, []);
    assert.notEqual(manager.state.failed, true);
    assert.equal(captureDiagnostics.filter(entry => entry.stage === 'obsGpuFrameDeferred').length, 1);
    emit({ event: code });
    assert.deepEqual(failures, [code]);
    assert.equal(manager.state.failed, true);
  }
});

test('启动前阶段区分图形准备与来源创建，每阶段一次，不带窗口或硬件标识', async (context) => {
  const { start, emit, manager, captureDiagnostics } = fixture(context);
  const started = start();
  for (const stage of ['graphicsStarting', 'graphicsReady', 'sourceStarting']) {
    emit({ event: 'capturePreparation', stage, windowTitle: 'private', luid: 'private' });
    emit({ event: 'capturePreparation', stage });
  }
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureDiagnostics, [{ stage: 'obsGraphicsStarting' }, { stage: 'obsGraphicsReady' }, { stage: 'obsSourceStarting' }]);
  await manager.stop(sessionId);
  emit({ event: 'capturePreparation', stage: 'graphicsReady' });
  assert.equal(captureDiagnostics.length, 4);
});

test('无效显卡索引或伪造采集方法不能通过宿主协议', async (context) => {
  for (const event of [{ event: 'adapterRequired', adapterIndex: 64 },
    { event: 'captureEvidence', stage: 'configured', captureMethod: 'wgc-window', adapterIndex: 0, sourceWidth: 0, sourceHeight: 0 }]) {
    const { start, emit, failures } = fixture(context);
    const rejected = assert.rejects(start(), /obsCaptureProtocolEventInvalid/);
    await flush();
    emit(event);
    await rejected;
    assert.deepEqual(failures, ['obsCaptureProtocolEventInvalid']);
  }
});

test('游戏首帧等待记录首次钩子、一次重试和就绪，不导出附加身份', async (context) => {
  const { manager, emit, captureDiagnostics } = fixture(context);
  const target = { kind: 'game', windowId: '34567',
    lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.34567', processCreationTime: '56789', processId: 123 };
  const started = manager.start('window:7:0', 60, sessionId, target,
    { hideCursor: true, hideBorder: false, windowMethod: 'auto' });
  emit({ event: 'capturePreparation', stage: 'sourceStarting', durationMs: 184, processName: 'private' });
  for (const stage of ['gameHookAttempt', 'gameHookRetry', 'gameHookSignalled']) {
    emit({ event: 'capturePreparation', stage, processName: 'private' });
    emit({ event: 'capturePreparation', stage });
  }
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureDiagnostics, [
    { stage: 'obsSourceStarting', durationMs: 184 }, { stage: 'obsGameHookAttempt' },
    { stage: 'obsGameHookRetry' }, { stage: 'obsGameHookSignalled' },
  ]);
});

test('停止超时后的强制结束单独记录，不伪报正常停止', async (context) => {
  const { manager, ready, captureDiagnostics } = fixture(context, { closeOnShutdown: false });
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = manager.stop(sessionId);
  context.mock.timers.tick(4000);
  await stopped;
  assert.deepEqual(captureDiagnostics, [{ stage: 'obsHostExited', stopMode: 'forced', stopReason: 'stopTimeout' }]);
});

test('请求退出后原生进程异常退出，也不能记为正常清理', async (context) => {
  const { manager, child, captureDiagnostics } = fixture(context, { closeOnShutdown: false });
  await manager.prepare();
  const stopped = manager.shutdown();
  child.emit('close', 1);
  await stopped;
  assert.deepEqual(captureDiagnostics, [{ stage: 'obsHostExited', stopMode: 'unexpected', stopReason: 'shutdown' }]);
});

const audioId = '00000000-0000-0000-0000-000000000001';
const nextAudioId = '00000000-0000-0000-0000-000000000002';

test('OBS 渲染统计只投影固定字段，统计异常不结束共享，旧响应不能覆盖新请求', async (context) => {
  const { manager, ready, emit, failures, killCount } = fixture(context);
  await ready();
  const reply = (requestId, render) => emit({ event: 'diagnostics', requestId, sessionId,
    renderedFrames: 120, bridgeFrames: 100, bridgeDroppedFrames: 0, obsRender: render });
  const reading = manager.getDiagnostics(sessionId);
  reply('1', { ...obsRender, windowTitle: 'private-title', deviceLuid: 'private-device' });
  assert.deepEqual((await reading).obsRender, obsRender);
  let requestId = 1;
  for (const render of [undefined, { ...obsRender, activeFps: -1 }, { ...obsRender, averageRenderMs: Infinity },
    { ...obsRender, configuration: 0 }, { ...obsRender, laggedFrames: 999 },
    { ...obsRender, totalFrames: -1 }, { ...obsRender, elapsedMs: 1000 }]) {
    const rejected = assert.rejects(manager.getDiagnostics(sessionId), /obsRenderDiagnosticsInvalid/);
    reply(String(++requestId), render);
    await rejected;
  }
  assert.equal(killCount(), 0);
  assert.equal(manager.state.videoSessionId, sessionId);
  assert.deepEqual(failures, []);
  const resumed = manager.getDiagnostics(sessionId);
  reply('1', { ...obsRender, activeFps: 999 });
  reply(String(++requestId), { ...obsRender, elapsedMs: 500, activeFps: null, averageRenderMs: null });
  assert.equal((await resumed).obsRender.activeFps, null);
});
const audioFormat = { sampleRate: 48_000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10,
  pluginLoadMs: 12, captureReadyMs: 340 };

test('核心预热不携带来源，图形准备共用宿主和一次命令，未真实确认前保持等待', async (context) => {
  const { manager, emit, commands, captureCommands, spawns } = fixture(context);
  await manager.prepare();
  assert.equal(manager.state.videoSessionId, undefined);
  assert.deepEqual(captureCommands, []);
  assert.equal(spawns[0][1].length, 3);
  let complete = false;
  const prepared = manager.prepare(true).then(() => { complete = true; });
  const repeated = manager.prepare(true);
  await flush();
  assert.deepEqual(commands, ['prepare']);
  assert.equal(complete, false);
  emit({ event: 'enginePrepared' });
  await Promise.all([prepared, repeated]);
  assert.equal(complete, true);
  assert.equal(spawns.length, 1);
  assert.equal(manager.state.audio, undefined);
});

test('热宿主连续采集复用同一进程，旧开始、停止、帧及槽位归还不能接管新会话', async (context) => {
  const { manager, ready, emit, commands, captureCommands, spawns, frames, failures } = fixture(context);
  await ready();
  const state = manager.state;
  await manager.stop(sessionId);
  assert.equal(manager.state, state);
  assert.equal(state.closed, false);
  const nextSession = '00000000-0000-0000-0000-000000000003';
  const started = manager.start('monitor:7:0', 120, nextSession, { kind: 'monitor', monitorName },
    { hideCursor: false, hideBorder: false });
  await flush();
  emit({ event: 'captureStarted', sessionId, helperVersion: '32.2.2' });
  emit({ event: 'captureStopped', sessionId });
  emit({ event: 'sharedTextureFrame', sessionId });
  emit({ event: 'captureSuspended', sessionId, suspended: true });
  assert.equal(state.videoSessionId, nextSession);
  assert.notEqual(state.startResolve, undefined);
  await assert.rejects(state.releaseSharedTextureSlot(sessionId, 0), /Unavailable/);
  emit({ event: 'captureStarted', sessionId: nextSession, helperVersion: '32.2.2' });
  await started;
  await state.releaseSharedTextureSlot(nextSession, 0);
  assert.equal(commands.at(-1), `release:${nextSession}:0`);
  assert.equal(captureCommands.length, 2);
  assert.equal(spawns.length, 1);
  assert.deepEqual(frames, []);
  assert.deepEqual(failures, []);
});

test('启动前取消不写采集命令，迟到核心就绪不会启动已取消的来源', async (context) => {
  const { manager, start, captureCommands, failures } = fixture(context);
  const rejected = assert.rejects(start(), /obsCaptureStopping/);
  await manager.stop(sessionId);
  await rejected;
  await flush();
  assert.deepEqual(captureCommands, []);
  assert.equal(manager.state.videoSessionId, undefined);
  assert.deepEqual(failures, []);
});

test('空闲三分钟退出；活动采集不被旧空闲计时器结束，停止后重新计时', async (context) => {
  const { manager, emit, start, commands } = fixture(context);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await manager.prepare();
  context.mock.timers.tick(179_999);
  assert.equal(commands.includes('shutdown'), false);
  const started = start();
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  context.mock.timers.tick(180_000);
  assert.equal(commands.includes('shutdown'), false);
  await manager.stop(sessionId);
  context.mock.timers.tick(179_999);
  assert.equal(commands.includes('shutdown'), false);
  context.mock.timers.tick(1);
  await flush();
  assert.equal(commands.at(-1), 'shutdown');
  assert.equal(manager.state, undefined);
});

test('图形准备超时真实失败并退出宿主，不启动采集或伪报准备成功', async (context) => {
  const { manager, captureCommands, failures, killCount } = fixture(context);
  await manager.prepare();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(manager.prepare(true), /obsCapturePrepareTimeout/);
  await flush();
  context.mock.timers.tick(10_000);
  await rejected;
  await flush();
  assert.equal(killCount(), 1);
  assert.equal(manager.state, undefined);
  assert.deepEqual(captureCommands, []);
  assert.deepEqual(failures, ['obsCapturePrepareTimeout']);
});

test('正式后台入口只做一次核心准备，图形失败后不随页面枚举循环重启', async () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const calls = [];
  const diagnostics = [];
  const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, performance, closing: false, process: { platform: 'win32' }, existsSync: () => true,
    obsHostSettings: { executablePath: 'host', modulePath: 'capture', dataPath: 'data' },
    obsCaptureHost: { prepare: async graphics => { calls.push(graphics); if (graphics) throw new Error('prepare failed'); } },
    writeMediaDiagnostic: async event => { diagnostics.push(event); } };
  const prepare = runInNewContext(source.slice(source.indexOf('let obsCorePreparationRequested ='),
    source.indexOf('function activityHelperPath(')) + '; prepareObsCapture', sandbox);
  prepare(false);
  prepare(false);
  assert.deepEqual(calls, [false]);
  prepare(true);
  await flush();
  prepare(true);
  prepare(false);
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(diagnostics.map(entry => entry.stage), ['obsCorePrepared', 'obsPrewarmFailed']);
});

test('退出中、非 Windows 或缺少固定运行文件时不发起后台准备', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  for (const [closing, platform, available] of [[true, 'win32', true], [false, 'linux', true], [false, 'win32', false]]) {
    const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, closing, process: { platform }, existsSync: () => available,
      obsHostSettings: { executablePath: 'host' }, obsCaptureHost: { prepare: () => assert.fail('不能启动后台宿主') } };
    const prepare = runInNewContext(source.slice(source.indexOf('let obsCorePreparationRequested ='),
      source.indexOf('function activityHelperPath(')) + '; prepareObsCapture', sandbox);
    prepare(false);
    prepare(true);
  }
});

test('选择器持续枚举时续用已准备宿主，关闭后的空闲回收仍由宿主管理', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const state = { preparePromise: Promise.resolve() };
  const calls = [];
  const sandbox = { closing: false, process: { platform: 'win32' }, existsSync: () => true,
    obsHostSettings: { executablePath: 'host' }, obsCaptureHost: { state,
      scheduleIdle: current => { assert.equal(current, state); calls.push('idle'); },
      prepare: () => assert.fail('已准备的宿主不需要再次初始化') } };
  const prepare = runInNewContext(source.slice(source.indexOf('let obsCorePreparationRequested ='),
    source.indexOf('function activityHelperPath(')) + '; prepareObsCapture', sandbox);
  prepare(true);
  prepare(true);
  assert.deepEqual(calls, ['idle', 'idle']);
});

test('应用退出永久封闭宿主，等待空闲退出的准备和新采集都不能再次创建进程', async (context) => {
  const { manager, spawns, child } = fixture(context, { closeOnShutdown: false });
  await manager.prepare();
  const idleShutdown = manager.shutdown();
  const preparing = assert.rejects(manager.prepare(true), /Disposed/);
  const starting = assert.rejects(manager.start('monitor:7:0', 60, sessionId,
    { kind: 'monitor', monitorName }, { hideCursor: false, hideBorder: false }), /Disposed/);
  const disposed = manager.dispose();
  child.emit('close', 0);
  await Promise.all([idleShutdown, disposed, preparing, starting]);
  await assert.rejects(manager.prepare(), /Disposed/);
  assert.equal(spawns.length, 1);
  assert.equal(manager.state, undefined);
});

test('OBS 声音等待真实启动及固定格式确认，使用同一宿主并由可信主进程提供排除身份', async (context) => {
  const { manager, ready, emit, commands, spawns } = fixture(context);
  await ready();
  const state = manager.state;
  for (const [id, mode] of [[audioId, 'process'], [nextAudioId, 'systemMix']]) {
    const started = manager.startScreenAudio(sessionId, id, mode);
    assert.equal(state.audio.started, false);
    assert.equal(commands.at(-1), `audioStart:${id}:${mode}:4321`);
    await assert.rejects(manager.startScreenAudio(sessionId, id, mode), /AlreadyRunning/);
    emit({ event: 'audioStarted', sessionId, audioId: id, ...audioFormat });
    assert.deepEqual(await started, audioFormat);
    assert.equal(state.audio.started, true);
    const stopped = manager.stopScreenAudio(sessionId, id);
    assert.equal(manager.stopScreenAudio(sessionId, id), stopped);
    emit({ event: 'audioStopped', sessionId, audioId: id });
    assert.deepEqual(await stopped, { changed: true });
    assert.equal(manager.state, state);
    assert.equal(state.audio, undefined);
  }
  assert.equal(spawns.length, 1);
});

test('OBS 声音拒绝无效来源模式、旧会话和非法标识，不伪造另一个声音来源', async (context) => {
  const { manager, ready, commands } = fixture(context);
  await ready();
  for (const [id, pipe, mode] of [['old', audioId, 'process'], [sessionId, 'bad:pipe', 'process'],
    [sessionId, audioId, 'auto'], [sessionId, audioId, 'unavailable']]) {
    await assert.rejects(manager.startScreenAudio(id, pipe, mode), /invalidScreenShareAudioStart/);
  }
  assert.deepEqual(commands, []);
});

test('OBS 声音启动中关闭，迟到成功或上一轮失败不能恢复声音或结束下一轮', async (context) => {
  const { manager, ready, emit, audioFailures, failures } = fixture(context);
  await ready();
  const startRejected = assert.rejects(manager.startScreenAudio(sessionId, audioId, 'process'), /SessionStopped/);
  const stopped = manager.stopScreenAudio(sessionId, audioId);
  await startRejected;
  emit({ event: 'audioStarted', sessionId, audioId, ...audioFormat });
  assert.equal(manager.state.audio.started, false);
  emit({ event: 'audioStopped', sessionId, audioId });
  await stopped;
  const next = manager.startScreenAudio(sessionId, nextAudioId, 'process');
  emit({ event: 'audioFailed', sessionId, audioId, code: 'screenShareAudioFailed' });
  emit({ event: 'audioStopped', sessionId, audioId });
  assert.equal(manager.state.audio.id, nextAudioId);
  emit({ event: 'audioStarted', sessionId, audioId: nextAudioId, ...audioFormat });
  await next;
  assert.deepEqual(audioFailures, []);
  assert.deepEqual(failures, []);
});

test('OBS 声音失败及格式错误只结束声音，原生确认清理后才允许重开', async (context) => {
  for (const invalidFormat of [false, true]) {
    const { manager, ready, emit, audioFailures, failures, killCount } = fixture(context);
    await ready();
    const state = manager.state;
    const rejected = assert.rejects(manager.startScreenAudio(sessionId, audioId, 'process'),
      invalidFormat ? /FormatUnsupported/ : /StartFailed/);
    emit(invalidFormat ? { event: 'audioStarted', sessionId, audioId, ...audioFormat, channels: 1 }
      : { event: 'audioFailed', sessionId, audioId, code: 'screenShareAudioStartFailed' });
    await rejected;
    await assert.rejects(manager.startScreenAudio(sessionId, nextAudioId, 'process'), /AlreadyRunning/);
    assert.equal(state.audio.stopping, true);
    emit({ event: 'audioStopped', sessionId, audioId });
    await flush();
    assert.equal(manager.state, state);
    assert.equal(state.audio, undefined);
    assert.equal(audioFailures.length, 1);
    assert.equal(killCount(), 0);
    assert.deepEqual(failures, []);
  }
});

test('OBS 启动确认只接收有界数字计时，非法计时不影响视频会话', async (context) => {
  for (const timing of [undefined, -1, Infinity, 'slow', 300001]) {
    const { manager, ready, emit, failures, killCount } = fixture(context);
    await ready();
    const rejected = assert.rejects(manager.startScreenAudio(sessionId, audioId, 'process'), /FormatUnsupported/);
    emit({ event: 'audioStarted', sessionId, audioId, ...audioFormat, captureReadyMs: timing });
    await rejected;
    emit({ event: 'audioStopped', sessionId, audioId });
    assert.deepEqual(failures, []);
    assert.equal(killCount(), 0);
  }
});

test('OBS 声音启动超时会请求清理，停止未确认时保留阻挡且不杀视频', async (context) => {
  const { manager, ready, emit, commands, killCount, audioFailures } = fixture(context);
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(manager.startScreenAudio(sessionId, audioId, 'process'), /StartTimedOut/);
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(commands.at(-1), `audioStop:${audioId}`);
  const stopRejected = assert.rejects(manager.stopScreenAudio(sessionId, audioId), /StopFailed/);
  context.mock.timers.tick(3000);
  await stopRejected;
  assert.equal(manager.state.audio.stopping, true);
  assert.equal(killCount(), 0);
  assert.equal(audioFailures.length, 1);
  await assert.rejects(manager.startScreenAudio(sessionId, nextAudioId, 'process'), /AlreadyRunning/);
  emit({ event: 'audioStarted', sessionId, audioId, ...audioFormat });
  assert.equal(manager.state.audio.started, false);
  emit({ event: 'audioStopped', sessionId, audioId });
  assert.equal(manager.state.audio, undefined);
});

test('OBS 声音诊断保留原始来源采样率，不能把多声道源计数冒充 48k 双声道交付', async (context) => {
  const { manager, ready, emit } = fixture(context);
  await ready();
  const diagnostics = manager.getDiagnostics(sessionId);
  emit({ event: 'diagnostics', requestId: '1', sessionId, renderedFrames: 60, bridgeFrames: 3, bridgeDroppedFrames: 57,
    screenShareAudio: { state: 'running', sampleRate: 44_100, channels: 6, packetsReceived: 20,
      framesReceived: 44_100, silentPackets: 2, droppedAudioChunks: 1, lastError: null } });
  const source = (await diagnostics).screenShareAudio;
  assert.equal(source.sampleRate, 44_100);
  assert.equal(source.channels, 6);
  assert.equal(source.framesReceived, 44_100);
  const rejected = assert.rejects(manager.getDiagnostics(sessionId), /DiagnosticsInvalid/);
  emit({ event: 'diagnostics', requestId: '2', sessionId, renderedFrames: 60, bridgeFrames: 3, bridgeDroppedFrames: 57,
    screenShareAudio: { ...idleAudio, packetsReceived: 1, silentPackets: 2 } });
  await rejected;
});

test('OBS 宿主退出使声音启动失败，退出本身确认了待清理的声音资源已释放', async (context) => {
  const { manager, ready, child } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.startScreenAudio(sessionId, audioId, 'process'), /SessionStopped/);
  const stopped = manager.stopScreenAudio(sessionId, audioId);
  child.emit('close', 1);
  await rejected;
  assert.deepEqual(await stopped, { changed: true });
  assert.equal(manager.state, undefined);
});

function mainScreenAudioFixture({ capability = 'windowsApplicationLoopbackProcessTree', captureStart, captureStop } = {}) {
  const calls = [];
  const messages = [];
  const servers = [];
  const sandbox = { recording: { active: undefined }, closing: false,
    nativeVideoSession: { sessionId, sourceId: 'monitor:7:0', starting: false, stopping: false },
    nativeMicrophone: { sessionId: 'separate-microphone', stop: () => assert.fail('共享操作不能关闭独立麦克风') },
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send: (...args) => messages.push(args) } },
    writeMediaDiagnostic: async (event) => { calls.push(['diagnostic', event]); },
    createServer: () => {
      const server = new EventEmitter();
      server.listening = false;
      server.listen = (path) => {
        calls.push(['listen', path]); server.listening = true; queueMicrotask(() => server.emit('listening'));
      };
      server.close = () => { server.listening = false; calls.push(['close']); };
      servers.push(server);
      return server;
    },
    screenShareAudioCapability: () => ({ available: capability !== 'platformUnsupported', reason: capability }),
    obsCaptureHost: {
      startScreenAudio: (...args) => { calls.push(['start', ...args]); return captureStart?.(...args) ?? Promise.resolve(audioFormat); },
      stopScreenAudio: (...args) => { calls.push(['stop', ...args]); return captureStop?.(...args) ?? Promise.resolve({ changed: true }); },
    } };
  const capture = require('./native-screen-audio.cjs').createNativeScreenAudio({
    host: sandbox.obsCaptureHost, getVideo: () => sandbox.nativeVideoSession,
    getRecording: () => sandbox.recording, getWindow: () => sandbox.mainWindow,
    isClosing: () => sandbox.closing, capability: sandbox.screenShareAudioCapability,
    writeDiagnostic: sandbox.writeMediaDiagnostic, platform: 'win32', createPipeServer: sandbox.createServer,
  });
  const connect = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    servers.at(-1).emit('connection', socket);
    return socket;
  };
  const packet = () => {
    const bytes = Buffer.alloc(4 + 480 * 8);
    bytes.writeUInt32LE(480);
    bytes.writeFloatLE(0.25, 4);
    return bytes;
  };
  return { sandbox, capture, calls, messages, servers, connect, packet,
    pipeId: () => calls.filter(entry => entry[0] === 'start').at(-1)?.[2],
    start: () => capture.start('monitor:7:0', sessionId),
    stop: () => capture.stop(sessionId) };
}

test('正式声音入口按能力选择 OBS 模式，先建立管道，成功才返回格式；重复点击共用等待', async () => {
  for (const [capability, mode] of [['windowsApplicationLoopbackProcessTree', 'process'], ['windowsSystemMixLoopback', 'systemMix']]) {
    let accept;
    const f = mainScreenAudioFixture({ capability, captureStart: () => new Promise((resolve) => { accept = resolve; }) });
    const first = f.start();
    const repeated = f.start();
    await flush();
    assert.deepEqual(f.calls.map((entry) => entry[0]), ['listen', 'start']);
    assert.equal(f.calls.at(-1)[3], mode);
    assert.deepEqual(f.messages, []);
    accept(audioFormat);
    assert.deepEqual(await first, audioFormat);
    assert.deepEqual(await repeated, audioFormat);
    await f.stop();
    assert.equal(f.capture.sessionId, undefined);
    assert.equal(f.sandbox.nativeMicrophone.sessionId, 'separate-microphone');
  }
});

test('PCM 碎片在真实格式确认前不发页面；停止 Promise 未完成时已断开并禁止后续交付', async () => {
  let accept, finishStop;
  const f = mainScreenAudioFixture({ captureStart: () => new Promise((resolve) => { accept = resolve; }),
    captureStop: () => new Promise((resolve) => { finishStop = resolve; }) });
  const started = f.start();
  await flush();
  const socket = f.connect();
  const bytes = f.packet();
  socket.emit('data', bytes.subarray(0, 17));
  socket.emit('data', bytes.subarray(17));
  assert.deepEqual(f.messages, []);
  accept(audioFormat);
  await started;
  const frame = f.messages[0];
  assert.equal(frame[0], 'media:native-screen-audio-frame');
  assert.equal(frame[1].sampleRate, 48_000);
  assert.equal(frame[1].pcm.byteLength, 3840);
  const stopped = f.stop();
  assert.equal(f.capture.sessionId, sessionId);
  assert.equal(socket.destroyed, true);
  await assert.rejects(f.start(), /AlreadyRunning/);
  socket.emit('data', bytes);
  f.capture.acknowledge(sessionId, 1, 0);
  assert.equal(f.messages.length, 1);
  finishStop({ changed: true });
  await stopped;
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
});

test('停止声音后迟到的管道连接立即断开，不等待宿主停止确认', async () => {
  let finishStop;
  const f = mainScreenAudioFixture({ captureStop: () => new Promise(resolve => { finishStop = resolve; }) });
  await f.start();
  const stopped = f.stop();
  const socket = f.connect();
  try {
    assert.equal(socket.destroyed, true);
    assert.equal(f.capture.sessionId, sessionId);
  } finally {
    finishStop({ changed: true });
    await stopped;
  }
});

test('页面销毁后声音故障仍完成回收，不再向页面发送错误', async () => {
  const f = mainScreenAudioFixture();
  await f.start();
  const socket = f.connect();
  f.sandbox.mainWindow.webContents.isDestroyed = () => true;
  f.sandbox.mainWindow.webContents.send = () => { throw new Error('Object has been destroyed'); };
  f.capture.notifyFailure(sessionId, 'screenShareAudioPipeFailed', f.pipeId());
  await flush();
  assert.equal(socket.destroyed, true);
  assert.equal(f.capture.sessionId, undefined);
});

test('共享声音队列有界，只有对应确认才能推进，丢帧统计在停止后保留', async () => {
  const f = mainScreenAudioFixture();
  await f.start();
  const socket = f.connect();
  for (let index = 0; index < 20; index++) socket.emit('data', f.packet());
  assert.equal(f.messages.length, 1);
  assert.equal(f.capture.droppedChunks, 7);
  f.capture.acknowledge('other-session', 1, 100);
  f.capture.acknowledge(sessionId, 2, 100);
  f.capture.acknowledge(sessionId, 1, -1);
  assert.equal(f.messages.length, 1);
  for (let sequence = 1; sequence <= 13; sequence++) f.capture.acknowledge(sessionId, sequence, 3);
  assert.equal(f.messages.length, 13);
  assert.equal(f.capture.droppedChunks, 10);
  await f.stop();
  assert.equal(f.capture.droppedChunks, 10);
});

test('录制复用声音时暂停发布不关宿主，恢复发布不重启声音且不交付旧队列', async () => {
  const f = mainScreenAudioFixture();
  await f.start();
  const socket = f.connect();
  socket.emit('data', f.packet());
  socket.emit('data', f.packet());
  f.sandbox.recording.media = { videoSessionId: sessionId, options: { applicationAudio: true } };
  await f.stop();
  socket.emit('data', f.packet());
  f.capture.acknowledge(sessionId, 1, 0);
  assert.equal(f.capture.publishing, false);
  assert.equal(f.messages.length, 1);
  assert.equal(socket.destroyed, false);
  await f.start();
  assert.equal(f.capture.publishing, true);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  socket.emit('data', f.packet());
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1][1].sequence, 2);
  f.sandbox.recording.media = undefined;
  await f.stop();
  assert.equal(socket.destroyed, true);
});

test('声音启动中停止并重开，迟到旧格式和旧停止通知不能清理下一次声音', async () => {
  let acceptOld;
  let starts = 0;
  const f = mainScreenAudioFixture({ captureStart: () => ++starts === 1
    ? new Promise((resolve) => { acceptOld = resolve; }) : Promise.resolve(audioFormat) });
  const rejected = assert.rejects(f.start(), /SessionStopped/);
  await flush();
  const oldPipeId = f.pipeId();
  await f.stop();
  await f.start();
  const newPipeId = f.pipeId();
  acceptOld(audioFormat);
  await rejected;
  f.capture.confirmStopped(sessionId, oldPipeId);
  assert.equal(f.capture.sessionId, sessionId);
  assert.equal(f.pipeId(), newPipeId);
  assert.notEqual(newPipeId, oldPipeId);
  assert.equal(f.calls.filter((entry) => entry[0] === 'stop').length, 1);
  await f.stop();
});


test('声音启动失败不回退；停止失败保留禁发与阻挡，迟到清理确认后才释放', async () => {
  const failed = mainScreenAudioFixture({ captureStart: async () => { throw new Error('screenShareAudioStartFailed'); } });
  await assert.rejects(failed.start(), /StartFailed/);
  assert.equal(failed.capture.sessionId, undefined);
  assert.equal(failed.servers[0].listening, false);
  const f = mainScreenAudioFixture({ captureStop: async () => { throw new Error('screenShareAudioStopFailed'); } });
  await f.start();
  const socket = f.connect();
  await assert.rejects(f.stop(), /StopFailed/);
  assert.equal(f.capture.sessionId, sessionId);
  assert.equal(socket.destroyed, true);
  await assert.rejects(f.start(), /AlreadyRunning/);
  f.capture.confirmStopped(sessionId, f.pipeId());
  assert.equal(f.capture.sessionId, undefined);
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
});

test('关闭共享来源时，渲染端停止声音不打断录制收尾，正常声音结束不标记录制失败', async () => {
  const f = mainScreenAudioFixture();
  await f.start();
  const socket = f.connect();
  f.sandbox.recording.media = { id: 'recording-media', videoSessionId: sessionId, options: { applicationAudio: true } };
  f.sandbox.recording.failMedia = () => assert.fail('正常结束不能标记录制失败');
  f.sandbox.nativeVideoSession.stopping = true;
  await f.stop();
  assert.equal(f.calls.some(call => call[0] === 'stop'), false);
  assert.equal(socket.destroyed, false);
  assert.equal(f.capture.publishing, false);
  f.capture.confirmStopped(sessionId, f.pipeId());
  assert.equal(socket.destroyed, true);
  assert.equal(f.capture.sessionId, undefined);
  assert.equal(f.messages.some(message => message[0] === 'media:native-screen-audio-error'), false);
});

test('录制仍在运行时声音异常继续报告失败，其他共享的停止状态不能掩盖它', async () => {
  for (const video of [{ sessionId, stopping: false }, { sessionId: 'other', stopping: true }]) {
    const f = mainScreenAudioFixture();
    await f.start();
    const failures = [];
    f.sandbox.recording.media = { id: 'recording-media', videoSessionId: sessionId, options: { applicationAudio: true } };
    f.sandbox.recording.failMedia = async (...args) => { failures.push(args); };
    f.sandbox.nativeVideoSession = video;
    f.capture.confirmStopped(sessionId, f.pipeId());
    assert.deepEqual(failures, [['recording-media', 'recordingApplicationAudioUnavailable']]);
    assert.equal(f.messages.at(-1)[0], 'media:native-screen-audio-error');
    await flush();
  }
});

test('能力失败、画面停止和旧来源不启动声音；原生错误只通知并清理对应声音', async () => {
  const unsupported = mainScreenAudioFixture({ capability: 'platformUnsupported' });
  await assert.rejects(unsupported.start(), /Unsupported/);
  assert.equal(unsupported.calls.some((entry) => entry[0] === 'start'), false);
  assert.equal(unsupported.servers[0].listening, false);
  const f = mainScreenAudioFixture();
  f.sandbox.nativeVideoSession.stopping = true;
  await assert.rejects(f.start(), /videoSourceExpired/);
  f.sandbox.nativeVideoSession.stopping = false;
  await assert.rejects(f.capture.start('window:7:0', sessionId), /videoSourceExpired/);
  await f.start();
  const socket = f.connect();
  f.capture.notifyFailure(sessionId, 'screenShareAudioTargetUnavailable', f.pipeId());
  assert.equal(socket.destroyed, true);
  assert.equal(f.messages.at(-1)[0], 'media:native-screen-audio-error');
  assert.equal(f.messages.at(-1)[1].code, 'screenShareAudioTargetUnavailable');
  await flush();
  assert.equal(f.capture.sessionId, undefined);
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
  assert.equal(f.sandbox.nativeMicrophone.sessionId, 'separate-microphone');
});


test('正式安装包交付唯一 OBS 采集宿主及插件资源', () => {
  const source = readFileSync(join(__dirname, '../electron-builder.cjs'), 'utf8');
  const module = { exports: {} };
  runInNewContext(source, { module, process: { env: {} },
    require: () => ({ updateFeedUrl: () => 'https://example.invalid/downloads/' }) });
  assert.ok(module.exports.files.includes('electron/obs-capture-host.cjs'));
  assert.ok(module.exports.extraResources.some((entry) => entry.to === 'obs-capture'));
});

test('打包前读取真实清单，未完成发布材料或文件变化时明确拒绝，不受 UTF-8 BOM 影响', () => {
  const source = readFileSync(join(__dirname, 'package-desktop.cjs'), 'utf8');
  const start = source.indexOf('const obsDirectory =');
  const end = source.indexOf('const runtimeInstaller =', start);
  assert.ok(start >= 0 && end > start);
  const contents = Buffer.from('controlled runtime fixture');
  const manifest = { obsVersion: '32.2.2', architecture: 'x64', redistributionReady: false,
    files: [{ path: 'bin/64bit/obs.dll', bytes: contents.length,
      sha256: require('node:crypto').createHash('sha256').update(contents).digest('hex') }] };
  const version = '0.1.3';
  const sourceContents = Buffer.from('controlled source bundle fixture');
  const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, projectRoot: 'C:\\project', outputDirectory: 'C:\\project\\release\\desktop', version,
    join: require('node:path').win32.join,
    createHash: require('node:crypto').createHash,
    readFileSync: (file) => file.endsWith('build-manifest.json') ? '\uFEFF' + JSON.stringify(manifest)
      : file.endsWith('.tar.gz') ? sourceContents : contents };
  const check = () => runInNewContext(source.slice(start, end), { ...sandbox });
  assert.throws(check, /发布材料尚未核验/);
  manifest.redistributionReady = true;
  assert.throws(check, /对应源码包缺失/);
  manifest.sourceBundle = { version, path: `LycanSync-${version}-obs-source.tar.gz`, bytes: sourceContents.length,
    sha256: require('node:crypto').createHash('sha256').update(sourceContents).digest('hex'),
    runtimeSha256: require('node:crypto').createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') };
  assert.doesNotThrow(check);
  manifest.sourceBundle.bytes++;
  assert.throws(check, /对应源码包校验失败/);
  manifest.sourceBundle.bytes--;
  manifest.files[0].bytes++;
  assert.throws(check, /文件与构建清单不一致/);
});

test('完整客户端分发记录绑定同版安装包、源码、差量和版本化许可的字节哈希', () => {
  const source = readFileSync(join(__dirname, 'package-desktop.cjs'), 'utf8');
  const start = source.indexOf('const noticesName =');
  assert.ok(start > source.indexOf('安装包内 OBS 文件校验失败'));
  const files = new Map([
    ['LycanSync-0.2.99-windows-x64-setup.exe', Buffer.from('installer')],
    ['LycanSync-0.2.99-windows-x64-setup.exe.blockmap', Buffer.from('blockmap')],
    ['LycanSync-0.2.99-obs-source.tar.gz', Buffer.from('source')],
    ['THIRD-PARTY-NOTICES.txt', Buffer.from('notices')], ['latest.yml', Buffer.from('manifest')],
  ]);
  const sandbox = { version: '0.2.99', outputDirectory: 'output', obsManifest: { obsVersion: '32.2.2' },
    livekit: { sdkCommit: 'tested-sdk', serverCommit: 'tested-server', protocol: 19 },
    obsSource: { path: 'LycanSync-0.2.99-obs-source.tar.gz', runtimeSha256: 'a'.repeat(64) },
    createHash: require('node:crypto').createHash, join: (...paths) => paths.at(-1),
    readFileSync: name => { assert.ok(files.has(name), `missing ${name}`); return files.get(name); },
    copyFileSync: (from, to) => { assert.ok(files.has(from)); files.set(to, files.get(from)); },
    writeFileSync: (name, contents) => files.set(name, Buffer.from(contents)) };
  runInNewContext(source.slice(start), { ...sandbox });
  const record = JSON.parse(files.get('LycanSync-0.2.99-release.json'));
  assert.equal(record.version, '0.2.99');
  assert.deepEqual(record.livekit, sandbox.livekit);
  assert.equal(record.runtimeSha256, sandbox.obsSource.runtimeSha256);
  assert.equal(record.files.length, 5);
  for (const file of record.files) {
    assert.equal(file.bytes, files.get(file.name).length);
    assert.equal(file.sha256, require('node:crypto').createHash('sha256').update(files.get(file.name)).digest('hex'));
  }
  assert.ok(record.files.some(file => file.name === 'LycanSync-0.2.99-THIRD-PARTY-NOTICES.txt'));
  files.delete('LycanSync-0.2.99-release.json');
  files.delete('LycanSync-0.2.99-obs-source.tar.gz');
  assert.throws(() => runInNewContext(source.slice(start), { ...sandbox }), /missing/);
  assert.equal(files.has('LycanSync-0.2.99-release.json'), false);
});

test('正式包和开发环境都使用固定 OBS 路径，不通过环境变量切回旧采集', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf('function obsCaptureHostSettings(');
  const end = source.indexOf('const obsHostSettings =', start);
  assert.ok(start >= 0 && end > start);
  for (const packaged of [false, true]) {
    const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, app: { isPackaged: packaged }, process: { resourcesPath: 'C:\\installed\\resources',
      env: { LYCANSYNC_OBS_CAPTURE_HOST: 'C:\\untrusted.exe' } },
      __dirname: 'C:\\project\\apps\\web\\electron', resolve: require('node:path').win32.resolve };
    const paths = runInNewContext(`${source.slice(start, end)}; obsCaptureHostSettings()`, sandbox);
    assert.ok(paths.executablePath.endsWith('bin\\64bit\\lycansync-obs-capture-host.exe'));
    assert.ok(paths.modulePath.endsWith('obs-plugins\\64bit\\win-capture.dll'));
    assert.ok(packaged ? paths.executablePath.startsWith('C:\\installed\\resources\\obs-capture\\')
      : paths.executablePath.startsWith('C:\\project\\release\\build-cache\\obs-32.2.2\\prepared\\'));
  }
});

test('声音模式仅由 Windows 能力决定，旧系统混音与进程树范围不会互换', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf('function screenShareAudioCapability(');
  const end = source.indexOf('function handleMediaHelperFailure(', start);
  assert.ok(start >= 0 && end > start);
  for (const [build, reason, available] of [[19041, 'windowsApplicationLoopbackProcessTree', true],
    [19040, 'windowsSystemMixLoopback', true], [15063, 'windowsSystemMixLoopback', true],
    [15062, 'windowsEventDrivenLoopbackRequiresBuild15063', false]]) {
    const result = runInNewContext(`${source.slice(start, end)}; screenShareAudioCapability()`, {
      process: { platform: 'win32' }, osRelease: () => `10.0.${build}` });
    assert.equal(result.reason, reason);
    assert.equal(result.available, available);
  }
});

test('启动按显示器设备名传参，不把来源 ID 尾号当作显示器序号', async (context) => {
  const { manager, ready, spawns, captureCommands } = fixture(context);
  await ready();
  assert.deepEqual(spawns[0][1], ['C:\\obs\\win-capture.dll', 'C:\\obs\\data', 'C:\\user-data\\obs-capture\\32.2.2']);
  assert.equal(captureCommands[0], `start|monitor|${monitorName}|0|0|${sessionId}|60|||1920|1080|auto|`);
  assert.equal(spawns[0][2].windowsHide, true);
  assert.equal(spawns[0][2].cwd, 'C:\\obs');
  assert.equal(manager.state.helperVersion, '32.2.2');
  await manager.stop(sessionId);
  assert.equal(manager.state.videoSessionId, undefined);
  await manager.shutdown();
  assert.equal(manager.state, undefined);
});

test('三档目标帧率均传入同一 OBS 宿主，拒绝选项以外的值', async (context) => {
  for (const fps of [30, 60, 120]) {
    const { manager, ready, captureCommands } = fixture(context);
    await ready(fps);
    assert.equal(captureCommands[0].split('|')[6], String(fps));
    assert.equal(manager.state.maxFps, fps);
    await manager.stop(sessionId);
  }
  const { start, spawns } = fixture(context);
  for (const fps of [0, 15, 61, 90, 121, 144, 180, 181, 30.5, NaN, Infinity, '60']) {
    await assert.rejects(start(fps), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 0);
});

test('仅降低纹理交付不改变 OBS 渲染规格，也不发送录像或回放停止命令', async context => {
  const { manager, ready, emit, commands } = fixture(context);
  await ready(120);
  const changing = manager.configureVideo(sessionId, 30, { width: 1920, height: 1080 }, true);
  assert.equal(commands.at(-1), 'delivery:1:30');
  emit({ event: 'deliveryConfigured', requestId: '1', sessionId, maxFps: 30, width: 1920, height: 1080 });
  await changing;
  assert.equal(manager.state.maxFps, 120);
  assert.equal(commands.some(command => command.startsWith('recordStop') || command.startsWith('replayStop') || command.startsWith('configure:')), false);
  await assert.rejects(manager.configureVideo(sessionId, 60, { width: 1280, height: 720 }, true), /invalidVideoConfiguration/);
  await assert.rejects(manager.configureVideo('old-session', 30, undefined, true), /invalidVideoConfiguration/);
});

test('纹理交付节流超时不杀掉共享宿主，迟到回复也不覆盖新状态', async context => {
  const f = fixture(context); await f.ready(120);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const changing = assert.rejects(f.manager.configureVideo(sessionId, 30, undefined, true), /ConfigurationTimeout/);
    context.mock.timers.tick(3_000); await changing;
    assert.equal(f.manager.state.alive, true);
    assert.notEqual(f.manager.state.failed, true);
    assert.equal(f.manager.state.maxFps, 120);
    f.emit({ event: 'deliveryConfigured', requestId: '1', sessionId, maxFps: 30, width: 1920, height: 1080 });
    assert.equal(f.manager.state.maxFps, 120);
  } finally { context.mock.timers.reset(); }
});

test('共享中切换等宿主确认才更新帧率，不更换子进程或会话', async (context) => {
  const { manager, ready, emit, commands, spawns } = fixture(context);
  await ready();
  const state = manager.state;
  for (const [index, fps] of [30, 120, 60].entries()) {
    const previous = state.maxFps;
    const configured = manager.configureVideo(sessionId, fps);
    assert.equal(state.maxFps, previous);
    assert.equal(commands.at(-1), `configure:${index + 1}:${fps}:1920:1080:${fps}`);
    await assert.rejects(manager.configureVideo(sessionId, fps), /ConfigurationInProgress/);
    emit({ event: 'captureConfigured', requestId: String(index + 1), sessionId, maxFps: fps });
    assert.deepEqual(await configured, { changed: true });
    assert.equal(state.maxFps, fps);
    assert.equal(manager.state, state);
  }
  assert.equal(spawns.length, 1);
  await assert.rejects(manager.configureVideo('old-session', 30), /invalidVideoConfiguration/);
  for (const fps of [0, 61, 90, 144, 180, 181, 30.5, NaN, Infinity, '120']) {
    await assert.rejects(manager.configureVideo(sessionId, fps), /invalidVideoConfiguration/);
  }
});

test('自定义尺寸贯通宿主启动与切换，只在尺寸和帧率均确认后更新，不新增进程', async (context) => {
  const { manager, emit, spawns, commands, captureCommands } = fixture(context);
  const started = manager.start('monitor:7:0', 120, sessionId, { kind: 'monitor', monitorName },
    { hideCursor: false, hideBorder: false }, { width: 2560, height: 1440 });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(-4), ['2560', '1440', 'auto', '']);
  const resolution = { width: 1280, height: 720 };
  const changing = manager.configureVideo(sessionId, 30, resolution);
  resolution.width = 1920;
  assert.equal(commands.at(-1), 'configure:1:30:1280:720:30');
  assert.deepEqual(manager.state.resolution, { width: 2560, height: 1440 });
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 30, width: 1280, height: 720 });
  await changing;
  assert.deepEqual(manager.state.resolution, { width: 1280, height: 720 });
  assert.equal(spawns.length, 1);
  for (const size of [null, { width: 640, height: 360 }, { width: 3840, height: 2160 }, { width: 2560, height: 1080 }, { width: '1920', height: 1080 }]) {
    await assert.rejects(manager.configureVideo(sessionId, 60, size), /invalidVideoConfiguration/);
  }
  const rejected = assert.rejects(manager.configureVideo(sessionId, 120, { width: 2560, height: 1440 }), /ConfigurationRejected/);
  emit({ event: 'captureConfigurationRejected', requestId: '2', sessionId, maxFps: 30, width: 1280, height: 720 });
  await rejected;
  assert.equal(manager.state.maxFps, 30);
  assert.deepEqual(manager.state.resolution, { width: 1280, height: 720 });
  await manager.stop(sessionId);
  for (const size of [null, { width: 3840, height: 2160 }, { width: 2560, height: 1080 }]) {
    await assert.rejects(manager.start('monitor:7:0', 60, sessionId, { kind: 'monitor', monitorName },
      { hideCursor: false, hideBorder: false }, size), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 1);
});

test('宿主尺寸确认不一致即失败，不能把目标尺寸冒充实际输出', async (context) => {
  const { manager, ready, emit, failures } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.configureVideo(sessionId, 120, { width: 2560, height: 1440 }), /ConfigurationInvalid/);
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 120, width: 1920, height: 1080 });
  await rejected;
  assert.deepEqual(failures, ['obsCaptureConfigurationInvalid']);
});

test('宿主拒绝切换并恢复原帧率时明确失败，迟到旧响应不完成下一次切换', async (context) => {
  const { manager, ready, emit, failures } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.configureVideo(sessionId, 120), /ConfigurationRejected/);
  emit({ event: 'captureConfigurationRejected', requestId: '1', sessionId, maxFps: 60 });
  await rejected;
  assert.equal(manager.state.maxFps, 60);
  assert.deepEqual(failures, []);
  const next = manager.configureVideo(sessionId, 120);
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 120 });
  assert.equal(manager.state.pendingConfiguration.id, '2');
  emit({ event: 'captureConfigured', requestId: '2', sessionId, maxFps: 120 });
  await next;
  assert.equal(manager.state.maxFps, 120);
});

test('切换超时后实际配置未知，结束采集且不接受迟到成功', async (context) => {
  const { manager, ready, emit, failures, killCount } = fixture(context);
  await ready();
  const state = manager.state;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(manager.configureVideo(sessionId, 30), /ConfigurationTimeout/);
  context.mock.timers.tick(3000);
  await rejected;
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 30 });
  assert.equal(state.maxFps, 60);
  assert.equal(killCount(), 1);
  assert.deepEqual(failures, ['obsCaptureConfigurationTimeout']);
});

test('停止会撤销待确认切换，旧成功不恢复采集资格', async (context) => {
  const { manager, ready, emit } = fixture(context, { closeOnShutdown: false });
  await ready();
  const state = manager.state;
  const rejected = assert.rejects(manager.configureVideo(sessionId, 120), /obsCaptureStopping/);
  const stopped = manager.stop(sessionId);
  await rejected;
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 120 });
  assert.equal(state.maxFps, 60);
  assert.equal(state.stopRequested, true);
  state.child.emit('close', 0);
  await stopped;
});

test('宿主退出使待确认切换明确失败，不保留虚假的目标帧率', async (context) => {
  const { manager, ready, child, emit } = fixture(context);
  await ready();
  const state = manager.state;
  const rejected = assert.rejects(manager.configureVideo(sessionId, 120), /obsCaptureHostExited/);
  child.emit('close', 1);
  await rejected;
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 120 });
  assert.equal(state.maxFps, 60);
  assert.equal(state.pendingConfiguration, undefined);
  assert.equal(manager.state, undefined);
});

test('共享中画质调整仍走 OBS，停止状态拒绝调整', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const calls = [];
  const sandbox = { recording: { withVideoChange: operation => operation() }, closing: false,
    nativeVideo: { current: { sessionId, stopping: false } },
    obsCaptureHost: { configureVideo: async (...args) => { calls.push(args); return { changed: true }; } } };
  const configureStart = main.indexOf("ipcMain.handle('media:native-video:configure',");
  const configureEnd = main.indexOf("ipcMain.handle('recording:settings',", configureStart);
  let configure;
  sandbox.ipcMain = { handle: (_name, callback) => { configure = callback; } };
  sandbox.trustedSender = () => true;
  runInNewContext(main.slice(configureStart, configureEnd), sandbox);
  await configure({}, sessionId, 30, { width: 640, height: 360 });
  assert.deepEqual(calls.at(-1), [sessionId, 30, { width: 640, height: 360 }]);
  await configure({}, sessionId, 120, { width: 2560, height: 1440 });
  assert.deepEqual(calls.at(-1), [sessionId, 120, { width: 2560, height: 1440 }]);
  sandbox.nativeVideo.current.stopping = true;
  assert.throws(() => configure({}, sessionId, 120));
});

test('缺少绝对缓存路径时拒绝启动，不回写运行目录', async (context) => {
  const { manager, start, spawns } = fixture(context);
  for (const path of [undefined, '', 'relative/cache']) {
    manager.configPath = path;
    await assert.rejects(start(), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 0);
});

test('宿主实际版本不匹配时拒绝启动，不把目标版本冒充运行版本', async (context) => {
  const { start, emit, failures, killCount } = fixture(context);
  const rejected = assert.rejects(start(), /obsCaptureVersionUnsupported/);
  emit({ event: 'captureStarted', helperVersion: '32.1.0' });
  await rejected;
  assert.deepEqual(failures, ['obsCaptureVersionUnsupported']);
  assert.equal(killCount(), 1);
});

test('窗口启动只传已验证句柄和实例标记，不传标题做匹配', async (context) => {
  const { manager, emit, spawns, captureCommands } = fixture(context);
  const target = { kind: 'window', windowId: '34567', lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.34567', processCreationTime: '56789', processId: 123, requiresWindowCapture: false };
  const started = manager.start('window:7:0', 60, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(1), ['window', '34567', '0', '1', sessionId,
    '60', target.lifetimeName, String(target.processId), '1920', '1080', 'auto', target.processCreationTime]);
  await manager.stop(sessionId);
  for (const invalid of [{ ...target, windowId: '0' }, { ...target, processCreationTime: '18446744073709551616', processId: 123, requiresWindowCapture: false },
    { ...target, lifetimeName: 'window title' }, { ...target, kind: 'monitor' }]) {
    await assert.rejects(manager.start('window:7:0', 60, sessionId, invalid, { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 1);
});

test('游戏来源仍绑定已登记窗口，不接受整屏或丢失的实例标记', async (context) => {
  const { manager, emit, spawns, captureCommands } = fixture(context);
  const target = { kind: 'game', windowId: '34567', lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.34567', processCreationTime: '56789', processId: 123, requiresWindowCapture: false };
  const started = manager.start('window:7:0', 120, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(1), ['game', '34567', '0', '1', sessionId,
    '120', target.lifetimeName, String(target.processId), '1920', '1080', 'auto', target.processCreationTime]);
  await manager.stop(sessionId);
  await assert.rejects(manager.start('monitor:7:0', 60, sessionId, target, { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  await assert.rejects(manager.start('window:7:0', 60, sessionId, { ...target, lifetimeName: '' },
    { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  assert.equal(spawns.length, 1);
});

test('普通窗口记录实际方式，不能中途换方式或伪造边框授权', async (context) => {
  for (const borderChanged of [false, true]) {
    const request = 'auto';
    const { manager, emit, captureDiagnostics, failures, captureCommands } = fixture(context);
    const target = { kind: 'window', windowId: '34567', lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.34567', processCreationTime: '56789', processId: 123, requiresWindowCapture: false };
    const started = manager.start('window:7:0', 60, sessionId, target,
      { hideCursor: false, hideBorder: true, windowMethod: request });
    emit({ event: 'captureStarted', helperVersion: '32.2.2' });
    await started;
    const captureMethod = 'wgc-window';
    const evidence = { event: 'captureEvidence', stage: 'configured', captureMethod,
      requestedMethod: request, borderAllowed: false, clientArea: true,
      adapterIndex: 0, sourceWidth: 0, sourceHeight: 0 };
    emit(evidence);
    assert.equal(captureCommands[0].split('|').at(-2), request);
    assert.equal(captureDiagnostics.at(-1).captureMethod, captureMethod);
    assert.equal(captureDiagnostics.at(-1).borderAllowed, false);
    assert.equal(captureDiagnostics.at(-1).clientArea, true);
    emit({ ...evidence, stage: 'sourceReady', ...(!borderChanged
      ? { windowFallbackReason: 'captureBorderAccessDenied' } : { borderAllowed: true }) });
    assert.deepEqual(failures, ['obsCaptureProtocolEventInvalid']);
  }
});

test('普通窗口只接受 WGC，收到其他方法后丢弃迟到帧', async context => {
  const f = fixture(context);
  const target = { kind: 'window', windowId: '34567', lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.34567',
    processCreationTime: '56789', processId: 123, requiresWindowCapture: false };
  const starting = f.manager.start('window:7:0', 60, sessionId, target,
    { hideCursor: false, hideBorder: false, windowMethod: 'auto' });
  f.emit({ event: 'captureStarted', helperVersion: '32.2.2' }); await starting;
  const evidence = { event: 'captureEvidence', stage: 'configured', captureMethod: 'wgc-window', requestedMethod: 'auto',
    borderAllowed: true, clientArea: true, adapterIndex: 0, sourceWidth: 320, sourceHeight: 180 };
  f.emit(evidence);
  const frame = { event: 'sharedTextureFrame', sessionId, slotIndex: 0, sourceHandleHex: '0000000000000001', pixelFormat: 'bgra',
    timestampMicros: 1, codedSize: { width: 320, height: 180 }, contentSize: { width: 320, height: 180 },
    renderedFrames: 1, bridgeFrames: 1, bridgeDroppedFrames: 0 };
  f.emit(frame);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.failures, []);
  f.emit({ ...evidence, stage: 'sourceReady', captureMethod: 'bitblt-window' });
  f.emit({ ...frame, slotIndex: 1, renderedFrames: 2, bridgeFrames: 2 });
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.failures, ['obsCaptureProtocolEventInvalid']);
});

test('OBS 窗口暂停和恢复沿原会话同步，旧会话事件不能变更状态', async (context) => {
  const { manager, ready, emit, failures } = fixture(context);
  const statuses = [];
  manager.onSuspended = (_state, status) => statuses.push(status);
  await ready();
  emit({ event: 'captureSuspended', sessionId, suspended: true });
  emit({ event: 'captureSuspended', sessionId, suspended: false });
  assert.deepEqual(statuses, [{ sessionId, suspended: true }, { sessionId, suspended: false }]);
  emit({ event: 'captureSuspended', sessionId: 'old-session', suspended: true });
  assert.deepEqual(failures, ['obsCaptureSuspensionInvalid']);
  assert.equal(statuses.length, 2);
});

test('停止后迟到的窗口暂停事件不能恢复状态或将正常清理误报失败', async (context) => {
  const { manager, ready, emit, child, failures } = fixture(context, { closeOnShutdown: false });
  const onSuspended = context.mock.fn();
  manager.onSuspended = onSuspended;
  await ready();
  const stopped = manager.stop(sessionId);
  emit({ event: 'captureSuspended', sessionId, suspended: true });
  assert.equal(onSuspended.mock.callCount(), 0);
  assert.deepEqual(failures, []);
  child.emit('close', 0);
  await stopped;
});

test('OBS 远控 IPC 仅接受当前有效整屏；启动、停止、旧会话和窗口均拒绝输入', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const handlers = new Map();
  const calls = [];
  const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, closing: false, trustedSender: (event) => event.trusted,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    nativeVideo: { current: { sessionId, sourceId: 'monitor:7:0', starting: false, stopping: false } },
    mediaHelper: Object.fromEntries(['setRemoteControl', 'sendRemoteInput', 'clearRemoteControl'].map((name) =>
      [name, async (...args) => { calls.push([name, ...args]); return { changed: true }; }])) };
  runInNewContext(main.slice(main.indexOf("ipcMain.handle('media:remote-control:authorize',"),
    main.indexOf("ipcMain.handle('media:native-screen-audio:start',")), sandbox);
  const authorize = () => handlers.get('media:remote-control:authorize')({ trusted: true }, sessionId, 'control', 'friend');
  const input = () => handlers.get('media:remote-control:input')({ trusted: true }, sessionId, 'control', 'friend', 1, { kind: 'keyUp', key: 'letterA' });
  await authorize();
  await input();
  assert.deepEqual(calls.map((entry) => entry[0]), ['setRemoteControl', 'sendRemoteInput']);
  for (const change of [{ starting: true }, { stopping: true }, { sourceId: 'window:7:0' }, { sessionId: 'old' }]) {
    const current = sandbox.nativeVideo.current;
    sandbox.nativeVideo.current = { ...current, ...change };
    assert.throws(authorize, /InvalidSession/);
    assert.throws(input, /InvalidSession/);
    sandbox.nativeVideo.current = current;
  }
  assert.throws(() => handlers.get('media:remote-control:authorize')({ trusted: false }, sessionId, 'control', 'friend'), /InvalidSession/);
  sandbox.closing = true;
  assert.throws(authorize, /InvalidSession/);
  assert.throws(input, /InvalidSession/);
  await handlers.get('media:remote-control:revoke')({ trusted: true }, sessionId, 'control');
  assert.equal(calls.at(-1)[0], 'clearRemoteControl');
});

test('资源对照单独记录 Rust 身份 helper，不把它漏算或并成物理内存', () => {
  const source = readFileSync(join(__dirname, 'obs-capture-smoke/main.cjs'), 'utf8');
  const summary = runInNewContext(`${source.slice(source.indexOf('function resourceSummary('), source.indexOf('function sourceRange('))}; resourceSummary`,
    { cpus: () => [0, 1, 2, 3], assert: (condition, message) => { if (!condition) throw new Error(message); } });
  const before = { at: 1000, helper: { cpuSeconds: 1, workingSetMiB: 100, privateMiB: 70 },
    identityHelper: { cpuSeconds: 2, workingSetMiB: 40, privateMiB: 30 },
    electron: [{ pid: 1, cpu: { cumulativeCPUUsage: 1 }, memory: { workingSetSize: 1024 } }] };
  const after = { ...before, at: 2000, identityHelper: { cpuSeconds: 3, workingSetMiB: 42, privateMiB: 31 } };
  const result = summary(before, after);
  assert.equal(result.identityHelper.cpuPercentOfMachine, 25);
  assert.equal(result.identityHelper.privateMiB[1], 31);
  assert.equal(result.helperPrivateMiB[1], 70);
  assert.equal(summary({ ...before, identityHelper: null }, { ...after, identityHelper: null }).identityHelper, null);
  assert.throws(() => summary(before, { ...after, identityHelper: null }), /identityHelperChangedDuringSample/);
});

test('没有新增成功帧时仍主动读取真实槽位丢帧；并发诊断共用一次请求', async (context) => {
  const { manager, ready, emit, commands, frames } = fixture(context);
  await ready();
  for (let slotIndex = 0; slotIndex < 3; slotIndex++) emit({ event: 'sharedTextureFrame', sessionId, slotIndex,
    sourceHandleHex: '0000000000000001', pixelFormat: 'bgra', timestampMicros: slotIndex * 16_667,
    codedSize: { width: 1920, height: 1080 }, contentSize: { width: 1920, height: 1080 },
    renderedFrames: slotIndex + 1, bridgeFrames: slotIndex + 1, bridgeDroppedFrames: 0 });
  assert.equal(frames.length, 3);
  const diagnostics = manager.getDiagnostics(sessionId);
  assert.equal(manager.getDiagnostics(sessionId), diagnostics);
  assert.deepEqual(commands, ['diagnostics:1']);
  emit({ event: 'diagnostics', requestId: '1', sessionId, renderedFrames: 123, bridgeFrames: 3, bridgeDroppedFrames: 120 });
  assert.deepEqual(await diagnostics, { helperVersion: '32.2.2', renderedFrames: 123, bridgeFrames: 3,
    bridgeDroppedFrames: 120, screenShareAudio: idleAudio, obsRender });
  await manager.state.releaseSharedTextureSlot(sessionId, 1);
  assert.equal(commands.at(-1), `release:${sessionId}:1`);
  await assert.rejects(manager.state.releaseSharedTextureSlot('old-session', 1), /Unavailable/);
});

test('正式诊断入口使用宿主响应的版本及计数，不读取缓存成功帧或填固定版本', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('media:diagnostics',");
  const end = main.indexOf("ipcMain.on('window:maximize',", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const requested = [];
  const sandbox = { recording: { active: undefined, snapshot: () => ({ phase: 'idle', holdingResources: false,
    replay: { phase: 'idle', holdingResources: false, saving: false } }), withVideoChange: operation => operation() }, ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: () => true, closing: false,
    mediaHelper: { getDiagnostics: async () => ({ helperVersion: 'rust', framesReceived: 999 }) },
    nativeVideo: { current: { sessionId, sourceKind: 'monitor', helperState: { alive: true } } },
    obsCaptureHost: { getDiagnostics: async (id) => {
      requested.push(id);
      return { helperVersion: 'observed-version', renderedFrames: 123, bridgeFrames: 3, bridgeDroppedFrames: 120,
        screenShareAudio: { ...idleAudio }, obsRender: { ...obsRender } };
    } },
    nativeScreenAudio: { droppedChunks: 0 },
    nativeMicrophone: { diagnostics: async () => ({ microphoneCapture: null, microphoneCaptureDroppedChunks: 0 }) } };
  runInNewContext(main.slice(start, end), sandbox);
  const diagnostics = await handler({});
  assert.deepEqual(requested, [sessionId]);
  assert.equal(diagnostics.helperVersion, 'observed-version');
  assert.equal(diagnostics.framesReceived, 123);
  assert.equal(diagnostics.framesProcessed, 3);
  assert.equal(diagnostics.obsBridgeDroppedFrames, 120);
  assert.deepEqual(diagnostics.obsRender, obsRender);
  assert.equal(diagnostics.sourceKind, 'monitor');
  assert.equal(diagnostics.captureSuspended, null);
  assert.equal(diagnostics.recording.phase, 'idle');
  assert.equal(diagnostics.recording.holdingResources, false);
  assert.equal(diagnostics.recording.microphone, false);
  sandbox.nativeVideo.current.sourceKind = 'window';
  sandbox.nativeVideo.current.suspended = true;
  const pausedWindow = await handler({});
  assert.equal(pausedWindow.sourceKind, 'window');
  assert.equal(pausedWindow.captureSuspended, true);
  sandbox.nativeVideo.current.suspended = false;
  assert.equal((await handler({})).captureSuspended, false);
});

test('停止和强制结束均未确认时明确失败，保留状态阻止重开', async (context) => {
  const { manager, ready, child, start, killCount } = fixture(context, { closeOnShutdown: false, closeOnKill: false });
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const state = manager.state;
  const rejected = assert.rejects(manager.stop(sessionId), /obsCaptureStopUnconfirmed/);
  await flush();
  context.mock.timers.tick(4000);
  await flush();
  context.mock.timers.tick(1500);
  await rejected;
  assert.equal(killCount(), 1);
  assert.equal(manager.state, state);
  assert.equal(state.closed, false);
  await assert.rejects(start(), /obsCaptureAlreadyRunning/);
  child.emit('close', 0);
  assert.equal(manager.state, undefined);
});

test('有 PID 的进程错误不等同于已退出，不能清除采集身份', async (context) => {
  const { manager, ready, child, failures } = fixture(context, { closeOnKill: false });
  await ready();
  child.emit('error', new Error('kill failed'));
  assert.equal(manager.state.closed, false);
  assert.deepEqual(failures, ['kill failed']);
});

test('shutdown 写入未完成仍按时结束进程，不被 stdin 背压阻塞', async (context) => {
  const { manager, ready, killCount } = fixture(context, { blockShutdownWrite: true });
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = manager.stop(sessionId);
  context.mock.timers.tick(4000);
  await stopped;
  assert.equal(killCount(), 1);
  assert.equal(manager.state, undefined);
});

test('启动中停止后迟到的 ready 不能再宣告启动成功', async (context) => {
  const { manager, start, emit } = fixture(context, { closeOnShutdown: false });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(start(), /obsCaptureStopping/);
  const stopped = manager.stop(sessionId);
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  assert.equal(manager.state.helperVersion, undefined);
  context.mock.timers.tick(4000);
  await stopped;
  await rejected;
});

test('正常原生清理超过两秒时等待真实确认，保留宿主而不提前强杀', async (context) => {
  const { manager, ready, killCount } = fixture(context, { shutdownDelayMs: 2500 });
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = manager.stop(sessionId);
  context.mock.timers.tick(2500);
  await stopped;
  assert.equal(killCount(), 0);
  assert.equal(manager.state.videoSessionId, undefined);
  assert.equal(manager.state.closed, false);
});

test('诊断超时不伪造成功；迟到响应不能结束新请求', async (context) => {
  const { manager, ready, emit } = fixture(context);
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(manager.getDiagnostics(sessionId), /obsCaptureDiagnosticsTimeout/);
  context.mock.timers.tick(2000);
  await rejected;
  const next = manager.getDiagnostics(sessionId);
  emit({ event: 'diagnostics', requestId: '1', sessionId, renderedFrames: 999, bridgeFrames: 3, bridgeDroppedFrames: 996 });
  assert.equal(manager.state.pendingDiagnostics.id, '2');
  emit({ event: 'diagnostics', requestId: '2', sessionId, renderedFrames: 120, bridgeFrames: 3, bridgeDroppedFrames: 117 });
  assert.equal((await next).bridgeDroppedFrames, 117);
});

test('退出使待处理诊断失败，旧进程迟到响应不能恢复状态', async (context) => {
  const { manager, ready, child, emit } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.getDiagnostics(sessionId), /obsCaptureHostClosed/);
  child.emit('close', 0);
  await rejected;
  emit({ event: 'diagnostics', requestId: '1', sessionId, renderedFrames: 120, bridgeFrames: 3, bridgeDroppedFrames: 117 });
  assert.equal(manager.state, undefined);
});

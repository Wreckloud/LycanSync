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

function fixture(context, { closeOnShutdown = true, closeOnKill = true, blockShutdownWrite = false, shutdownDelayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const commands = [];
  const spawns = [];
  const failures = [];
  let kills = 0;
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const command = chunk.toString('utf8').trim();
    commands.push(command);
    if (command === 'shutdown' && blockShutdownWrite) return;
    callback();
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
    platform: 'win32', spawnProcess: (...args) => { spawns.push(args); return child; },
    onFrame: (_state, frame) => frames.push(frame), onFailure: (_state, error) => failures.push(error.message) });
  const emit = (event) => child.stdout.write(JSON.stringify(event) + '\n');
  const start = (maxFps = 60) => manager.start('monitor:7:0', maxFps, sessionId,
    { kind: 'monitor', monitorName }, { hideCursor: true, hideBorder: false });
  const ready = async (maxFps = 60) => {
    const started = start(maxFps);
    emit({ event: 'captureStarted', helperVersion: '32.2.2' });
    await started;
  };
  context.after(() => {
    if (manager.state) manager.state.stopRequested = true;
    child.emit('close', 0);
  });
  return { child, commands, spawns, failures, frames, manager, emit, start, ready, killCount: () => kills };
}

test('安装包包含主进程直接依赖的 OBS 管理文件，但不打包未验收的原生宿主', () => {
  const source = readFileSync(join(__dirname, '../electron-builder.cjs'), 'utf8');
  const module = { exports: {} };
  runInNewContext(source, { module, process: { env: {} },
    require: () => ({ updateFeedUrl: () => 'https://example.invalid/downloads/' }) });
  assert.ok(module.exports.files.includes('electron/obs-capture-host.cjs'));
  assert.ok(!module.exports.extraResources.some((entry) => entry.from.includes('obs-capture-host')));
});

test('启动按显示器设备名传参，不把来源 ID 尾号当作显示器序号', async (context) => {
  const { manager, ready, spawns } = fixture(context);
  await ready();
  assert.deepEqual(spawns[0][1], ['C:\\obs\\win-capture.dll', 'C:\\obs\\data', 'monitor', monitorName,
    '0', '0', sessionId, 'C:\\user-data\\obs-capture\\32.2.2', '60', '', '']);
  assert.equal(spawns[0][2].windowsHide, true);
  assert.equal(spawns[0][2].cwd, 'C:\\obs');
  assert.equal(manager.state.helperVersion, '32.2.2');
  await manager.stop(sessionId);
  assert.equal(manager.state, undefined);
});

test('显示器三种目标帧率均传入同一 OBS 宿主，拒绝预设以外的值', async (context) => {
  for (const fps of [30, 60, 120]) {
    const { manager, ready, spawns } = fixture(context);
    await ready(fps);
    assert.equal(spawns[0][1][8], String(fps));
    assert.equal(manager.state.maxFps, fps);
    await manager.stop(sessionId);
  }
  const { start, spawns } = fixture(context);
  for (const fps of [0, 15, 61, 121, 30.5, '60']) await assert.rejects(start(fps), /invalidObsCaptureArguments/);
  assert.equal(spawns.length, 0);
});

test('共享中切换等宿主确认才更新帧率，不更换子进程或会话', async (context) => {
  const { manager, ready, emit, commands, spawns } = fixture(context);
  await ready();
  const state = manager.state;
  for (const [index, fps] of [30, 120, 60].entries()) {
    const previous = state.maxFps;
    const configured = manager.configureVideo(sessionId, fps);
    assert.equal(state.maxFps, previous);
    assert.equal(commands.at(-1), `configure:${index + 1}:${fps}`);
    await assert.rejects(manager.configureVideo(sessionId, fps), /ConfigurationInProgress/);
    emit({ event: 'captureConfigured', requestId: String(index + 1), sessionId, maxFps: fps });
    assert.deepEqual(await configured, { changed: true });
    assert.equal(state.maxFps, fps);
    assert.equal(manager.state, state);
  }
  assert.equal(spawns.length, 1);
  await assert.rejects(manager.configureVideo('old-session', 30), /invalidVideoConfiguration/);
  await assert.rejects(manager.configureVideo(sessionId, 61), /invalidVideoConfiguration/);
});

test('宿主拒绝切换并恢复原帧率时明确失败，迟到旧响应不完成下一次切换', async (context) => {
  const { manager, ready, emit, failures } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.configureVideo(sessionId, 30), /ConfigurationRejected/);
  emit({ event: 'captureConfigurationRejected', requestId: '1', sessionId, maxFps: 60 });
  await rejected;
  assert.equal(manager.state.maxFps, 60);
  assert.deepEqual(failures, []);
  const next = manager.configureVideo(sessionId, 120);
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 30 });
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

test('主进程的显示器各档启动及共享中切换均走 OBS，不接入旧采集', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function startNativeVideo(');
  const end = main.indexOf('async function stopNativeVideo(', start);
  const calls = [];
  const sandbox = { closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => sessionId,
    nativeVideoSourcesById: new Map([['monitor:7:0', { kind: 'monitor', title: monitorName }]]),
    obsCaptureHost: { start: async (...args) => { calls.push(args); return { sessionId, changed: true }; },
      configureVideo: async (...args) => { calls.push(args); return { changed: true }; } },
    mediaHelper: { startVideo: () => assert.fail('显示器不应按画质回到旧采集'),
      configureVideo: () => assert.fail('OBS 会话不应修改旧采集') } };
  runInNewContext(main.slice(start, end), sandbox);
  for (const fps of [30, 60, 120]) {
    sandbox.nativeVideoSession = undefined;
    await sandbox.startNativeVideo('monitor:7:0', fps, { hideCursor: true, hideBorder: false });
    assert.equal(calls.at(-1)[1], fps);
  }
  const configureStart = main.indexOf("ipcMain.handle('media:native-video:configure',");
  const configureEnd = main.indexOf("ipcMain.handle('media:remote-control:authorize',", configureStart);
  let configure;
  sandbox.ipcMain = { handle: (_name, callback) => { configure = callback; } };
  sandbox.trustedSender = () => true;
  runInNewContext(main.slice(configureStart, configureEnd), sandbox);
  await configure({}, sessionId, 30);
  assert.deepEqual(calls.at(-1), [sessionId, 30]);
  sandbox.nativeVideoSession.stopping = true;
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
  const { manager, emit, spawns } = fixture(context);
  const target = { kind: 'window', windowId: '34567', propertyName: 'LycanSync.MediaHelper.Window.1.2.3', propertyValue: '56789' };
  const started = manager.start('window:7:0', 60, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(spawns[0][1].slice(2), ['window', '34567', '0', '1', sessionId,
    'C:\\user-data\\obs-capture\\32.2.2', '60', target.propertyName, target.propertyValue]);
  await manager.stop(sessionId);
  for (const invalid of [{ ...target, windowId: '0' }, { ...target, propertyValue: '18446744073709551616' },
    { ...target, propertyName: 'window title' }, { ...target, kind: 'monitor' }]) {
    await assert.rejects(manager.start('window:7:0', 60, sessionId, invalid, { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 1);
});

test('游戏来源仍绑定已登记窗口，不接受整屏或丢失的实例标记', async (context) => {
  const { manager, emit, spawns } = fixture(context);
  const target = { kind: 'game', windowId: '34567', propertyName: 'LycanSync.MediaHelper.Window.1.2.3', propertyValue: '56789' };
  const started = manager.start('window:7:0', 120, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(spawns[0][1].slice(2), ['game', '34567', '0', '1', sessionId,
    'C:\\user-data\\obs-capture\\32.2.2', '120', target.propertyName, target.propertyValue]);
  await manager.stop(sessionId);
  await assert.rejects(manager.start('monitor:7:0', 60, sessionId, target, { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  await assert.rejects(manager.start('window:7:0', 60, sessionId, { ...target, propertyName: '' },
    { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  assert.equal(spawns.length, 1);
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

test('生产入口先预留窗口身份再启动 OBS，停止先关闭 OBS 再释放身份', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function startNativeVideo(');
  const end = main.indexOf('function validMicrophoneSettings(', start);
  const calls = [];
  const targetState = { alive: true };
  const target = { kind: 'window', windowId: '123', propertyName: 'LycanSync.MediaHelper.Window.1.2.3', propertyValue: '456' };
  const sandbox = { closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => sessionId, setTimeout, clearTimeout,
    nativeScreenAudioSession: undefined, lastStoppedNativeVideoSession: undefined,
    nativeVideoSourcesById: new Map([['window:7:0', { kind: 'window', title: 'same title' }]]),
    obsCaptureHost: { state: undefined,
      start: async (_source, _fps, _id, received) => {
        calls.push('obs-start'); assert.equal(received.windowId, target.windowId);
        assert.equal(received.kind, 'window'); assert.equal(received.executable, undefined);
        sandbox.obsCaptureHost.state = { videoSessionId: sessionId };
        return { sessionId, changed: true };
      },
      stop: async () => { calls.push('obs-stop'); sandbox.obsCaptureHost.state = undefined; return { changed: true }; } },
    mediaHelper: { videoCapture: undefined,
      reserveWindowVideo: async () => {
        calls.push('reserve'); sandbox.mediaHelper.videoCapture = { state: targetState, sessionId };
        return { ...target, executable: 'C:\\Apps\\app.exe' };
      },
      stopVideo: async () => { calls.push('release'); sandbox.mediaHelper.videoCapture = undefined; return { changed: true }; },
      startVideo: () => assert.fail('不能启动另一条采集链路') },
    activityMonitor: { isCaptureGame: async (executable) => {
      calls.push('classify'); assert.equal(executable, 'C:\\Apps\\app.exe'); return false;
    } },
    recordVideoFailure: () => {}, releaseNativeVideoImports: () => {}, releaseHelperProcessBridge: () => {} };
  runInNewContext(main.slice(start, end), sandbox);
  await sandbox.startNativeVideo('window:7:0', 60, { hideCursor: false, hideBorder: false });
  assert.equal(sandbox.nativeVideoSession.targetState, targetState);
  assert.equal(sandbox.nativeVideoSession.sourceKind, 'window');
  assert.equal(sandbox.nativeVideoSession.engine, 'obs');
  await sandbox.stopNativeVideo(sessionId);
  assert.deepEqual(calls, ['reserve', 'classify', 'obs-start', 'obs-stop', 'release']);
  assert.equal(sandbox.nativeVideoSession, undefined);
});

function gameRoutingFixture(classify, startFailure) {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const calls = [];
  let sequence = 0;
  const sandbox = { closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => `routing-${++sequence}`, setTimeout, clearTimeout,
    nativeScreenAudioSession: undefined, lastStoppedNativeVideoSession: undefined,
    nativeVideoSourcesById: new Map([['window:7:0', { kind: 'window', title: 'same title' }]]),
    activityMonitor: { isCaptureGame: classify },
    obsCaptureHost: { state: undefined,
      start: async (sourceId, fps, id, target) => {
        calls.push({ action: 'start', sourceId, fps, id, target });
        if (startFailure) throw new Error(startFailure);
        sandbox.obsCaptureHost.state = { videoSessionId: id };
        return { sessionId: id, changed: true };
      },
      stop: async (id) => { calls.push({ action: 'stop', id }); sandbox.obsCaptureHost.state = undefined; return { changed: true }; } },
    mediaHelper: { videoCapture: undefined,
      reserveWindowVideo: async (id) => {
        sandbox.mediaHelper.videoCapture = { state: {}, sessionId: id };
        calls.push({ action: 'reserve', id });
        return { kind: 'window', windowId: '123', propertyName: 'LycanSync.MediaHelper.Window.1.2.3',
          propertyValue: '456', executable: 'C:\\Games\\selected.exe' };
      },
      stopVideo: async (id) => {
        calls.push({ action: 'release', id }); sandbox.mediaHelper.videoCapture = undefined; return { changed: true };
      },
      startVideo: () => assert.fail('不能回退到 Rust') },
    recordVideoFailure: () => {}, releaseNativeVideoImports: () => {}, releaseHelperProcessBridge: () => {} };
  runInNewContext(main.slice(main.indexOf('async function startNativeVideo('), main.indexOf('function validMicrophoneSettings(')), sandbox);
  return { sandbox, calls, start: () => sandbox.startNativeVideo('window:7:0', 120, { hideCursor: true, hideBorder: true }) };
}

test('所选游戏走精确钩子并保留来源与偏好；启动失败清理身份，不降级窗口或整屏', async () => {
  for (const failure of [undefined, 'obsGameBindingUnavailable', 'obsGameTargetMismatch']) {
    const { sandbox, calls, start } = gameRoutingFixture(async (executable) => {
      assert.equal(executable, 'C:\\Games\\selected.exe'); return true;
    }, failure);
    if (failure) await assert.rejects(start(), new RegExp(failure));
    else {
      const started = await start();
      assert.equal(sandbox.nativeVideoSession.sourceKind, 'window');
      await sandbox.stopNativeVideo(started.sessionId);
    }
    const capture = calls.find((entry) => entry.action === 'start');
    assert.equal(capture.sourceId, 'window:7:0');
    assert.equal(capture.target.kind, 'game');
    assert.equal(capture.target.windowId, '123');
    assert.equal(capture.target.executable, undefined);
    assert.equal(calls.filter((entry) => entry.action === 'start').length, 1);
    assert.equal(calls.at(-1).action, 'release');
    assert.equal(sandbox.nativeVideoSession, undefined);
  }
});

test('程序分类失败不启动采集，预留身份仍被释放', async () => {
  const { sandbox, calls, start } = gameRoutingFixture(async () => { throw new Error('obsCaptureGameDetectionFailed'); });
  await assert.rejects(start(), /obsCaptureGameDetectionFailed/);
  assert.equal(calls.some((entry) => entry.action === 'start'), false);
  assert.equal(calls.at(-1).action, 'release');
  assert.equal(sandbox.nativeVideoSession, undefined);
});

test('分类等待中重复启动被拒绝；停止后迟到结果不能重开或关闭新会话', async () => {
  let resolveOld;
  let count = 0;
  const { sandbox, calls, start } = gameRoutingFixture(() => ++count === 1
    ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(true));
  const old = assert.rejects(start(), /nativeVideoSessionStopped/);
  await flush();
  await assert.rejects(start(), /videoCaptureAlreadyRunning/);
  const oldId = sandbox.nativeVideoSession.sessionId;
  await sandbox.stopNativeVideo(oldId);
  const current = await start();
  const state = sandbox.obsCaptureHost.state;
  resolveOld(true);
  await old;
  assert.equal(sandbox.obsCaptureHost.state, state);
  assert.equal(sandbox.nativeVideoSession.sessionId, current.sessionId);
  assert.equal(calls.filter((entry) => entry.action === 'start').length, 1);
  await sandbox.stopNativeVideo(current.sessionId);
});

test('OBS 未确认停止时不能释放 Rust 持有的窗口身份', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function stopObsVideo(');
  const end = main.indexOf('async function stopNativeVideo(', start);
  let released = false;
  const targetState = {};
  const sandbox = {
    obsCaptureHost: { state: { videoSessionId: sessionId }, stop: async () => { throw new Error('obsCaptureStopUnconfirmed'); } },
    mediaHelper: { videoCapture: { sessionId, state: targetState }, stopVideo: async () => { released = true; } },
  };
  const stop = runInNewContext(`${main.slice(start, end)}; stopObsVideo`, sandbox);
  await assert.rejects(stop({ sessionId, targetState }), /obsCaptureStopUnconfirmed/);
  assert.equal(released, false);
  assert.equal(sandbox.mediaHelper.videoCapture.state, targetState);
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
  assert.deepEqual(await diagnostics, { helperVersion: '32.2.2', renderedFrames: 123, bridgeFrames: 3, bridgeDroppedFrames: 120 });
  await manager.state.releaseSharedTextureSlot(sessionId, 1);
  assert.equal(commands.at(-1), 'release:1');
  await assert.rejects(manager.state.releaseSharedTextureSlot('old-session', 1), /Unavailable/);
});

test('正式诊断入口使用宿主响应的版本及计数，不读取缓存成功帧或填固定版本', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('media:diagnostics',");
  const end = main.indexOf("ipcMain.on('window:maximize',", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const requested = [];
  const sandbox = { ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: () => true, closing: false,
    mediaHelper: { getDiagnostics: async () => ({ helperVersion: 'rust', framesReceived: 999 }) },
    nativeVideoSession: { engine: 'obs', sessionId, sourceKind: 'monitor', helperState: { alive: true } },
    obsCaptureHost: { getDiagnostics: async (id) => {
      requested.push(id);
      return { helperVersion: 'observed-version', renderedFrames: 123, bridgeFrames: 3, bridgeDroppedFrames: 120 };
    } },
    nativeMicrophoneSession: undefined, lastMicrophoneDroppedChunks: 0 };
  runInNewContext(main.slice(start, end), sandbox);
  const diagnostics = await handler({});
  assert.deepEqual(requested, [sessionId]);
  assert.equal(diagnostics.helperVersion, 'observed-version');
  assert.equal(diagnostics.framesReceived, 123);
  assert.equal(diagnostics.framesProcessed, 3);
  assert.equal(diagnostics.obsBridgeDroppedFrames, 120);
  assert.equal(diagnostics.sourceKind, 'monitor');
  assert.equal(diagnostics.captureSuspended, null);
  sandbox.nativeVideoSession.sourceKind = 'window';
  sandbox.nativeVideoSession.suspended = true;
  const pausedWindow = await handler({});
  assert.equal(pausedWindow.sourceKind, 'window');
  assert.equal(pausedWindow.captureSuspended, true);
  sandbox.nativeVideoSession.suspended = false;
  assert.equal((await handler({})).captureSuspended, false);
});

test('启动失败后的宿主停止未确认，主进程也保留身份阻止其他来源启动', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function startNativeVideo(');
  const end = main.indexOf('async function stopNativeVideo(', start);
  const sandbox = { closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => sessionId,
    nativeVideoSourcesById: new Map([['monitor:7:0', { kind: 'monitor', title: monitorName }]]),
    obsCaptureHost: { start: async () => { throw new Error('start failed'); },
      stop: async () => { throw new Error('obsCaptureStopUnconfirmed'); } },
    mediaHelper: { startVideo: () => assert.fail('未确认旧进程停止时不能开始其他采集') },
    recordVideoFailure: () => {}, releaseNativeVideoImports: () => {} };
  const invoke = runInNewContext(`${main.slice(start, end)}; startNativeVideo`, sandbox);
  await assert.rejects(invoke('monitor:7:0', 60, {}), /obsCaptureStopUnconfirmed/);
  assert.equal(sandbox.nativeVideoSession.stopping, true);
  await assert.rejects(invoke('window:7:0', 120, {}), /videoCaptureAlreadyRunning/);
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
  const rejected = assert.rejects(start(), /obsCaptureHostClosedBeforeStart/);
  const stopped = manager.stop(sessionId);
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  assert.equal(manager.state.helperVersion, undefined);
  context.mock.timers.tick(4000);
  await stopped;
  await rejected;
});

test('正常原生清理超过两秒时等待真实关闭，不提前强杀进程', async (context) => {
  const { manager, ready, killCount } = fixture(context, { shutdownDelayMs: 2500 });
  await ready();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = manager.stop(sessionId);
  context.mock.timers.tick(2500);
  await stopped;
  assert.equal(killCount(), 0);
  assert.equal(manager.state, undefined);
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

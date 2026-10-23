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
    onFrame: (_state, frame) => frames.push(frame), onFailure: (_state, error) => failures.push(error.message) });
  const emit = (event) => {
    const output = () => child.stdout.write(JSON.stringify(event.event === 'diagnostics'
    ? { screenShareAudio: { ...idleAudio }, ...event }
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
  return { child, commands, captureCommands, spawns, failures, audioFailures, frames, manager, emit, start, ready, killCount: () => kills };
}

const audioId = '00000000-0000-0000-0000-000000000001';
const nextAudioId = '00000000-0000-0000-0000-000000000002';
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
  const sandbox = { performance, closing: false, process: { platform: 'win32' }, existsSync: () => true,
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
    const sandbox = { closing, process: { platform }, existsSync: () => available,
      obsHostSettings: { executablePath: 'host' }, obsCaptureHost: { prepare: () => assert.fail('不能启动后台宿主') } };
    const prepare = runInNewContext(source.slice(source.indexOf('let obsCorePreparationRequested ='),
      source.indexOf('function activityHelperPath(')) + '; prepareObsCapture', sandbox);
    prepare(false);
    prepare(true);
  }
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
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const calls = [];
  const messages = [];
  const servers = [];
  let sequence = 0;
  const sandbox = { performance, writeMediaDiagnostic: async () => {}, closing: false, process: { platform: 'win32' }, Buffer, Uint8Array, AggregateError,
    nativeVideoSession: { sessionId, sourceId: 'monitor:7:0', starting: false, stopping: false },
    nativeScreenAudioSession: undefined, lastScreenAudioDroppedChunks: 0,
    nativeMicrophoneSession: { sessionId: 'separate-microphone' },
    randomUUID: () => ++sequence === 1 ? audioId : nextAudioId,
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send: (...args) => messages.push(args) } },
    writeMediaDiagnostic: async (event) => { calls.push(['diagnostic', event]); },
    releaseHelperProcessBridge: () => {},
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
  runInNewContext(main.slice(main.indexOf('function finishNativeScreenAudioPipe('),
    main.indexOf('function finishNativeMicrophonePipe(')) + '\n'
    + main.slice(main.indexOf('function validNativeAudioSessionId('), main.indexOf('function handleNativeMicrophonePipeData(')) + '\n'
    + main.slice(main.indexOf('function handleNativeScreenAudioPipeData('), main.indexOf('function handleMediaHelperFailure(')), sandbox);
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
  return { sandbox, calls, messages, servers, connect, packet,
    start: () => sandbox.startNativeScreenAudio('monitor:7:0', sessionId),
    stop: () => sandbox.stopNativeScreenAudio(sessionId) };
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
    assert.equal(f.sandbox.nativeScreenAudioSession.format, undefined);
    accept(audioFormat);
    assert.deepEqual(await first, audioFormat);
    assert.deepEqual(await repeated, audioFormat);
    await f.stop();
    assert.equal(f.sandbox.nativeScreenAudioSession, undefined);
    assert.equal(f.sandbox.nativeMicrophoneSession.sessionId, 'separate-microphone');
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
  const audio = f.sandbox.nativeScreenAudioSession;
  const stopped = f.stop();
  assert.equal(audio.stopping, true);
  assert.equal(socket.destroyed, true);
  assert.equal(audio.queue.length, 0);
  socket.emit('data', bytes);
  f.sandbox.acknowledgeNativeScreenAudioChunk(sessionId, 1, 0);
  assert.equal(f.messages.length, 1);
  finishStop({ changed: true });
  await stopped;
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
});

test('声音启动中停止并重开，迟到旧格式和旧停止通知不能清理下一次声音', async () => {
  let acceptOld;
  let starts = 0;
  const f = mainScreenAudioFixture({ captureStart: () => ++starts === 1
    ? new Promise((resolve) => { acceptOld = resolve; }) : Promise.resolve(audioFormat) });
  const rejected = assert.rejects(f.start(), /SessionStopped/);
  await flush();
  await f.stop();
  await f.start();
  const next = f.sandbox.nativeScreenAudioSession;
  acceptOld(audioFormat);
  await rejected;
  f.sandbox.handleObsScreenAudioStopped({ videoSessionId: sessionId }, { audioId });
  assert.equal(f.sandbox.nativeScreenAudioSession, next);
  assert.equal(next.pipeId, nextAudioId);
  assert.equal(f.calls.filter((entry) => entry[0] === 'stop').length, 1);
  await f.stop();
});


test('声音启动失败不回退；停止失败保留禁发与阻挡，迟到清理确认后才释放', async () => {
  const failed = mainScreenAudioFixture({ captureStart: async () => { throw new Error('screenShareAudioStartFailed'); } });
  await assert.rejects(failed.start(), /StartFailed/);
  assert.equal(failed.sandbox.nativeScreenAudioSession, undefined);
  assert.equal(failed.servers[0].listening, false);
  const f = mainScreenAudioFixture({ captureStop: async () => { throw new Error('screenShareAudioStopFailed'); } });
  await f.start();
  const audio = f.sandbox.nativeScreenAudioSession;
  const socket = f.connect();
  await assert.rejects(f.stop(), /StopFailed/);
  assert.equal(f.sandbox.nativeScreenAudioSession, audio);
  assert.equal(audio.stopping, true);
  assert.equal(socket.destroyed, true);
  await assert.rejects(f.start(), /AlreadyRunning/);
  f.sandbox.handleObsScreenAudioStopped({ videoSessionId: sessionId }, { audioId });
  assert.equal(f.sandbox.nativeScreenAudioSession, undefined);
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
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
  await assert.rejects(f.sandbox.startNativeScreenAudio('window:7:0', sessionId), /videoSourceExpired/);
  await f.start();
  const audio = f.sandbox.nativeScreenAudioSession;
  const socket = f.connect();
  f.sandbox.notifyNativeScreenAudioError(audio, 'screenShareAudioTargetUnavailable');
  assert.equal(socket.destroyed, true);
  assert.equal(f.messages.at(-1)[0], 'media:native-screen-audio-error');
  assert.equal(f.messages.at(-1)[1].code, 'screenShareAudioTargetUnavailable');
  await flush();
  assert.equal(f.sandbox.nativeScreenAudioSession, undefined);
  assert.equal(f.sandbox.nativeVideoSession.stopping, false);
  assert.equal(f.sandbox.nativeMicrophoneSession.sessionId, 'separate-microphone');
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
  const sandbox = { projectRoot: 'C:\\project', outputDirectory: 'C:\\project\\release\\desktop', version,
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

test('正式包和开发环境都使用固定 OBS 路径，不通过环境变量切回旧采集', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf('function obsCaptureHostSettings(');
  const end = source.indexOf('const obsHostSettings =', start);
  assert.ok(start >= 0 && end > start);
  for (const packaged of [false, true]) {
    const sandbox = { app: { isPackaged: packaged }, process: { resourcesPath: 'C:\\installed\\resources',
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
  const end = source.indexOf('function notifyNativeVideoError(', start);
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
  assert.equal(captureCommands[0], `start|monitor|${monitorName}|0|0|${sessionId}|60|||1920|1080`);
  assert.equal(spawns[0][2].windowsHide, true);
  assert.equal(spawns[0][2].cwd, 'C:\\obs');
  assert.equal(manager.state.helperVersion, '32.2.2');
  await manager.stop(sessionId);
  assert.equal(manager.state.videoSessionId, undefined);
  await manager.shutdown();
  assert.equal(manager.state, undefined);
});

test('四档目标帧率均传入同一 OBS 宿主，拒绝选项以外的值', async (context) => {
  for (const fps of [30, 60, 120, 180]) {
    const { manager, ready, captureCommands } = fixture(context);
    await ready(fps);
    assert.equal(captureCommands[0].split('|')[6], String(fps));
    assert.equal(manager.state.maxFps, fps);
    await manager.stop(sessionId);
  }
  const { start, spawns } = fixture(context);
  for (const fps of [0, 15, 61, 90, 121, 144, 181, 30.5, NaN, Infinity, '60']) {
    await assert.rejects(start(fps), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 0);
});

test('共享中切换等宿主确认才更新帧率，不更换子进程或会话', async (context) => {
  const { manager, ready, emit, commands, spawns } = fixture(context);
  await ready();
  const state = manager.state;
  for (const [index, fps] of [30, 120, 180, 60].entries()) {
    const previous = state.maxFps;
    const configured = manager.configureVideo(sessionId, fps);
    assert.equal(state.maxFps, previous);
    assert.equal(commands.at(-1), `configure:${index + 1}:${fps}:1920:1080`);
    await assert.rejects(manager.configureVideo(sessionId, fps), /ConfigurationInProgress/);
    emit({ event: 'captureConfigured', requestId: String(index + 1), sessionId, maxFps: fps });
    assert.deepEqual(await configured, { changed: true });
    assert.equal(state.maxFps, fps);
    assert.equal(manager.state, state);
  }
  assert.equal(spawns.length, 1);
  await assert.rejects(manager.configureVideo('old-session', 30), /invalidVideoConfiguration/);
  for (const fps of [0, 61, 90, 144, 181, 30.5, NaN, Infinity, '180']) {
    await assert.rejects(manager.configureVideo(sessionId, fps), /invalidVideoConfiguration/);
  }
});

test('自定义尺寸贯通宿主启动与切换，只在尺寸和帧率均确认后更新，不新增进程', async (context) => {
  const { manager, emit, spawns, commands, captureCommands } = fixture(context);
  const started = manager.start('monitor:7:0', 180, sessionId, { kind: 'monitor', monitorName },
    { hideCursor: false, hideBorder: false }, { width: 2560, height: 1440 });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(-2), ['2560', '1440']);
  const resolution = { width: 640, height: 360 };
  const changing = manager.configureVideo(sessionId, 30, resolution);
  resolution.width = 1280;
  assert.equal(commands.at(-1), 'configure:1:30:640:360');
  assert.deepEqual(manager.state.resolution, { width: 2560, height: 1440 });
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 30, width: 640, height: 360 });
  await changing;
  assert.deepEqual(manager.state.resolution, { width: 640, height: 360 });
  assert.equal(spawns.length, 1);
  for (const size of [null, { width: 3840, height: 2160 }, { width: 2560, height: 1080 }, { width: '1920', height: 1080 }]) {
    await assert.rejects(manager.configureVideo(sessionId, 60, size), /invalidVideoConfiguration/);
  }
  const rejected = assert.rejects(manager.configureVideo(sessionId, 180, { width: 2560, height: 1440 }), /ConfigurationRejected/);
  emit({ event: 'captureConfigurationRejected', requestId: '2', sessionId, maxFps: 30, width: 640, height: 360 });
  await rejected;
  assert.equal(manager.state.maxFps, 30);
  assert.deepEqual(manager.state.resolution, { width: 640, height: 360 });
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
  const rejected = assert.rejects(manager.configureVideo(sessionId, 180, { width: 2560, height: 1440 }), /ConfigurationInvalid/);
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 180, width: 1920, height: 1080 });
  await rejected;
  assert.deepEqual(failures, ['obsCaptureConfigurationInvalid']);
});

test('宿主拒绝切换并恢复原帧率时明确失败，迟到旧响应不完成下一次切换', async (context) => {
  const { manager, ready, emit, failures } = fixture(context);
  await ready();
  const rejected = assert.rejects(manager.configureVideo(sessionId, 180), /ConfigurationRejected/);
  emit({ event: 'captureConfigurationRejected', requestId: '1', sessionId, maxFps: 60 });
  await rejected;
  assert.equal(manager.state.maxFps, 60);
  assert.deepEqual(failures, []);
  const next = manager.configureVideo(sessionId, 180);
  emit({ event: 'captureConfigured', requestId: '1', sessionId, maxFps: 180 });
  assert.equal(manager.state.pendingConfiguration.id, '2');
  emit({ event: 'captureConfigured', requestId: '2', sessionId, maxFps: 180 });
  await next;
  assert.equal(manager.state.maxFps, 180);
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
  const timings = [];
  const sandbox = { performance, writeMediaDiagnostic: async (entry) => timings.push(entry),
    closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => sessionId,
    nativeVideoSourcesById: new Map([['monitor:7:0', { kind: 'monitor', title: monitorName }]]),
    obsCaptureHost: { start: async (...args) => { calls.push(args); return { sessionId, changed: true }; },
      configureVideo: async (...args) => { calls.push(args); return { changed: true }; } },
    mediaHelper: { reserveVideo: async () => ({ kind: 'monitor', monitorName }),
      startVideo: () => assert.fail('显示器不应按画质回到旧采集'),
      configureVideo: () => assert.fail('OBS 会话不应修改旧采集') } };
  runInNewContext(main.slice(start, end), sandbox);
  for (const fps of [30, 60, 120, 180]) {
    sandbox.nativeVideoSession = undefined;
    await sandbox.startNativeVideo('monitor:7:0', fps, { hideCursor: true, hideBorder: false });
    assert.equal(calls.at(-1)[1], fps);
  }
  assert.equal(timings.filter(entry => entry.stage === 'screenVideoStartRequested').length, 4);
  const readyTimings = timings.filter(entry => entry.stage === 'obsReady');
  assert.equal(readyTimings.length, 4);
  assert.ok(readyTimings.every(entry => Number.isFinite(entry.durationMs) && entry.durationMs >= 0));
  const configureStart = main.indexOf("ipcMain.handle('media:native-video:configure',");
  const configureEnd = main.indexOf("ipcMain.handle('media:remote-control:authorize',", configureStart);
  let configure;
  sandbox.ipcMain = { handle: (_name, callback) => { configure = callback; } };
  sandbox.trustedSender = () => true;
  runInNewContext(main.slice(configureStart, configureEnd), sandbox);
  await configure({}, sessionId, 30, { width: 640, height: 360 });
  assert.deepEqual(calls.at(-1), [sessionId, 30, { width: 640, height: 360 }]);
  await configure({}, sessionId, 180, { width: 2560, height: 1440 });
  assert.deepEqual(calls.at(-1), [sessionId, 180, { width: 2560, height: 1440 }]);
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
  const { manager, emit, spawns, captureCommands } = fixture(context);
  const target = { kind: 'window', windowId: '34567', propertyName: 'LycanSync.MediaHelper.Window.1.2.3', propertyValue: '56789' };
  const started = manager.start('window:7:0', 60, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(1), ['window', '34567', '0', '1', sessionId,
    '60', target.propertyName, target.propertyValue, '1920', '1080']);
  await manager.stop(sessionId);
  for (const invalid of [{ ...target, windowId: '0' }, { ...target, propertyValue: '18446744073709551616' },
    { ...target, propertyName: 'window title' }, { ...target, kind: 'monitor' }]) {
    await assert.rejects(manager.start('window:7:0', 60, sessionId, invalid, { hideCursor: false, hideBorder: false }), /invalidObsCaptureArguments/);
  }
  assert.equal(spawns.length, 1);
});

test('游戏来源仍绑定已登记窗口，不接受整屏或丢失的实例标记', async (context) => {
  const { manager, emit, spawns, captureCommands } = fixture(context);
  const target = { kind: 'game', windowId: '34567', propertyName: 'LycanSync.MediaHelper.Window.1.2.3', propertyValue: '56789' };
  const started = manager.start('window:7:0', 120, sessionId, target, { hideCursor: true, hideBorder: true });
  emit({ event: 'captureStarted', helperVersion: '32.2.2' });
  await started;
  assert.deepEqual(captureCommands[0].split('|').slice(1), ['game', '34567', '0', '1', sessionId,
    '120', target.propertyName, target.propertyValue, '1920', '1080']);
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
  const sandbox = { performance, writeMediaDiagnostic: async () => {}, closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
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
      reserveVideo: async () => {
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
  assert.equal(sandbox.nativeVideoSession.sourceKind, 'window');
  await sandbox.stopNativeVideo(sessionId);
  assert.deepEqual(calls, ['reserve', 'classify', 'obs-start', 'obs-stop', 'release']);
  assert.equal(sandbox.nativeVideoSession, undefined);
});

function gameRoutingFixture(classify, startFailure) {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const calls = [];
  let sequence = 0;
  const sandbox = { performance, writeMediaDiagnostic: async () => {}, closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
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
      reserveVideo: async (id) => {
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

test('OBS 远控 IPC 仅接受当前有效整屏；启动、停止、旧会话和窗口均拒绝输入', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const handlers = new Map();
  const calls = [];
  const sandbox = { closing: false, trustedSender: (event) => event.trusted,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    nativeVideoSession: { sessionId, sourceId: 'monitor:7:0', starting: false, stopping: false },
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
    const current = sandbox.nativeVideoSession;
    sandbox.nativeVideoSession = { ...current, ...change };
    assert.throws(authorize, /InvalidSession/);
    assert.throws(input, /InvalidSession/);
    sandbox.nativeVideoSession = current;
  }
  assert.throws(() => handlers.get('media:remote-control:authorize')({ trusted: false }, sessionId, 'control', 'friend'), /InvalidSession/);
  sandbox.closing = true;
  assert.throws(authorize, /InvalidSession/);
  assert.throws(input, /InvalidSession/);
  await handlers.get('media:remote-control:revoke')({ trusted: true }, sessionId, 'control');
  assert.equal(calls.at(-1)[0], 'clearRemoteControl');
});

test('停止先禁用远控并释放按键，再等待 OBS 退出后释放身份；撤销失败仍清理画面且不报成功', async () => {
  for (const revokeFailure of [false, true]) {
    const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
    const calls = [];
    let releaseInput;
    const sandbox = { performance, writeMediaDiagnostic: async () => {}, nativeVideoSession: { sessionId, stopping: false,
      targetState: {}, imported: new Map(), pendingSlotReleases: new Set() },
      nativeScreenAudioSession: undefined, setTimeout, Date, lastStoppedNativeVideoSession: undefined,
      obsCaptureHost: { state: { videoSessionId: sessionId }, stop: async () => {
        calls.push('obs-stop'); sandbox.obsCaptureHost.state = undefined; return { changed: true };
      } },
      mediaHelper: { videoCapture: { sessionId, remoteControl: { controlSessionId: 'control', accepting: true } },
        clearRemoteControl: async () => {
          calls.push('revoke'); sandbox.mediaHelper.videoCapture.remoteControl.accepting = false;
          await new Promise((resolve) => { releaseInput = resolve; });
          if (revokeFailure) throw new Error('remoteControlInputFailed');
          sandbox.mediaHelper.videoCapture.remoteControl = undefined;
          return { changed: true };
        },
        stopVideo: async () => { calls.push('release'); sandbox.mediaHelper.videoCapture = undefined; return { changed: true }; } },
      recordVideoFailure: () => calls.push('report-revoke-failure'), releaseHelperProcessBridge: () => {} };
    runInNewContext(main.slice(main.indexOf('async function stopObsVideo('), main.indexOf('function validMicrophoneSettings(')), sandbox);
    const stopped = sandbox.stopNativeVideo(sessionId);
    const rejected = revokeFailure ? assert.rejects(stopped, /remoteControlInputFailed/) : undefined;
    assert.equal(sandbox.nativeVideoSession.stopping, true);
    assert.equal(sandbox.mediaHelper.videoCapture.remoteControl.accepting, false);
    assert.deepEqual(calls, ['revoke']);
    releaseInput();
    if (revokeFailure) {
      await rejected;
      assert.deepEqual(calls, ['revoke', 'report-revoke-failure', 'obs-stop', 'release']);
      assert.equal(sandbox.nativeVideoSession.stopping, true);
    } else {
      await stopped;
      assert.deepEqual(calls, ['revoke', 'obs-stop', 'release']);
      assert.equal(sandbox.nativeVideoSession, undefined);
    }
  }
});

test('纹理释放超时只在宿主退出及身份释放确认后恢复重开；任一步失败仍阻挡', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  for (const failure of [undefined, 'shutdown', 'identity']) {
    const calls = [], events = [];
    let now = 0;
    const video = { sessionId, targetState: {}, stopping: false, imported: new Map([[0, {}]]), pendingSlotReleases: new Set() };
    const sandbox = { performance, Date: { now: () => now },
      setTimeout: (callback) => { now += 400; queueMicrotask(callback); },
      nativeVideoSession: video, nativeScreenAudioSession: undefined, lastStoppedNativeVideoSession: undefined,
      writeMediaDiagnostic: async entry => events.push(entry),
      releaseNativeVideoImports: () => { calls.push('release-imports'); video.imported.clear(); },
      releaseHelperProcessBridge: () => {},
      obsCaptureHost: { state: { videoSessionId: sessionId },
        shutdown: async force => {
          calls.push('shutdown'); assert.equal(force, true);
          if (failure === 'shutdown') throw new Error('obsCaptureStopUnconfirmed');
          sandbox.obsCaptureHost.state = undefined;
        }, stop: async () => { calls.push('confirm-stopped'); return { changed: false }; } },
      mediaHelper: { videoCapture: { sessionId }, stopVideo: async () => {
        calls.push('release-identity');
        if (failure === 'identity') throw new Error('identityReleaseFailed');
        sandbox.mediaHelper.videoCapture = undefined; return { changed: true };
      } },
    };
    runInNewContext(main.slice(main.indexOf('async function stopObsVideo('), main.indexOf('function validMicrophoneSettings(')), sandbox);
    const stopping = sandbox.stopNativeVideo(sessionId);
    assert.equal(video.stopping, true);
    assert.equal(sandbox.nativeVideoSession, video);
    if (failure) {
      await assert.rejects(stopping, failure === 'shutdown' ? /obsCaptureStopUnconfirmed/ : /identityReleaseFailed/);
      assert.equal(sandbox.nativeVideoSession, video);
      assert.equal(sandbox.lastStoppedNativeVideoSession, undefined);
      assert.ok(!events.some(entry => entry.stage === 'screenVideoStopRecovered'));
      if (failure === 'shutdown') assert.ok(!calls.includes('release-identity'));
    } else {
      await stopping;
      assert.deepEqual(calls, ['release-imports', 'shutdown', 'confirm-stopped', 'release-identity']);
      assert.equal(sandbox.nativeVideoSession, undefined);
      await sandbox.stopNativeVideo(sessionId);
      assert.ok(events.some(entry => entry.stage === 'screenVideoStopRecovered'));
    }
  }
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

test('旧采集迟到清理不释放已复用宿主的新桥接或新来源身份', async () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const current = { videoSessionId: 'new-session' };
  const sandbox = { obsCaptureHost: { state: current, stop: () => assert.fail('不能停止新采集') },
    releaseHelperProcessBridge: () => assert.fail('不能释放新桥接'),
    mediaHelper: { videoCapture: { sessionId: 'new-session' }, stopVideo: () => assert.fail('不能释放新来源') } };
  const stop = runInNewContext(source.slice(source.indexOf('async function stopObsVideo('),
    source.indexOf('async function stopNativeVideo(')) + '; stopObsVideo', sandbox);
  assert.equal((await stop({ sessionId, helperState: current, targetState: {} })).changed, false);
  assert.equal(sandbox.obsCaptureHost.state, current);
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
    bridgeDroppedFrames: 120, screenShareAudio: idleAudio });
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
  const sandbox = { ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: () => true, closing: false,
    mediaHelper: { getDiagnostics: async () => ({ helperVersion: 'rust', framesReceived: 999 }) },
    nativeVideoSession: { sessionId, sourceKind: 'monitor', helperState: { alive: true } },
    obsCaptureHost: { getDiagnostics: async (id) => {
      requested.push(id);
      return { helperVersion: 'observed-version', renderedFrames: 123, bridgeFrames: 3, bridgeDroppedFrames: 120,
        screenShareAudio: { ...idleAudio } };
    } },
    nativeScreenAudioSession: undefined, lastScreenAudioDroppedChunks: 0,
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
  const sandbox = { performance, writeMediaDiagnostic: async () => {}, closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
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

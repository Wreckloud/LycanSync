const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { ObsAudioHostManager } = require('./obs-audio-host.cjs');

const pipeId = '12345678-1234-1234-1234-123456789abc';
const settings = { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true };
const ready = { event: 'ready', obsVersion: '32.2.2', processing: 'sonora-0.2.0',
  sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(context, mode = {}) {
  const children = [], failures = [], diagnostics = [], spawns = [];
  const manager = new ObsAudioHostManager({ platform: 'win32', executablePath: 'C:\\obs\\audio.exe',
    modulePath: 'C:\\obs\\win-wasapi.dll', dataPath: 'C:\\obs\\data', configPath: 'C:\\app\\data\\obs-audio',
    startTimeoutMs: 60, stopTimeoutMs: 20, killTimeoutMs: 20, requestTimeoutMs: 20,
    onFailure: (...args) => failures.push(args), onDiagnostic: entry => diagnostics.push(entry),
    spawnProcess: (...args) => {
      spawns.push(args);
      const child = new EventEmitter();
      child.pid = children.length + 100;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.commands = []; child.kills = 0;
      child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const command = chunk.toString().trim(); child.commands.push(command); done();
        if (command === 'stop' && !mode.stopHang) queueMicrotask(() => {
          child.send({ event: 'stopped' }); child.emit('close', 0);
        });
        if (command.startsWith('configure|') && !mode.configureHang) queueMicrotask(() => {
          child.send({ event: 'configured', requestId: Number(command.split('|')[1]) });
        });
        if (command.startsWith('statistics|') && !mode.statisticsHang) queueMicrotask(() => {
          child.send({ event: 'statistics', requestId: Number(command.split('|')[1]), framesReceived: 960, droppedChunks: 2, sourceState: 1, sourceFrames: 960, pushToTalk: false, transmissionAllowed: true });
        });
      } });
      child.kill = () => { child.kills++; if (!mode.killHang) queueMicrotask(() => child.emit('close', 1)); return true; };
      children.push(child);
      return child;
    },
  });
  context.after(() => { for (const child of children) child.emit('close', 0); });
  const start = () => manager.start(pipeId, 'voice-session', settings);
  const started = async () => { const result = start(); children.at(-1).send(ready); return result; };
  return { manager, children, failures, diagnostics, spawns, start, started };
}

test('麦克风按需启动，首块确认、配置和正常停止只持有一个音频宿主', async context => {
  const { manager, children, diagnostics, spawns, start } = fixture(context);
  assert.equal(children.length, 0);
  const pending = start();
  assert.equal(start(), pending);
  let settled = false; void pending.then(() => { settled = true; });
  await delay(1); assert.equal(settled, false);
  children[0].send(ready);
  assert.equal((await pending).sampleRate, 48000);
  assert.deepEqual(spawns[0][1], ['C:\\obs\\win-wasapi.dll', 'C:\\obs\\data', 'C:\\app\\data\\obs-audio', pipeId, '1|111', 'default', '0']);
  assert.equal(spawns[0][2].windowsHide, true);
  assert.deepEqual(await manager.configure('voice-session', { ...settings, inputGain: 0.6 }), { changed: true });
  assert.deepEqual(await manager.getDiagnostics('voice-session'), { framesReceived: 960, droppedChunks: 2, sourceState: 1, sourceFrames: 960, pushToTalk: false, transmissionAllowed: true });
  assert.equal(diagnostics[0].stage, 'microphoneReady');
  assert.deepEqual(await manager.stop('voice-session'), { changed: true });
  assert.deepEqual(await manager.stop('voice-session'), { changed: false });
  assert.equal(children[0].kills, 0);
  assert.equal(manager.state, undefined);
});

test('启动中取消不等待设备就绪，迟到首块不能恢复旧会话', async context => {
  const { manager, children, start } = fixture(context);
  const pending = start();
  const rejected = assert.rejects(pending, /microphoneCaptureSessionStopped/);
  const stopped = manager.stop('voice-session');
  children[0].send(ready);
  await rejected; await stopped;
  assert.equal(manager.state, undefined);
});

test('麦克风启动仅记录有效阶段耗时，不转发设备或任意正文', async context => {
  const { children, diagnostics, start } = fixture(context);
  const pending = start();
  children[0].send({ ...ready, coreReadyMs: 3, pluginLoadMs: 7, sourceSetupMs: -1, firstBlockWaitMs: 'missing',
    deviceId: 'private-device', message: 'private-message' });
  await pending;
  assert.equal(diagnostics[0].coreReadyMs, 3);
  assert.equal(diagnostics[0].pluginLoadMs, 7);
  assert.equal('sourceSetupMs' in diagnostics[0], false);
  assert.equal('firstBlockWaitMs' in diagnostics[0], false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-device|private-message/);
});

test('指定端点只传给本次采集，不写入诊断；无效端点参数不启动宿主', async context => {
  const { manager, children, diagnostics, spawns } = fixture(context);
  const selected = '{0.0.1.00000000}.{test-microphone}';
  const pending = manager.start(pipeId, 'selected-session', settings, selected);
  children[0].send(ready);
  await pending;
  assert.equal(spawns[0][1].at(-2), selected);
  assert.ok(!JSON.stringify(diagnostics).includes(selected));
  await manager.stop('selected-session');
  await assert.rejects(manager.start(pipeId, 'invalid-session', settings, 'bad\nendpoint'), /invalidMicrophoneCaptureStart/);
  assert.equal(children.length, 1);
});

test('发送授权仅应用当前宿主，模式与批次变化不重启 OBS，取消保留按键模式', async context => {
  const f = fixture(context);
  await f.started();
  f.manager.setTransmission('old-session', true, true, 1);
  assert.equal(f.children[0].commands.length, 0);
  f.manager.setTransmission('voice-session', true, true, 1);
  f.manager.setTransmission('voice-session', true, true, 1);
  assert.deepEqual(f.children[0].commands, ['mode|1\ntransmit|1|350', 'transmit|1|350']);
  f.manager.cancelTransmission('voice-session');
  assert.equal(f.children[0].commands.at(-1), 'transmit|1|0');
  f.manager.setTransmission('voice-session', false, false, 2);
  assert.equal(f.children[0].commands.at(-1), 'mode|0\ntransmit|2|0');
  assert.equal(f.children.length, 1);
  await f.manager.stop('voice-session');
});

test('正常停止后可重启，旧子进程关闭不能清理新会话', async context => {
  const { manager, children, started } = fixture(context);
  await started(); await manager.stop('voice-session'); await started();
  children[0].emit('close', 1);
  assert.equal(manager.state.child, children[1]);
  await manager.dispose();
  await assert.rejects(manager.start(pipeId, 'new', settings), /obsAudioHostDisposed/);
});

test('停止未确认时拒绝下一次采集，不能叠加进程', async context => {
  const { manager, children, started } = fixture(context, { stopHang: true, killHang: true });
  await started();
  const stopped = assert.rejects(manager.stop('voice-session'), /microphoneCaptureStopFailed/);
  await delay(70); await stopped;
  assert.equal(children[0].kills, 1);
  await assert.rejects(manager.start(pipeId, 'new', settings), /microphoneCaptureAlreadyRunning/);
  assert.equal(children.length, 1);
});

test('启动超时与运行失败明确上报并回收', async context => {
  const first = fixture(context);
  const rejected = assert.rejects(first.start(), /microphoneCaptureStartTimedOut/);
  await delay(80); await rejected;
  assert.equal(first.manager.state, undefined);
  const second = fixture(context);
  await second.started();
  second.children[0].send({ event: 'failed', code: 'microphoneDeviceUnavailable' });
  await delay(1);
  assert.deepEqual(second.failures, [['voice-session', 'microphoneDeviceUnavailable']]);
  assert.equal(second.manager.state, undefined);
});

test('启动等待超时后仍接收正常停止确认，保留启动错误并允许手动重试', async context => {
  const f = fixture(context);
  const rejected = assert.rejects(f.start(), /microphoneCaptureStartTimedOut/);
  const state = f.manager.state;
  await delay(80); await rejected;
  assert.deepEqual(await state.stop, { changed: true });
  assert.equal(f.diagnostics.find(entry => entry.stage === 'microphoneHostExited').stopMode, 'graceful');
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].kills, 0);
  await f.started();
  await f.manager.stop('voice-session');
});

test('授权等待中取消，强制退出确认后可以重开；迟到就绪不会恢复旧采集', async context => {
  const f = fixture(context, { stopHang: true });
  const pending = f.start();
  const rejected = assert.rejects(pending, /microphoneCaptureSessionStopped/);
  const stopping = f.manager.stop('voice-session');
  f.children[0].send(ready);
  await rejected;
  await delay(50);
  assert.deepEqual(await stopping, { changed: true });
  assert.equal(f.manager.state, undefined);
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.diagnostics.some(entry => entry.stage === 'microphoneReady'), false);
  assert.equal(f.diagnostics.find(entry => entry.stage === 'microphoneHostExited').stopMode, 'forced');
  await f.started();
  f.children[0].emit('close', 1);
  assert.equal(f.manager.state.child, f.children[1]);
  const stopped = f.manager.stop('voice-session');
  f.children[1].send({ event: 'stopped' });
  f.children[1].emit('close', 0);
  await stopped;
});

test('等待授权超过启动期限，宿主无停止响应但确认强制退出后不锁死开麦', async context => {
  const f = fixture(context, { stopHang: true });
  const rejected = assert.rejects(f.start(), /microphoneCaptureStartTimedOut/);
  const state = f.manager.state;
  await delay(110); await rejected;
  assert.deepEqual(await state.stop, { changed: true });
  assert.equal(f.manager.state, undefined);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.diagnostics.some(entry => entry.stage === 'microphoneStopFailed'), false);
  await f.started();
  const stopped = f.manager.stop('voice-session');
  f.children[1].send({ event: 'stopped' });
  f.children[1].emit('close', 0);
  await stopped;
});

test('意外退出只影响自己的音频会话', async context => {
  const { manager, children, failures, started } = fixture(context);
  await started(); children[0].emit('close', 17);
  assert.deepEqual(failures, [['voice-session', 'microphoneCaptureFailed']]);
  assert.equal(manager.state, undefined);
});

test('诊断超时和迟到统计不会结束语音，配置超时则撤销不确定设置', async context => {
  const { manager, children, failures, started } = fixture(context, { statisticsHang: true, configureHang: true });
  await started();
  const unavailable = assert.rejects(manager.getDiagnostics('voice-session'), /microphoneRequestTimedOut/);
  await delay(30); await unavailable;
  children[0].send({ event: 'statistics', requestId: 1, framesReceived: 480, droppedChunks: 0, sourceState: 1, sourceFrames: 480 });
  assert.equal(manager.state.ready, true); assert.equal(failures.length, 0);
  const rejected = assert.rejects(manager.configure('voice-session', settings), /microphoneRequestTimedOut/);
  await delay(30); await rejected;
  assert.equal(failures.length, 1);
});

test('非法协议、伪造格式和错误响应类型不会当作成功', async context => {
  for (const value of [null, [], { ...ready, channels: 2 }, { event: 'failed', code: 'private/path' }]) {
    const { children, start } = fixture(context);
    const rejected = assert.rejects(start(), /obsAudioProtocolInvalid/);
    children[0].send(value); await rejected;
  }
  const { manager, children, started } = fixture(context, { configureHang: true });
  await started();
  const rejected = assert.rejects(manager.configure('voice-session', settings), /obsAudioProtocolInvalid/);
  children[0].send({ event: 'statistics', requestId: 1, framesReceived: 1, droppedChunks: 0, sourceState: 1, sourceFrames: 1 });
  await rejected;
});

test('不合法配置及错误会话不能启动或更改设备', async context => {
  const { manager, children, started } = fixture(context);
  await assert.rejects(manager.start('not-uuid', 'voice-session', settings), /invalidMicrophoneCaptureStart/);
  await assert.rejects(manager.start(pipeId, 'voice-session', { ...settings, inputGain: NaN }), /invalidMicrophoneCaptureStart/);
  assert.equal(children.length, 0);
  await started();
  await assert.rejects(manager.configure('other', settings), /microphoneCaptureSessionMismatch/);
  await assert.rejects(manager.stop('other'), /microphoneCaptureSessionMismatch/);
  await manager.stop('voice-session');
});

function microphoneBridge() {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('function finishNativeMicrophonePipe(');
  const end = main.indexOf('function handleNativeScreenAudioPipeData(', start);
  const servers = [], requests = [];
  let resolveStart, resolveStop, stopPromise;
  const scope = {
    closing: false, process: { platform: 'win32' }, Buffer, nativeMicrophoneSession: undefined,
    lastMicrophoneDroppedChunks: 0, randomUUID: () => pipeId, validMicrophoneSettings: () => true,
    writeMediaDiagnostic: async () => {}, mainWindow: undefined,
    createServer: () => {
      const server = new EventEmitter();
      server.listen = () => {};
      server.close = () => { server.listening = false; server.closed = true; };
      servers.push(server); return server;
    },
    obsAudioHost: {
      start: (_pipe, session) => { requests.push(['start', session]); return new Promise(resolve => { resolveStart = resolve; }); },
      stop: session => {
        if (!stopPromise) {
          requests.push(['stop', session]); stopPromise = new Promise(resolve => { resolveStop = resolve; });
        }
        return stopPromise;
      },
    },
  };
  runInNewContext(main.slice(start, end), scope);
  const listen = () => { servers.at(-1).listening = true; servers.at(-1).emit('listening'); };
  return { scope, servers, requests, listen,
    ready: () => resolveStart({ sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10 }),
    stopped: () => resolveStop({ changed: true }) };
}

test('主进程在管道尚未监听时撤销，迟到监听会自行关闭且不会创建音频宿主', async () => {
  const f = microphoneBridge();
  const starting = f.scope.startNativeMicrophoneCapture('voice-session', settings);
  const rejected = assert.rejects(starting, /microphoneCaptureSessionStopped/);
  await f.scope.stopNativeMicrophoneCapture('voice-session');
  f.listen(); await rejected;
  assert.equal(f.requests.length, 0);
  assert.equal(f.servers[0].closed, true);
});

test('主进程并发开始复用完整就绪结果，停止不会在宿主退出前关闭管道', async () => {
  const f = microphoneBridge();
  const first = f.scope.startNativeMicrophoneCapture('voice-session', settings);
  const second = f.scope.startNativeMicrophoneCapture('voice-session', settings);
  f.listen(); await delay(0); f.ready();
  assert.equal((await first).channels, 1); assert.equal((await second).channels, 1);
  assert.equal(f.requests.length, 1);
  const stopped = f.scope.stopNativeMicrophoneCapture('voice-session');
  assert.equal(f.servers[0].closed, undefined);
  f.stopped(); await stopped;
  assert.equal(f.servers[0].closed, true);
  assert.equal(f.scope.nativeMicrophoneSession, undefined);
});

test('主进程取消启动中的设备时立即向宿主停止，迟到就绪不能保留会话', async () => {
  const f = microphoneBridge();
  const starting = f.scope.startNativeMicrophoneCapture('voice-session', settings);
  const rejected = assert.rejects(starting, /microphoneCaptureSessionStopped/);
  f.listen(); await delay(0);
  const stopped = f.scope.stopNativeMicrophoneCapture('voice-session');
  assert.deepEqual(f.requests.map(request => request[0]), ['start', 'stop']);
  f.ready(); f.stopped(); await stopped; await rejected;
  assert.equal(f.scope.nativeMicrophoneSession, undefined);
});

test('来源创建失败保留固定原因和 HRESULT，不输出设备或异常正文', async context => {
  const { children, diagnostics, start } = fixture(context);
  const pending = assert.rejects(start(), /microphoneCaptureStartFailed/);
  children[0].send({ event: 'failed', code: 'microphoneCaptureStartFailed', hresult: '0x80070005',
    device: 'private-device', message: 'private-error' });
  await pending; await delay(0);
  assert.deepEqual(diagnostics[0], { stage: 'microphoneSourceFailed', code: 'microphoneCaptureStartFailed', message: '0x80070005' });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-/);
  assert.equal(diagnostics.find(entry => entry.stage === 'microphoneHostExited').exitCode, 0);
});

test('主进程和宿主同时收尾时强制退出仍确认停止，退出后可重新开麦', async context => {
  const f = fixture(context, { stopHang: true });
  const bridge = microphoneBridge();
  bridge.scope.obsAudioHost = f.manager;
  bridge.scope.writeMediaDiagnostic = async entry => { f.diagnostics.push(entry); };
  f.manager.onFailure = (_sessionId, code) => {
    bridge.scope.notifyNativeMicrophoneError(bridge.scope.nativeMicrophoneSession, code);
  };
  const starting = bridge.scope.startNativeMicrophoneCapture('voice-session', settings);
  bridge.listen(); await delay(0); f.children[0].send(ready); await starting;
  f.children[0].send({ event: 'failed', code: 'microphoneCapturePipeFailed' });
  await delay(70);
  assert.equal(f.diagnostics.filter(entry => entry.stage === 'microphoneStopFailed').length, 0);
  assert.equal(f.diagnostics.find(entry => entry.stage === 'microphoneHostExited').stopMode, 'forced');
  assert.equal(f.manager.state, undefined);
  assert.equal(bridge.scope.nativeMicrophoneSession, undefined);
  const restarting = bridge.scope.startNativeMicrophoneCapture('new-session', settings);
  bridge.listen(); await delay(0); f.children[1].send(ready); await restarting;
  const stopping = bridge.scope.stopNativeMicrophoneCapture('new-session');
  f.children[1].send({ event: 'stopped' }); f.children[1].emit('close', 0); await stopping;
  assert.equal(f.children.length, 2);
});

test('管道故障保留固定阶段和 Win32 错误，不透传设备或任意阶段', async context => {
  const f = fixture(context);
  await f.started();
  f.children[0].send({ event: 'failed', code: 'microphoneCapturePipeFailed', pipePhase: 'writeWait',
    win32Error: 258, device: 'private-device', message: 'private-message' });
  await delay(0);
  assert.deepEqual(f.diagnostics[1], { stage: 'microphoneSourceFailed', code: 'microphoneCapturePipeFailed',
    pipePhase: 'writeWait', win32Error: 258 });
  const second = fixture(context);
  await second.started();
  second.children[0].send({ event: 'failed', code: 'microphoneCapturePipeFailed', pipePhase: 'private-path', win32Error: -1 });
  await delay(0);
  assert.deepEqual(second.diagnostics[1], { stage: 'microphoneSourceFailed', code: 'microphoneCapturePipeFailed' });
  assert.doesNotMatch(JSON.stringify([f.diagnostics, second.diagnostics]), /private-/);
});

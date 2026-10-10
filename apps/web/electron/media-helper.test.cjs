const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { MediaHelperManager } = require('./media-helper.cjs');
const { matchNativeVideoSourceThumbnails } = require('./native-video-thumbnails.cjs');

test('main-process video entry accepts 120 fps before forwarding to the helper', async () => {
  // 执行实际入口函数，隔离 Electron 和设备，避免只验证下游而漏掉主进程上限。
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function startNativeVideo(');
  const end = main.indexOf('async function stopNativeVideo(', start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const invoke = runInNewContext(`${main.slice(start, end)}; startNativeVideo`, {
    closing: false, process: { platform: 'win32' }, nativeVideoSession: undefined,
    nativeMediaBridge: {}, randomUUID: () => 'main-quality-session',
    mediaHelper: { startVideo: async (...args) => {
      requests.push(args);
      return { sessionId: args[2], changed: true };
    } },
    recordVideoFailure: () => assert.fail('valid start must not fail'),
    releaseNativeVideoImports: () => assert.fail('valid start must not need cleanup'),
  });
  await invoke('window:1:0', 120, { hideCursor: false, hideBorder: false });
  assert.equal(requests[0][1], 120);
  await assert.rejects(invoke('window:1:0', 121, {}), /invalidVideoStart/);
  assert.equal(requests.length, 1);
});

const capabilities = {
  videoCapture: { available: false, reason: 'videoOutputNotImplemented' },
  captureProbe: { available: true, reason: 'windowsGraphicsCapture' },
  videoSourceDiscovery: { available: true, reason: 'windowsGraphicsCapture' },
  microphoneCapture: { available: true, reason: 'windowsWasapiSharedModeSonora' },
  systemAudioCapture: { available: false, reason: 'notImplemented' },
  processAudioCapture: { available: false, reason: 'notImplemented' },
  screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' },
};

class FakeHelper extends EventEmitter {
  constructor(mode = {}) {
    super();
    this.mode = mode;
    this.commands = [];
    this.killCount = 0;
    this.closed = false;
    this.capabilitiesCount = 0;
    this.sourceRevision = 0;
    this.captureState = 'idle';
    this.captureSessionId = null;
    this.videoState = 'idle';
    this.videoSessionId = null;
    this.screenAudioState = 'idle';
    this.screenAudioSessionId = null;
    this.microphoneState = 'idle';
    this.microphoneSessionId = null;
    this.requests = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.mode.writeFailure) {
          callback(new Error('fake write failure'));
          return;
        }
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const command = JSON.parse(line);
          this.requests.push(command);
          this.handleCommand(command);
        }
        callback();
      },
      final: (callback) => {
        if (!this.mode.shutdownHang) this.exit(0);
        callback();
      },
    });
  }

  handleCommand(command) {
    this.commands.push(command.command);
    if (command.command === 'hello') {
      if (this.mode.helloTimeout) return;
      const response = { event: 'hello', protocolVersion: 1, requestId: command.requestId, helperVersion: 'test' };
      if (this.mode.wrongVersion) response.protocolVersion = 2;
      if (this.mode.wrongRequestId) response.requestId = 'unexpected';
      this.writeResponse(response);
      return;
    }
    if (command.command === 'capabilities') {
      this.capabilitiesCount += 1;
      if (this.mode.capabilitiesTimeout
          || (this.mode.capabilitiesHangAfterFirst && this.capabilitiesCount > 1)) return;
      if (this.mode.invalidJson) { this.stdout.write('not-json\n'); return; }
      if (this.mode.invalidUtf8) { this.stdout.write(Buffer.from([0xc3, 0x28, 0x0a])); return; }
      if (this.mode.outputTooLong) { this.stdout.write(`${'x'.repeat(64 * 1024 + 1)}\n`); return; }
      if (this.mode.capabilitiesExit) {
        setImmediate(() => this.exit(17));
        return;
      }
      const response = {
        event: 'capabilities', protocolVersion: 1, requestId: command.requestId, state: 'idle',
        windowsOnly: true, ...capabilities, ...this.mode.capabilityOverrides,
      };
      if (this.mode.wrongCapabilitiesRequestId) response.requestId = 'unexpected';
      this.writeResponse(response);
      return;
    }
    if (command.command === 'listVideoSources') {
      if (this.mode.holdVideoSources) return;
      if (this.mode.listVideoSourcesFailure) {
        this.writeResponse({ event: 'error', protocolVersion: 1, requestId: command.requestId,
          code: 'sourceDiscoveryFailed', message: 'source discovery failed', recoverable: true, state: 'idle' });
        return;
      }
      this.sourceRevision += 1;
      this.writeResponse({
        event: 'videoSources', protocolVersion: 1, requestId: command.requestId,
        revision: this.sourceRevision,
        sources: [{ sourceId: `monitor:${this.sourceRevision}:0`, kind: 'monitor', title: 'DISPLAY1',
          width: 1920, height: 1080, primary: true }],
      });
      return;
    }
    if (command.command === 'startCaptureProbe') {
      if (this.mode.captureProbeStartTimeout) return;
      this.captureState = 'running';
      this.captureSessionId = command.sessionId;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      if (this.mode.exitAfterCaptureProbeStart) setImmediate(() => this.exit(18));
      return;
    }
    if (command.command === 'startVideo') {
      if (this.mode.videoStartTimeout) return;
      this.videoState = 'running';
      this.videoSessionId = command.sessionId;
      if (!this.mode.omitSharedTextureFrame) {
        this.writeResponse({
          event: 'sharedTextureFrame', protocolVersion: 1, sessionId: command.sessionId,
          slotIndex: 0, sourceHandleHex: '0000000000000001', pixelFormat: 'bgra',
          codedSize: { width: command.targetWidth, height: command.targetHeight },
          contentSize: { width: command.targetWidth, height: command.targetHeight }, timestampMicros: 1,
        });
      }
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      if (this.mode.exitAfterVideoStart) setImmediate(() => this.exit(19));
      return;
    }
    if (command.command === 'configureVideo') {
      if (this.mode.holdVideoConfiguration) return;
      if (this.mode.videoConfigurationFailure) {
        this.writeResponse({ event: 'error', protocolVersion: 1, requestId: command.requestId,
          code: 'captureSessionMismatch', message: 'capture session mismatch', recoverable: true, state: 'running' });
        return;
      }
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: 'configureVideo', state: 'running', changed: true });
      return;
    }
    if (command.command === 'startScreenShareAudio') {
      if (this.mode.holdScreenAudioStart) return;
      const acknowledge = () => {
        if (this.closed) return;
        this.screenAudioState = 'running';
        this.screenAudioSessionId = command.sessionId;
        this.writeResponse({ event: 'screenShareAudioStarted', protocolVersion: 1,
          requestId: command.requestId, sessionId: command.sessionId, state: 'running',
          sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
      };
      if (this.mode.screenAudioStartDelayMs) setTimeout(acknowledge, this.mode.screenAudioStartDelayMs);
      else acknowledge();
      return;
    }
    if (command.command === 'startMicrophoneCapture') {
      if (this.mode.holdMicrophoneStart) {
        this.pendingMicrophoneStart = command;
        return;
      }
      const acknowledge = () => {
        if (this.closed) return;
        this.microphoneState = 'running';
        this.microphoneSessionId = command.sessionId;
        this.writeResponse({ event: 'microphoneCaptureStarted', protocolVersion: 1,
          requestId: command.requestId, sessionId: command.sessionId, state: 'running',
          sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
      };
      if (this.mode.microphoneStartDelayMs) setTimeout(acknowledge, this.mode.microphoneStartDelayMs);
      else acknowledge();
      return;
    }
    if (command.command === 'configureMicrophoneCapture' || command.command === 'stopMicrophoneCapture') {
      if (command.command === 'stopMicrophoneCapture') {
        this.microphoneState = 'idle';
        this.microphoneSessionId = null;
      }
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (command.command === 'stopScreenShareAudio') {
      this.screenAudioState = 'idle';
      this.screenAudioSessionId = null;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (command.command === 'releaseSharedTextureSlot') {
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (['setRemoteControl', 'remoteInput', 'clearRemoteControl'].includes(command.command)) {
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (command.command === 'stopVideo') {
      if (this.mode.videoStopTimeout) return;
      this.videoState = 'idle';
      this.videoSessionId = null;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'idle', changed: true });
      return;
    }
    if (command.command === 'stopCaptureProbe') {
      if (this.mode.captureProbeStopTimeout) return;
      this.captureState = 'idle';
      this.captureSessionId = null;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'idle', changed: true });
      return;
    }
    if (command.command === 'diagnostics') {
      if (this.mode.captureEndsBeforeDiagnostics) {
        this.captureState = 'idle';
        this.captureSessionId = null;
      }
      const diagnostics = {
        event: 'diagnostics', protocolVersion: 1, requestId: command.requestId,
        state: this.captureState, sessionId: this.captureSessionId,
        available: true, sourceKind: this.captureState === 'running' ? 'monitor' : null,
        microphoneCaptureDroppedChunks: 0,
        frameWidth: this.captureState === 'running' ? 1920 : null,
        frameHeight: this.captureState === 'running' ? 1080 : null,
        framesReceived: this.captureState === 'running' ? 20 : null,
        framesProcessed: this.captureState === 'running' ? 20 : null,
        droppedNotifications: this.captureState === 'running' ? 0 : null,
        rawCaptureFps: this.captureState === 'running' ? 60 : null,
        probeProcessedFps: this.captureState === 'running' ? 60 : null,
        rawFrameIntervalP50Ms: null, rawFrameIntervalP95Ms: null, rawFrameIntervalP99Ms: null,
        rawTimestampAnomalies: 0, lastFrameAgeMs: 0, sizeChanges: 0, framePoolRecreates: 0,
        lastCaptureError: null, stopDurationMs: null,
        screenShareAudio: { state: this.screenAudioState, sessionId: this.screenAudioSessionId,
          sourceKind: this.screenAudioState === 'running' ? 'monitor' : null,
          sampleRate: this.screenAudioState === 'running' ? 48000 : null,
          channels: this.screenAudioState === 'running' ? 2 : null,
          packetsReceived: this.screenAudioState === 'running' ? 20 : null,
          framesReceived: this.screenAudioState === 'running' ? 9600 : null,
          silentPackets: 0, droppedAudioChunks: 0, lastError: null },
      };
      if (this.mode.omitFramePoolRecreates) delete diagnostics.framePoolRecreates;
      if (this.mode.omitMicrophoneCaptureDroppedChunks) delete diagnostics.microphoneCaptureDroppedChunks;
      if (this.mode.captureSuspended !== undefined) diagnostics.captureSuspended = this.mode.captureSuspended;
      this.writeResponse(diagnostics);
      return;
    }
    if (command.command === 'shutdown' && !this.mode.shutdownHang) {
      this.writeResponse({
        event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: 'shutdown', state: 'idle', changed: false,
      });
    }
  }

  writeResponse(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    this.killCount += 1;
    if (this.mode.killNoClose) return true;
    setImmediate(() => this.exit(1));
    return true;
  }

  exit(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', code, null);
    this.stdout.end();
    this.emit('close', code, null);
  }
}

function createManager(mode = {}, options = {}) {
  const children = [];
  const spawnOptions = [];
  const manager = new MediaHelperManager({
    executablePath: 'fake-media-helper.exe',
    platform: 'win32',
    spawnProcess: (_executable, _args, options) => {
      spawnOptions.push(options);
      const child = new FakeHelper(mode);
      children.push(child);
      return child;
    },
    createRequestId: (() => { let next = 0; return () => `request-${++next}`; })(),
    handshakeTimeoutMs: 40,
    requestTimeoutMs: 80,
    audioStartTimeoutMs: 80,
    shutdownTimeoutMs: 40,
    killTimeoutMs: 40,
    idleTimeoutMs: 1000,
    retryDelayMs: 20,
    ...options,
  });
  return { manager, children, spawnOptions };
}

test('native chooser previews require one exact title and kind match on both sides', () => {
  const videoSources = [
    { sourceId: 'window:4:0', kind: 'window', title: 'Notepad' },
    { sourceId: 'window:4:1', kind: 'window', title: 'Duplicate' },
    { sourceId: 'window:4:2', kind: 'window', title: 'Duplicate' },
    { sourceId: 'monitor:4:0', kind: 'monitor', title: 'DISPLAY1' },
  ];
  const desktopSources = [
    { id: 'window:99:secret', name: 'Notepad', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,notepad' } },
    { id: 'window:100:secret', name: 'Duplicate', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,ambiguous' } },
    { id: 'window:101:secret', name: 'Duplicate', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,ambiguous' } },
    { id: 'screen:0:secret', name: 'DISPLAY1', type: 'screen', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,display' } },
    { id: 'screen:1:secret', name: 'Notepad', type: 'screen', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,wrong-kind' } },
  ];

  assert.deepEqual(matchNativeVideoSourceThumbnails(videoSources, desktopSources), [
    { sourceId: 'window:4:0', thumbnail: 'data:image/png;base64,notepad' },
    { sourceId: 'monitor:4:0', thumbnail: 'data:image/png;base64,display' },
  ]);
});

test('native chooser skips empty and over-budget preview images', () => {
  const sources = [
    { sourceId: 'window:1:0', kind: 'window', title: 'Empty' },
    { sourceId: 'window:1:1', kind: 'window', title: 'Large' },
  ];
  const desktopSources = [
    { name: 'Empty', type: 'window', thumbnail: { isEmpty: () => true, toDataURL: () => '' } },
    { name: 'Large', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => `data:image/png;base64,${'x'.repeat(40 * 1024)}` } },
  ];
  assert.deepEqual(matchNativeVideoSourceThumbnails(sources, desktopSources), []);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test timed out waiting for fake helper state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('helper stderr 保留原生错误并且不干扰协议响应', async () => {
  const diagnostics = [];
  const { manager, children } = createManager({}, { onDiagnostic: (message) => diagnostics.push(message) });
  try {
    await manager.getCapabilities();
    children[0].stderr.write('stage=initialize hresult=0x80070057\n');
    children[0].stderr.write('x'.repeat(9000));
    assert.equal(diagnostics[0], 'stage=initialize hresult=0x80070057\n');
    assert.ok(diagnostics.every((message) => message.length <= 4096));
    assert.deepEqual((await manager.getCapabilities()).videoCapture, capabilities.videoCapture);
  } finally {
    await manager.shutdown();
  }
});

test('helper starts lazily and concurrent capability requests share one process and handshake', async () => {
  const { manager, children, spawnOptions } = createManager();
  assert.equal(children.length, 0);

  const results = await Promise.all(Array.from({ length: 6 }, () => manager.getCapabilities()));
  assert.equal(children.length, 1);
  assert.deepEqual(spawnOptions[0].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(children[0].commands.filter((command) => command === 'hello').length, 1);
  assert.equal(children[0].commands.filter((command) => command === 'capabilities').length, 1);
  assert.deepEqual(results[0].videoCapture, capabilities.videoCapture);
  await manager.shutdown();
});

test('来源记忆使用 helper 生命周期标识，重启实例不能复用旧标识', async () => {
  const first = createManager();
  const second = createManager();
  try {
    const snapshot = await first.manager.listVideoSources();
    assert.equal((await first.manager.listVideoSources()).discoveryId, snapshot.discoveryId);
    assert.match(snapshot.discoveryId, /^[0-9a-f-]{36}$/);
    assert.notEqual((await second.manager.listVideoSources()).discoveryId, snapshot.discoveryId);
  } finally {
    await Promise.all([first.manager.shutdown(), second.manager.shutdown()]);
  }
});

test('screen-share audio capability distinguishes process loopback from explicit system mix', async () => {
  const { manager: processManager } = createManager();
  assert.deepEqual((await processManager.getCapabilities()).screenShareAudioCapture,
    { available: true, reason: 'windowsApplicationLoopbackProcessTree' });
  await processManager.shutdown();

  const { manager: mixManager } = createManager({ capabilityOverrides: {
    screenShareAudioCapture: { available: true, reason: 'windowsSystemMixLoopback' },
  } });
  assert.deepEqual((await mixManager.getCapabilities()).screenShareAudioCapture,
    { available: true, reason: 'windowsSystemMixLoopback' });
  await mixManager.shutdown();
});

test('screen-share audio capability rejects unknown modes and inconsistent availability', async (t) => {
  for (const capability of [
    { available: true, reason: 'futureGenericAudioCapture' },
    { available: false, reason: 'windowsSystemMixLoopback' },
    { available: true, reason: 'windowsEventDrivenLoopbackRequiresBuild15063' },
  ]) {
    await t.test(JSON.stringify(capability), async () => {
      const { manager, children } = createManager({ capabilityOverrides: { screenShareAudioCapture: capability } });
      await assert.rejects(manager.getCapabilities(), /mediaHelperInvalidCapabilities/);
      await waitUntil(() => children[0]?.closed);
      await manager.shutdown();
    });
  }
});

test('handshake timeout, wrong protocol version, and wrong request id reject and clean the child', async (t) => {
  for (const mode of [{ helloTimeout: true }, { wrongVersion: true }, { wrongRequestId: true }]) {
    await t.test(JSON.stringify(mode), async () => {
      const { manager, children } = createManager(mode);
      await assert.rejects(manager.getCapabilities());
      await waitUntil(() => children[0]?.closed);
      assert.equal(children[0].killCount, 1);
      await manager.shutdown();
    });
  }
});

test('unexpected helper exit rejects pending capability request and allows only a later controlled retry', async () => {
  const { manager, children } = createManager({ capabilitiesExit: true });
  await assert.rejects(manager.getCapabilities(), /mediaHelperExited:17/);
  assert.equal(children.length, 1);
  await assert.rejects(manager.getCapabilities(), /mediaHelperRetryDelayed/);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('malformed output, oversized lines, request timeouts, and write failures reject requests and kill the child', async (t) => {
  for (const mode of [
    { invalidJson: true },
    { invalidUtf8: true },
    { outputTooLong: true },
    { capabilitiesTimeout: true },
    { writeFailure: true },
    { wrongCapabilitiesRequestId: true },
  ]) {
    await t.test(JSON.stringify(mode), async () => {
      const { manager, children } = createManager(mode);
      await assert.rejects(manager.getCapabilities());
      await waitUntil(() => children[0]?.closed);
      assert.equal(children[0].killCount, 1);
      await manager.shutdown();
    });
  }
});

test('idle helper receives shutdown and closes normally', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0]?.closed);
  assert.equal(children[0].commands.at(-1), 'shutdown');
  assert.equal(children[0].killCount, 0);
  await manager.shutdown();
});

test('probe holds helper past the idle timeout, deduplicates start and stop, and returns bounded diagnostics', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  const sources = await manager.listVideoSources();
  assert.equal(sources.revision, 1);
  assert.equal(children[0].captureState, 'idle');
  assert.equal(children[0].commands.includes('startCaptureProbe'), false);

  const initialStart = manager.startCaptureProbe(sources.sources[0].sourceId);
  const concurrentStart = manager.startCaptureProbe(sources.sources[0].sourceId);
  const [firstStart, concurrentStartResult] = await Promise.all([initialStart, concurrentStart]);
  assert.equal(firstStart.changed, true);
  assert.deepEqual(concurrentStartResult, firstStart);
  const duplicateStart = await manager.startCaptureProbe(sources.sources[0].sourceId);
  assert.deepEqual(duplicateStart, { ...firstStart, changed: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(children[0].closed, false);
  assert.equal(children[0].commands.filter((command) => command === 'startCaptureProbe').length, 1);

  const diagnostics = await manager.getDiagnostics();
  assert.equal(diagnostics.state, 'running');
  assert.equal(diagnostics.framesReceived, 20);
  assert.equal(diagnostics.framePoolRecreates, 0);
  const [stop, concurrentStop] = await Promise.all([
    manager.stopCaptureProbe(firstStart.sessionId),
    manager.stopCaptureProbe(firstStart.sessionId),
  ]);
  assert.deepEqual(stop, { changed: true });
  assert.deepEqual(concurrentStop, stop);
  assert.deepEqual(await manager.stopCaptureProbe(firstStart.sessionId), { changed: false });
  assert.equal(children[0].commands.filter((command) => command === 'stopCaptureProbe').length, 1);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('refresh invalidates old source ids before they can start a probe', async () => {
  const { manager, children } = createManager();
  const first = await manager.listVideoSources();
  const second = await manager.listVideoSources();
  assert.notEqual(first.sources[0].sourceId, second.sources[0].sourceId);
  await assert.rejects(manager.startCaptureProbe(first.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children[0].commands.includes('startCaptureProbe'), false);
  await manager.shutdown();
});

test('video shares a bounded helper session, applies the requested frame rate, and returns texture notifications', async () => {
  const receivedFrames = [];
  const { manager, children } = createManager({}, {
    idleTimeoutMs: 20,
    onSharedTextureFrame: (_state, frame) => receivedFrames.push(frame),
  });
  const sources = await manager.listVideoSources();
  const started = await manager.startVideo(sources.sources[0].sourceId, 30, 'video-session', { hideCursor: true, hideBorder: false });
  assert.deepEqual(started, { sessionId: 'video-session', changed: true });
  assert.equal(receivedFrames.length, 1);
  assert.equal(receivedFrames[0].sessionId, 'video-session');
  const startRequest = children[0].requests.find((request) => request.command === 'startVideo');
  assert.equal(startRequest.maxFps, 30);
  assert.equal(startRequest.hideCursor, true);
  assert.equal(startRequest.hideBorder, false);
  assert.equal(startRequest.targetWidth, 1920);
  assert.equal(children[0].closed, false);
  await assert.rejects(manager.startVideo(sources.sources[0].sourceId, 60, 'second-session'), /videoCaptureAlreadyRunning/);

  await manager.releaseSharedTextureSlot('video-session', 0);
  assert.deepEqual(await manager.stopVideo('video-session'), { changed: true });
  assert.deepEqual(await manager.stopVideo('video-session'), { changed: false });
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('screen-share audio is bound to the active video source and stops idempotently', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  const snapshot = await manager.listVideoSources();
  await manager.startVideo(snapshot.sources[0].sourceId, 30, 'video-session');
  const format = await manager.startScreenShareAudio(snapshot.sources[0].sourceId,
    '58d00436-8ac2-4d0c-9283-9d5d5f70ed01', 'video-session');
  assert.deepEqual(format, { sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
  assert.equal(children[0].requests.at(-1).pipeId, '58d00436-8ac2-4d0c-9283-9d5d5f70ed01');
  assert.deepEqual(await manager.stopScreenShareAudio('video-session'), { changed: true });
  assert.deepEqual(await manager.stopScreenShareAudio('video-session'), { changed: false });
  await manager.stopVideo('video-session');
  await manager.shutdown();
});

test('native microphone capture validates settings, configures the active session, and stops idempotently', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  const settings = { inputGain: 0.8, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false };
  const pipeId = '58d00436-8ac2-4d0c-9283-9d5d5f70ed01';
  const sessionId = 'microphone-session';
  const started = await manager.startMicrophoneCapture(pipeId, sessionId, settings);
  assert.deepEqual(started, { sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
  assert.deepEqual(await manager.startMicrophoneCapture(pipeId, sessionId, settings), { ...started, changed: false });
  await assert.rejects(manager.startMicrophoneCapture(pipeId, 'other-session', settings), /microphoneCaptureAlreadyRunning/);
  assert.deepEqual(await manager.configureMicrophoneCapture(sessionId, { ...settings, inputGain: 1.2 }), { changed: true });
  assert.deepEqual(await manager.stopMicrophoneCapture(sessionId), { changed: true });
  assert.deepEqual(await manager.stopMicrophoneCapture(sessionId), { changed: false });
  assert.equal(children[0].requests.filter((request) => request.command === 'startMicrophoneCapture').length, 1);
  assert.equal(children[0].requests.find((request) => request.command === 'startMicrophoneCapture').pipeId, pipeId);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('microphone startup allows the Rust worker startup deadline beyond the general request timeout', async () => {
  const { manager, children } = createManager({ microphoneStartDelayMs: 65 }, {
    requestTimeoutMs: 30,
    audioStartTimeoutMs: 150,
  });
  const settings = { inputGain: 1, noiseSuppression: false, autoGainControl: false, voiceEnhancement: false };
  const sessionId = 'delayed-microphone-session';
  const started = await manager.startMicrophoneCapture(
    '58d00436-8ac2-4d0c-9283-9d5d5f70ed01', sessionId, settings,
  );
  assert.equal(started.changed, true);
  assert.equal(children[0].killCount, 0);
  await manager.stopMicrophoneCapture(sessionId);
  await manager.shutdown();
});

test('screen-share audio startup uses its own deadline beyond the general request timeout', async () => {
  const { manager, children } = createManager({ screenAudioStartDelayMs: 65 }, {
    requestTimeoutMs: 30,
    audioStartTimeoutMs: 150,
  });
  try {
    const sources = await manager.listVideoSources();
    await manager.startVideo(sources.sources[0].sourceId, 30, 'delayed-video-session');
    const started = await manager.startScreenShareAudio(sources.sources[0].sourceId,
      '58d00436-8ac2-4d0c-9283-9d5d5f70ed01', 'delayed-video-session');
    assert.equal(started.changed, true);
    assert.equal(children[0].killCount, 0);
    await manager.stopScreenShareAudio('delayed-video-session');
    await manager.stopVideo('delayed-video-session');
  } finally {
    await manager.shutdown();
  }
});

test('audio startup deadline failure clears sessions and reaps the helper before an explicit retry', async (t) => {
  for (const kind of ['microphone', 'screenAudio']) {
    await t.test(kind, async () => {
      const mode = kind === 'microphone' ? { holdMicrophoneStart: true } : { holdScreenAudioStart: true };
      const { manager, children } = createManager(mode, {
        requestTimeoutMs: 150,
        audioStartTimeoutMs: 30,
        retryDelayMs: 0,
      });
      const pipeId = '58d00436-8ac2-4d0c-9283-9d5d5f70ed01';
      const settings = { inputGain: 1, noiseSuppression: false, autoGainControl: false, voiceEnhancement: false };
      try {
        let start;
        if (kind === 'microphone') {
          start = manager.startMicrophoneCapture(pipeId, 'timed-out-microphone', settings);
        } else {
          const sources = await manager.listVideoSources();
          await manager.startVideo(sources.sources[0].sourceId, 30, 'timed-out-video');
          start = manager.startScreenShareAudio(sources.sources[0].sourceId, pipeId, 'timed-out-video');
        }
        const command = kind === 'microphone' ? 'startMicrophoneCapture' : 'startScreenShareAudio';
        await assert.rejects(start, new RegExp(`mediaHelperTimeout:${command}`));
        await waitUntil(() => children[0].closed);
        assert.equal(children[0].killCount, 1);
        assert.equal(manager.microphoneCapture, undefined);
        assert.equal(manager.microphoneCaptureStart, undefined);
        assert.equal(manager.microphoneCaptureStartingSessionId, undefined);
        assert.equal(manager.screenShareAudio, undefined);
        assert.equal(manager.screenShareAudioStart, undefined);
        assert.equal(manager.videoCapture, undefined);
        assert.equal(children.length, 1);

        mode.holdMicrophoneStart = false;
        mode.holdScreenAudioStart = false;
        if (kind === 'microphone') {
          assert.equal((await manager.startMicrophoneCapture(pipeId, 'retry-microphone', settings)).changed, true);
          await manager.stopMicrophoneCapture('retry-microphone');
        } else {
          const sources = await manager.listVideoSources();
          await manager.startVideo(sources.sources[0].sourceId, 30, 'retry-video');
          assert.equal((await manager.startScreenShareAudio(sources.sources[0].sourceId, pipeId, 'retry-video')).changed, true);
          await manager.stopScreenShareAudio('retry-video');
          await manager.stopVideo('retry-video');
        }
        assert.equal(children.length, 2);
      } finally {
        await manager.shutdown();
      }
    });
  }
});

test('stopping the native microphone while start is pending waits for start then stops the same session', async () => {
  const { manager, children } = createManager({ holdMicrophoneStart: true });
  const settings = { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true };
  const sessionId = 'pending-microphone-session';
  const start = manager.startMicrophoneCapture('58d00436-8ac2-4d0c-9283-9d5d5f70ed01', sessionId, settings);
  await waitUntil(() => children[0]?.pendingMicrophoneStart);
  const stop = manager.stopMicrophoneCapture(sessionId);
  children[0].writeResponse({ event: 'microphoneCaptureStarted', protocolVersion: 1,
    requestId: children[0].pendingMicrophoneStart.requestId, sessionId, state: 'running',
    sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
  await start;
  assert.deepEqual(await stop, { changed: true });
  assert.deepEqual(children[0].commands.slice(-2), ['startMicrophoneCapture', 'stopMicrophoneCapture']);
  await manager.shutdown();
});

test('screen-share audio rejects stale source ids and mismatched video sessions', async () => {
  const { manager, children } = createManager();
  const snapshot = await manager.listVideoSources();
  await manager.startVideo(snapshot.sources[0].sourceId, 30, 'video-session');
  const pipeId = '58d00436-8ac2-4d0c-9283-9d5d5f70ed01';
  await assert.rejects(manager.startScreenShareAudio(snapshot.sources[0].sourceId, pipeId, 'other-session'), /videoSourceExpired/);
  await manager.listVideoSources();
  await assert.rejects(manager.startScreenShareAudio(snapshot.sources[0].sourceId, pipeId, 'video-session'), /videoSourceExpired/);
  assert.equal(children[0].commands.includes('startScreenShareAudio'), false);
  await manager.stopVideo('video-session');
  await manager.shutdown();
});

test('video capture end events are session-scoped and delivered once', async () => {
  const ended = [];
  const { manager, children } = createManager({}, {
    onVideoCaptureEnded: (_state, event) => ended.push(event),
  });
  const sources = await manager.listVideoSources();
  await manager.startVideo(sources.sources[0].sourceId, 30, 'video-ended');
  const helper = children[0];
  const report = (sessionId) => helper.writeResponse({
    event: 'videoCaptureEnded', protocolVersion: 1, sessionId, code: 'captureTargetClosed',
  });

  report('old-video');
  report('video-ended');
  report('video-ended');
  assert.deepEqual(ended, [{ sessionId: 'video-ended', code: 'captureTargetClosed' }]);

  await manager.stopVideo('video-ended');
  await manager.shutdown();
});

test('video suspension events follow only the active session and state transitions', async () => {
  const statuses = [];
  const { manager, children } = createManager({}, {
    onVideoCaptureSuspended: (_state, status) => statuses.push(status),
  });
  const sources = await manager.listVideoSources();
  await manager.startVideo(sources.sources[0].sourceId, 30, 'video-suspended');
  const helper = children[0];
  const report = (sessionId, suspended) => helper.writeResponse({
    event: 'videoCaptureSuspended', protocolVersion: 1, sessionId, suspended,
  });

  report('old-video', true);
  report('video-suspended', true);
  report('video-suspended', true);
  report('video-suspended', false);
  assert.deepEqual(statuses, [
    { sessionId: 'video-suspended', suspended: true },
    { sessionId: 'video-suspended', suspended: false },
  ]);

  await manager.stopVideo('video-suspended');
  report('video-suspended', true);
  assert.equal(statuses.length, 2);
  await manager.shutdown();
});

test('diagnostics distinguish a minimized window from healthy frame delivery', async () => {
  const { manager } = createManager({ captureSuspended: true });
  const sources = await manager.listVideoSources();
  const started = await manager.startCaptureProbe(sources.sources[0].sourceId);
  const diagnostics = await manager.getDiagnostics();
  assert.equal(diagnostics.state, 'running');
  assert.equal(diagnostics.captureSuspended, true);
  await manager.stopCaptureProbe(started.sessionId);
  await manager.shutdown();
});

test('video rejects expired ids, invalid fps, worker exit, and stop timeout without reporting success', async (t) => {
  await t.test('expired source', async () => {
    const { manager, children } = createManager();
    await assert.rejects(manager.startVideo('monitor:1:0', 30, 'video-session'), /videoSourceExpired/);
    assert.equal(children.length, 0);
    await manager.shutdown();
  });
  await t.test('invalid fps', async () => {
    const { manager, children } = createManager();
    const sources = await manager.listVideoSources();
    await assert.rejects(manager.startVideo(sources.sources[0].sourceId, 144, 'video-session'), /invalidVideoStart/);
    await assert.rejects(manager.startVideo(sources.sources[0].sourceId, 30, 'video-session', { hideCursor: 'false', hideBorder: false }), /invalidVideoStart/);
    assert.equal(children[0].commands.includes('startVideo'), false);
    await manager.shutdown();
  });
  await t.test('worker exit', async () => {
    const { manager, children } = createManager({ exitAfterVideoStart: true }, { onSharedTextureFrame: () => {} });
    const sources = await manager.listVideoSources();
    await manager.startVideo(sources.sources[0].sourceId, 30, 'video-session');
    await waitUntil(() => children[0].closed);
    await assert.rejects(manager.getDiagnostics());
    await manager.shutdown();
  });
  await t.test('stop timeout', async () => {
    const { manager, children } = createManager({ videoStopTimeout: true }, { onSharedTextureFrame: () => {} });
    const sources = await manager.listVideoSources();
    await manager.startVideo(sources.sources[0].sourceId, 30, 'video-session');
    await assert.rejects(manager.stopVideo('video-session'), /mediaHelperTimeout:stopVideo/);
    await waitUntil(() => children[0].closed);
    await manager.shutdown();
  });
});

test('video configuration keeps the capture identity and rejects stale sessions or failed updates', async () => {
  const { manager, children } = createManager();
  try {
    const sources = await manager.listVideoSources();
    await manager.startVideo(sources.sources[0].sourceId, 30, 'quality-session');
    const active = manager.videoCapture;
    await assert.rejects(manager.configureVideo('other-session', 60), /invalidVideoConfiguration/);
    await assert.rejects(manager.configureVideo('quality-session', 121), /invalidVideoConfiguration/);
    await manager.configureVideo('quality-session', 120);
    assert.equal(manager.videoCapture, active);
    assert.equal(active.maxFps, 120);
    assert.equal(children[0].requests.filter(({ command }) => command === 'startVideo').length, 1);
    children[0].mode.videoConfigurationFailure = true;
    await assert.rejects(manager.configureVideo('quality-session', 30), /captureSessionMismatch/);
    assert.equal(active.maxFps, 120);
    await manager.stopVideo('quality-session');
    await assert.rejects(manager.configureVideo('quality-session', 30), /invalidVideoConfiguration/);
  } finally { await manager.shutdown(); }
});

test('pending source refresh allows confirmation and replaces the snapshot only after completion', async () => {
  const { manager, children } = createManager({}, { requestTimeoutMs: 1000 });
  try {
    const sources = await manager.listVideoSources();
    const child = children[0];
    child.mode.holdVideoSources = true;
    const refresh = manager.listVideoSources();
    await waitUntil(() => child.requests.filter(({ command }) => command === 'listVideoSources').length === 2);

    await manager.startVideo(sources.sources[0].sourceId, 30, 'video-session');
    assert.equal(child.commands.includes('startVideo'), true);
    await manager.stopVideo('video-session');

    const request = child.requests.filter(({ command }) => command === 'listVideoSources')[1];
    child.writeResponse({ event: 'videoSources', protocolVersion: 1, requestId: request.requestId,
      revision: 2, sources: [] });
    assert.deepEqual((await refresh).sources, []);
    await assert.rejects(manager.startVideo(sources.sources[0].sourceId, 30, 'late-session'), /videoSourceExpired/);
    assert.equal(child.requests.filter(({ command }) => command === 'startVideo').length, 1);
  } finally {
    await manager.shutdown();
  }
});

test('video forwards the 120 fps preset and rejects values above the supported limit', async () => {
  const { manager, children } = createManager();
  try {
    const sources = await manager.listVideoSources();
    await assert.rejects(manager.startVideo(sources.sources[0].sourceId, 121, 'invalid-session'), /invalidVideoStart/);
    await manager.startVideo(sources.sources[0].sourceId, 120, 'high-fps-session');
    assert.equal(children[0].requests.find(({ command }) => command === 'startVideo').maxFps, 120);
    await manager.stopVideo('high-fps-session');
  } finally {
    await manager.shutdown();
  }
});

test('failed source refresh invalidates the previous snapshot', async () => {
  const { manager, children } = createManager();
  const sources = await manager.listVideoSources();
  children[0].mode.listVideoSourcesFailure = true;
  await assert.rejects(manager.listVideoSources(), /mediaHelper:sourceDiscoveryFailed/);
  await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children[0].commands.includes('startCaptureProbe'), false);
  await manager.shutdown();
});

test('source ids expire when the lazy helper is reclaimed and do not start a replacement', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 15 });
  const sources = await manager.listVideoSources();
  await waitUntil(() => children[0]?.closed);

  await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children.length, 1);
  assert.equal(children[0].commands.includes('startCaptureProbe'), false);
  await manager.shutdown();
});

test('diagnostics accept an older protocol v1 helper without optional capture counters', async () => {
  const { manager } = createManager({ omitFramePoolRecreates: true, omitMicrophoneCaptureDroppedChunks: true });
  assert.equal((await manager.getDiagnostics()).framePoolRecreates, null);
  assert.equal((await manager.getDiagnostics()).microphoneCaptureDroppedChunks, 0);
  await manager.shutdown();
});

test('diagnostics reconcile a capture worker that stopped without an explicit stop request', async () => {
  const { manager, children } = createManager({ captureEndsBeforeDiagnostics: true }, { idleTimeoutMs: 20 });
  const sources = await manager.listVideoSources();
  await manager.startCaptureProbe(sources.sources[0].sourceId);
  const diagnostics = await manager.getDiagnostics();
  assert.equal(diagnostics.state, 'idle');
  assert.equal(manager.captureProbe, undefined);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('probe start timeout or worker exit rejects and never starts a replacement while the child is unclosed', async (t) => {
  await t.test('start timeout', async () => {
    const { manager, children } = createManager({ captureProbeStartTimeout: true });
    const sources = await manager.listVideoSources();
    await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId));
    await waitUntil(() => children[0].closed);
    await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId));
    assert.equal(children.length, 1);
    await manager.shutdown();
  });
  await t.test('worker exit after start acknowledgement', async () => {
    const { manager, children } = createManager({ exitAfterCaptureProbeStart: true });
    const sources = await manager.listVideoSources();
    await manager.startCaptureProbe(sources.sources[0].sourceId);
    await waitUntil(() => children[0].closed);
    await assert.rejects(manager.getDiagnostics());
    await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId));
    assert.equal(children.length, 1);
    await manager.shutdown();
  });
});

test('probe stop timeout terminates the failed helper and shutdown while probing stays bounded', async (t) => {
  await t.test('stop timeout', async () => {
    const { manager, children } = createManager({ captureProbeStopTimeout: true });
    const sources = await manager.listVideoSources();
    const started = await manager.startCaptureProbe(sources.sources[0].sourceId);
    await assert.rejects(manager.stopCaptureProbe(started.sessionId), /mediaHelperTimeout:stopCaptureProbe/);
    await waitUntil(() => children[0].closed);
    assert.equal(children.length, 1);
    await manager.shutdown();
  });
  await t.test('application shutdown', async () => {
    const { manager, children } = createManager();
    const sources = await manager.listVideoSources();
    await manager.startCaptureProbe(sources.sources[0].sourceId);
    await manager.shutdown();
    assert.equal(children[0].closed, true);
    assert.equal(children[0].commands.at(-1), 'shutdown');
  });
});

test('application shutdown during idle close rejects a waiting request without respawning', async () => {
  const { manager, children } = createManager({ shutdownHang: true }, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0].commands.includes('shutdown'));

  const waitingRequest = manager.getCapabilities();
  const shutdown = manager.shutdown();
  await assert.rejects(waitingRequest, /mediaHelperShuttingDown/);
  await shutdown;

  assert.equal(children.length, 1);
  assert.equal(children[0].closed, true);
  assert.equal(children[0].commands.filter((command) => command === 'hello').length, 1);
});

test('application shutdown sends shutdown and waits for normal helper exit', async () => {
  const { manager, children } = createManager();
  await manager.getCapabilities();
  await manager.shutdown();
  assert.equal(children[0].commands.at(-1), 'shutdown');
  assert.equal(children[0].closed, true);
  assert.equal(children[0].killCount, 0);
});

test('shutdown timeout terminates and reaps an unresponsive helper within a bound', async () => {
  const { manager, children } = createManager({ shutdownHang: true });
  await manager.getCapabilities();
  const startedAt = Date.now();
  await manager.shutdown();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(children[0].killCount, 1);
  assert.equal(children[0].closed, true);
});

test('idle kill without close blocks a replacement helper and remains diagnosable', async () => {
  const { manager, children } = createManager({ shutdownHang: true, killNoClose: true }, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0].killCount === 1);
  await waitUntil(() => manager.lastError);

  await assert.rejects(manager.getCapabilities(), /mediaHelperTerminationUnconfirmed/);
  assert.equal(children.length, 1);
  assert.equal(children[0].closed, false);
  assert.equal(manager.children.size, 1);
  await assert.rejects(manager.shutdown(), /mediaHelperTerminationUnconfirmed/);
});

test('kill without close is reported, pending requests settle, and no second helper starts', async () => {
  const { manager, children } = createManager({
    shutdownHang: true,
    killNoClose: true,
    capabilitiesHangAfterFirst: true,
  });
  await manager.getCapabilities();
  const pendingRequest = manager.getCapabilities();
  const pendingRejection = assert.rejects(pendingRequest);
  const startedAt = Date.now();

  await assert.rejects(manager.shutdown(), /mediaHelperTerminationUnconfirmed/);
  await pendingRejection;
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(children[0].killCount, 1);
  assert.equal(children[0].closed, false);
  assert.equal(manager.children.size, 1);
  assert.equal([...manager.children][0].pending.size, 0);
  await assert.rejects(manager.getCapabilities(), /mediaHelperShuttingDown/);
  assert.equal(children.length, 1);
});

test('remote input is bound to one active monitor session and authenticated identity', async () => {
  const { manager, children } = createManager();
  const sources = await manager.listVideoSources();
  await manager.startVideo(sources.sources[0].sourceId, 30, 'video-control');
  await manager.setRemoteControl('video-control', 'control-session', 'member-a');
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 1,
    { kind: 'move', x: 0, y: 65535 }), { changed: true, dropped: false });
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 3,
    { kind: 'move', x: 3, y: 4 }), { changed: true, dropped: false });
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 2,
    { kind: 'buttonUp', button: 'left', x: 333, y: 444 }), { changed: true, dropped: false });
  const buttonRelease = children[0].requests.find((request) => request.command === 'remoteInput' && request.sequence === 2);
  assert.deepEqual(buttonRelease.input, { kind: 'buttonUp', button: 'left', x: 333, y: 444 });
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-b', 2,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 1,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 4,
    { kind: 'execute', command: 'bad' }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 4,
    { kind: 'move', x: 1, y: 2, hwnd: 1234 }), /remoteControlInvalidSession/);
  assert.deepEqual(await manager.clearRemoteControl('video-control', 'control-session'), { changed: true });
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 5,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await manager.stopVideo('video-control');
  await manager.shutdown();
});

test('mouse movement may be dropped under load, but discrete overload clears the helper grant', async () => {
  const { manager } = createManager();
  const sources = await manager.listVideoSources();
  await manager.startVideo(sources.sources[0].sourceId, 30, 'video-overload');
  await manager.setRemoteControl('video-overload', 'control-overload', 'member-a');
  for (let sequence = 1; sequence <= 120; sequence += 1) {
    await manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', sequence,
      { kind: 'move', x: sequence, y: 2 });
  }
  await assert.rejects(manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', 121,
    { kind: 'keyUp', key: 'letterA' }), /remoteControlInputRateExceeded/);
  await assert.rejects(manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', 122,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await manager.stopVideo('video-overload');
  await manager.shutdown();
});

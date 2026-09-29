const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { MediaHelperManager } = require('./media-helper.cjs');

const capabilities = {
  videoCapture: { available: false, reason: 'videoOutputNotImplemented' },
  captureProbe: { available: true, reason: 'windowsGraphicsCapture' },
  videoSourceDiscovery: { available: true, reason: 'windowsGraphicsCapture' },
  microphoneCapture: { available: false, reason: 'notImplemented' },
  systemAudioCapture: { available: false, reason: 'notImplemented' },
  processAudioCapture: { available: false, reason: 'notImplemented' },
  audioSourceDiscovery: { available: true, reason: 'windowsCoreAudioEndpointEnumeration' },
  microphoneProbe: { available: true, reason: 'windowsWasapiSharedModeEventDriven' },
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
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.mode.writeFailure) {
          callback(new Error('fake write failure'));
          return;
        }
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          this.handleCommand(JSON.parse(line));
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
        windowsOnly: true, ...capabilities,
      };
      if (this.mode.wrongCapabilitiesRequestId) response.requestId = 'unexpected';
      this.writeResponse(response);
      return;
    }
    if (command.command === 'listVideoSources') {
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
      this.writeResponse({
        event: 'diagnostics', protocolVersion: 1, requestId: command.requestId,
        state: this.captureState, sessionId: this.captureSessionId,
        available: true, sourceKind: this.captureState === 'running' ? 'monitor' : null,
        frameWidth: this.captureState === 'running' ? 1920 : null,
        frameHeight: this.captureState === 'running' ? 1080 : null,
        framesReceived: this.captureState === 'running' ? 20 : null,
        framesProcessed: this.captureState === 'running' ? 20 : null,
        droppedNotifications: this.captureState === 'running' ? 0 : null,
        rawCaptureFps: this.captureState === 'running' ? 60 : null,
        probeProcessedFps: this.captureState === 'running' ? 60 : null,
        rawFrameIntervalP50Ms: null, rawFrameIntervalP95Ms: null, rawFrameIntervalP99Ms: null,
        rawTimestampAnomalies: 0, lastFrameAgeMs: 0, sizeChanges: 0,
        lastCaptureError: null, stopDurationMs: null,
      });
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
  const manager = new MediaHelperManager({
    executablePath: 'fake-media-helper.exe',
    platform: 'win32',
    spawnProcess: () => {
      const child = new FakeHelper(mode);
      children.push(child);
      return child;
    },
    createRequestId: (() => { let next = 0; return () => `request-${++next}`; })(),
    handshakeTimeoutMs: 40,
    requestTimeoutMs: 80,
    shutdownTimeoutMs: 40,
    killTimeoutMs: 40,
    idleTimeoutMs: 1000,
    retryDelayMs: 20,
    ...options,
  });
  return { manager, children };
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test timed out waiting for fake helper state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('helper starts lazily and concurrent capability requests share one process and handshake', async () => {
  const { manager, children } = createManager();
  assert.equal(children.length, 0);

  const results = await Promise.all(Array.from({ length: 6 }, () => manager.getCapabilities()));
  assert.equal(children.length, 1);
  assert.equal(children[0].commands.filter((command) => command === 'hello').length, 1);
  assert.equal(children[0].commands.filter((command) => command === 'capabilities').length, 1);
  assert.deepEqual(results[0].videoCapture, capabilities.videoCapture);
  await manager.shutdown();
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

test('failed source refresh invalidates the previous snapshot', async () => {
  const { manager, children } = createManager();
  const sources = await manager.listVideoSources();
  children[0].mode.listVideoSourcesFailure = true;
  await assert.rejects(manager.listVideoSources(), /mediaHelper:sourceDiscoveryFailed/);
  await assert.rejects(manager.startCaptureProbe(sources.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children[0].commands.includes('startCaptureProbe'), false);
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

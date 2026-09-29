const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const CAPABILITY_NAMES = [
  'videoCapture',
  'captureProbe',
  'videoSourceDiscovery',
  'microphoneCapture',
  'systemAudioCapture',
  'processAudioCapture',
  'audioSourceDiscovery',
  'microphoneProbe',
];

class MediaHelperManager {
  constructor({
    executablePath,
    platform = process.platform,
    spawnProcess = spawn,
    createRequestId = randomUUID,
    handshakeTimeoutMs = 5000,
    requestTimeoutMs = 5000,
    shutdownTimeoutMs = 1000,
    killTimeoutMs = 500,
    idleTimeoutMs = 30_000,
    retryDelayMs = 2000,
  }) {
    this.executablePath = executablePath;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.createRequestId = createRequestId;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.state = undefined;
    this.startPromise = undefined;
    this.capabilitiesPromise = undefined;
    this.idleTimer = undefined;
    this.children = new Set();
    this.retryAfter = 0;
    this.closing = false;
    this.lastError = undefined;
    this.videoSourceSnapshot = undefined;
    this.captureProbe = undefined;
    this.captureProbeStart = undefined;
    this.captureProbeStop = undefined;
    this.lastStoppedCaptureProbe = undefined;
  }

  getCapabilities() {
    if (this.platform !== 'win32') return Promise.reject(new Error('platformUnsupported'));
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (this.capabilitiesPromise) return this.capabilitiesPromise;

    this.capabilitiesPromise = this.queryCapabilities().finally(() => {
      this.capabilitiesPromise = undefined;
    });
    return this.capabilitiesPromise;
  }

  async queryCapabilities() {
    const state = await this.ensureStarted();
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(state, 'capabilities', 'capabilities', this.requestTimeoutMs);
      try {
        return validateCapabilities(response);
      } catch (error) {
        this.failState(state, error);
        throw error;
      }
    } finally {
      if (this.canCloseWhenIdle(state)) {
        this.scheduleIdleShutdown(state);
      }
    }
  }

  async listVideoSources() {
    const state = await this.ensureStarted();
    this.clearIdleTimer();
    this.videoSourceSnapshot = undefined;
    try {
      const response = await this.sendRequest(state, 'listVideoSources', 'videoSources', this.requestTimeoutMs);
      const snapshot = validateVideoSources(response);
      this.videoSourceSnapshot = { state, ids: new Set(snapshot.sources.map(({ sourceId }) => sourceId)) };
      return snapshot;
    } finally {
      if (this.canCloseWhenIdle(state)) this.scheduleIdleShutdown(state);
    }
  }

  startCaptureProbe(sourceId) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (typeof sourceId !== 'string' || sourceId.length > 128) return Promise.reject(new Error('invalidVideoSource'));
    if (this.captureProbe) {
      return this.captureProbe.sourceId === sourceId
        ? Promise.resolve({ sessionId: this.captureProbe.sessionId, changed: false })
        : Promise.reject(new Error('captureProbeAlreadyRunning'));
    }
    if (this.captureProbeStart) {
      return this.captureProbeStart.sourceId === sourceId
        ? this.captureProbeStart.promise
        : Promise.reject(new Error('captureProbeAlreadyStarting'));
    }
    const snapshot = this.videoSourceSnapshot;
    if (!snapshot || !snapshot.ids.has(sourceId) || !snapshot.state.alive) {
      return Promise.reject(new Error('videoSourceExpired'));
    }
    const sessionId = this.createRequestId();
    this.clearIdleTimer();
    const promise = this.runStartCaptureProbe(snapshot.state, sessionId, sourceId)
      .finally(() => {
        if (this.captureProbeStart?.promise === promise) this.captureProbeStart = undefined;
        if (this.canCloseWhenIdle(snapshot.state)) this.scheduleIdleShutdown(snapshot.state);
      });
    this.captureProbeStart = { state: snapshot.state, sourceId, promise };
    return promise;
  }

  async runStartCaptureProbe(state, sessionId, sourceId) {
    try {
      const response = await this.sendRequest(state, 'startCaptureProbe', 'acknowledged', this.requestTimeoutMs,
        { sessionId, sourceId });
      if (response.command !== 'startCaptureProbe' || response.changed !== true) {
        throw new Error('mediaHelperInvalidCaptureStart');
      }
      this.captureProbe = { state, sessionId, sourceId };
      return { sessionId, changed: true };
    } catch (error) {
      this.videoSourceSnapshot = undefined;
      throw error;
    }
  }

  stopCaptureProbe(sessionId) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (typeof sessionId !== 'string' || sessionId.length > 128) {
      return Promise.reject(new Error('invalidCaptureSession'));
    }
    if (!this.captureProbe) {
      return this.lastStoppedCaptureProbe === sessionId
        ? Promise.resolve({ changed: false })
        : Promise.reject(new Error('captureProbeSessionMismatch'));
    }
    if (this.captureProbe.sessionId !== sessionId) {
      return Promise.reject(new Error('captureProbeSessionMismatch'));
    }
    if (this.captureProbeStop) return this.captureProbeStop;
    const captureProbe = this.captureProbe;
    const promise = this.runStopCaptureProbe(captureProbe).finally(() => {
      if (this.captureProbeStop === promise) this.captureProbeStop = undefined;
    });
    this.captureProbeStop = promise;
    return promise;
  }

  async runStopCaptureProbe(captureProbe) {
    const { state, sessionId } = captureProbe;
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(state, 'stopCaptureProbe', 'acknowledged', this.requestTimeoutMs,
        { sessionId });
      if (response.command !== 'stopCaptureProbe') throw new Error('mediaHelperInvalidCaptureStop');
      this.captureProbe = undefined;
      this.lastStoppedCaptureProbe = sessionId;
      return { changed: response.changed };
    } finally {
      if (this.canCloseWhenIdle(state)) this.scheduleIdleShutdown(state);
    }
  }

  async getDiagnostics() {
    const state = await this.ensureStarted();
    this.clearIdleTimer();
    try {
      const diagnostics = validateDiagnostics(
        await this.sendRequest(state, 'diagnostics', 'diagnostics', this.requestTimeoutMs),
      );
      if (this.captureProbe?.state === state
          && (diagnostics.state === 'idle' || diagnostics.sessionId !== this.captureProbe.sessionId)) {
        this.lastStoppedCaptureProbe = this.captureProbe.sessionId;
        this.captureProbe = undefined;
      }
      return diagnostics;
    } finally {
      if (this.canCloseWhenIdle(state)) this.scheduleIdleShutdown(state);
    }
  }

  ensureStarted() {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (this.state?.closingPromise) {
      return this.state.closingPromise.then(() => {
        if (this.closing) throw new Error('mediaHelperShuttingDown');
        return this.ensureStarted();
      });
    }
    if (this.state?.alive && this.state.ready) return Promise.resolve(this.state);
    if (this.startPromise) return this.startPromise;
    const unclosedChild = [...this.children].find((childState) => !childState.closed);
    if (unclosedChild) {
      return Promise.reject(unclosedChild.closeError || this.lastError || new Error('mediaHelperTerminationPending'));
    }
    if (Date.now() < this.retryAfter) return Promise.reject(new Error('mediaHelperRetryDelayed'));

    let child;
    try {
      const executable = typeof this.executablePath === 'function' ? this.executablePath() : this.executablePath;
      child = this.spawnProcess(executable, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      this.retryAfter = Date.now() + this.retryDelayMs;
      return Promise.reject(new Error('mediaHelperStartFailed'));
    }

    let stateResolveClose;
    const state = {
      child,
      alive: true,
      closed: false,
      killRequested: false,
      ready: false,
      intentionalClose: false,
      videoSourceSnapshot: undefined,
      buffer: Buffer.alloc(0),
      pending: new Map(),
      closedPromise: new Promise((resolve) => { stateResolveClose = resolve; }),
      resolveClose: undefined,
      closingPromise: undefined,
    };
    state.resolveClose = () => stateResolveClose();
    this.children.add(state);
    this.state = state;
    this.clearIdleTimer();

    child.stdout.on('data', (chunk) => this.readOutput(state, chunk));
    child.stdin.once('error', () => this.failState(state, new Error('mediaHelperWriteFailed')));
    child.once('error', () => this.failState(state, new Error('mediaHelperProcessError')));
    child.once('exit', (code) => {
      if (!state.intentionalClose) {
        this.failState(state, new Error(`mediaHelperExited:${Number.isInteger(code) ? code : 'unknown'}`));
      }
    });
    child.once('close', () => {
      state.alive = false;
      state.closed = true;
      state.resolveClose();
      this.children.delete(state);
      if (this.state === state) this.state = undefined;
      this.invalidateState(state);
      this.rejectPending(state, new Error('mediaHelperClosed'));
      if (!state.intentionalClose) this.failState(state, new Error('mediaHelperClosed'));
    });

    this.startPromise = this.sendRequest(state, 'hello', 'hello', this.handshakeTimeoutMs)
      .then(() => {
        state.ready = true;
        return state;
      })
      .catch((error) => {
        this.failState(state, error);
        throw error;
      })
      .finally(() => {
        if (this.state === state) this.startPromise = undefined;
      });
    return this.startPromise;
  }

  sendRequest(state, command, expectedEvent, timeoutMs, parameters = {}) {
    if (!state.alive) return Promise.reject(new Error('mediaHelperUnavailable'));
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failState(state, new Error(`mediaHelperTimeout:${command}`));
      }, timeoutMs);
      state.pending.set(requestId, { expectedEvent, command, resolve, reject, timer });
      const line = Buffer.from(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, command, ...parameters })}\n`, 'utf8');
      try {
        state.child.stdin.write(line, (error) => {
          if (error) this.failState(state, new Error(`mediaHelperWriteFailed:${command}`));
        });
      } catch {
        this.failState(state, new Error(`mediaHelperWriteFailed:${command}`));
      }
    });
  }

  readOutput(state, chunk) {
    if (this.state !== state || !state.alive) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (state.buffer.length + segment.length > MAX_LINE_BYTES) {
        this.failState(state, new Error('mediaHelperLineTooLong'));
        return;
      }
      state.buffer = state.buffer.length ? Buffer.concat([state.buffer, segment]) : Buffer.from(segment);
      if (newline === -1) return;
      const line = state.buffer;
      state.buffer = Buffer.alloc(0);
      if (line.length && line[line.length - 1] === 0x0d) {
        this.handleLine(state, line.subarray(0, -1));
      } else {
        this.handleLine(state, line);
      }
      if (!state.alive) return;
      offset = newline + 1;
    }
  }

  handleLine(state, line) {
    let message;
    try {
      message = JSON.parse(UTF8_DECODER.decode(line));
    } catch {
      this.failState(state, new Error('mediaHelperInvalidJson'));
      return;
    }
    if (!message || message.protocolVersion !== PROTOCOL_VERSION
        || typeof message.requestId !== 'string' || typeof message.event !== 'string') {
      this.failState(state, new Error('mediaHelperInvalidResponse'));
      return;
    }
    const pending = state.pending.get(message.requestId);
    if (!pending) {
      this.failState(state, new Error('mediaHelperUnexpectedRequestId'));
      return;
    }
    if (message.event === 'error') {
      this.removePending(state, message.requestId, pending);
      pending.reject(new Error(isStableCode(message.code) ? `mediaHelper:${message.code}` : 'mediaHelperRequestFailed'));
      if (pending.command === 'hello') this.failState(state, new Error('mediaHelperHandshakeRejected'));
      return;
    }
    if (message.event !== pending.expectedEvent) {
      this.failState(state, new Error('mediaHelperUnexpectedEvent'));
      return;
    }
    if (pending.command === 'shutdown' && message.command !== 'shutdown') {
      this.failState(state, new Error('mediaHelperInvalidShutdownAck'));
      return;
    }
    this.removePending(state, message.requestId, pending);
    pending.resolve(message);
  }

  removePending(state, requestId, pending) {
    clearTimeout(pending.timer);
    state.pending.delete(requestId);
  }

  failState(state, error, setBackoff = true) {
    if (!state.alive) return;
    state.alive = false;
    if (setBackoff) this.retryAfter = Date.now() + this.retryDelayMs;
    if (this.state === state) this.state = undefined;
    this.invalidateState(state);
    if (this.startPromise && !state.ready) this.startPromise = undefined;
    this.clearIdleTimer();
    this.rejectPending(state, error);
    if (!state.intentionalClose) this.terminateState(state);
  }

  rejectPending(state, error) {
    for (const [requestId, pending] of state.pending) {
      this.removePending(state, requestId, pending);
      pending.reject(error);
    }
  }

  terminateState(state) {
    if (state.killRequested || state.closed) return;
    state.killRequested = true;
    try { state.child.kill(); } catch { /* The exit/close handlers finish process cleanup. */ }
  }

  scheduleIdleShutdown(state) {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.canCloseWhenIdle(state)) {
        state.closingPromise = this.closeState(state);
        state.closingPromise.catch((error) => { this.lastError = error; });
      }
    }, this.idleTimeoutMs);
  }

  closingDown(state) {
    return Boolean(state.closingPromise);
  }

  canCloseWhenIdle(state) {
    return this.state === state && state.alive && state.pending.size === 0
      && !this.closingDown(state) && this.captureProbe?.state !== state
      && this.captureProbeStart?.promise === undefined;
  }

  invalidateState(state) {
    if (this.videoSourceSnapshot?.state === state) this.videoSourceSnapshot = undefined;
    if (this.captureProbe?.state === state) this.captureProbe = undefined;
    if (this.captureProbeStart?.state === state) this.captureProbeStart = undefined;
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  async closeState(state) {
    if (state.closed) return;
    state.intentionalClose = true;
    if (state.alive) {
      try {
        if (state.ready) await this.sendRequest(state, 'shutdown', 'acknowledged', this.shutdownTimeoutMs);
      } catch {
        // Shutdown failure is handled by bounded process termination below.
      }
      try { state.child.stdin.end(); } catch { /* Continue to bounded termination. */ }
    }
    if (await waitForClose(state.closedPromise, this.shutdownTimeoutMs)) return;
    this.terminateState(state);
    if (!await waitForClose(state.closedPromise, this.killTimeoutMs)) {
      state.alive = false;
      if (this.state === state) this.state = undefined;
      const error = new Error('mediaHelperTerminationUnconfirmed');
      state.closeError = error;
      this.lastError = error;
      this.retryAfter = Date.now() + this.retryDelayMs;
      for (const [requestId, pending] of state.pending) {
        this.removePending(state, requestId, pending);
        pending.reject(error);
      }
      throw error;
    }
  }

  async shutdown() {
    this.closing = true;
    this.clearIdleTimer();
    const states = [...this.children];
    await Promise.all(states.map((state) => {
      state.closingPromise ??= this.closeState(state);
      return state.closingPromise;
    }));
  }
}

function validateCapabilities(message) {
  const result = {};
  for (const name of CAPABILITY_NAMES) {
    const capability = message[name];
    if (!capability || typeof capability.available !== 'boolean'
        || typeof capability.reason !== 'string' || capability.reason.length > 128
        || /[\u0000-\u001f\u007f]/.test(capability.reason)) {
      throw new Error('mediaHelperInvalidCapabilities');
    }
    result[name] = { available: capability.available, reason: capability.reason };
  }
  return result;
}

function validateVideoSources(message) {
  if (!Number.isSafeInteger(message.revision) || message.revision < 1
      || !Array.isArray(message.sources) || message.sources.length > 128) {
    throw new Error('mediaHelperInvalidVideoSources');
  }
  const sources = message.sources.map((source) => {
    if (!source || typeof source.sourceId !== 'string' || source.sourceId.length > 128
        || !/^(?:monitor|window):[1-9]\d*:\d+$/.test(source.sourceId)
        || !['monitor', 'window'].includes(source.kind)
        || typeof source.title !== 'string' || source.title.length > 256
        || /[\u0000-\u001f\u007f]/.test(source.title)
        || !Number.isSafeInteger(source.width) || source.width < 1 || source.width > 32768
        || !Number.isSafeInteger(source.height) || source.height < 1 || source.height > 32768
        || typeof source.primary !== 'boolean') {
      throw new Error('mediaHelperInvalidVideoSources');
    }
    return {
      sourceId: source.sourceId,
      kind: source.kind,
      title: source.title,
      width: source.width,
      height: source.height,
      primary: source.primary,
    };
  });
  return { revision: message.revision, sources };
}

function validateDiagnostics(message) {
  if (!['idle', 'starting', 'running', 'stopping'].includes(message.state)
      || (message.sessionId !== null && (typeof message.sessionId !== 'string' || message.sessionId.length > 128))
      || (message.sourceKind !== null && !['monitor', 'window'].includes(message.sourceKind))) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  const numericFields = [
    'frameWidth', 'frameHeight', 'framesReceived', 'framesProcessed', 'droppedNotifications',
    'rawCaptureFps', 'probeProcessedFps', 'rawFrameIntervalP50Ms', 'rawFrameIntervalP95Ms',
    'rawFrameIntervalP99Ms', 'rawTimestampAnomalies', 'lastFrameAgeMs', 'sizeChanges', 'stopDurationMs',
  ];
  for (const field of numericFields) {
    const value = message[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('mediaHelperInvalidDiagnostics');
    }
  }
  if (typeof message.available !== 'boolean'
      || (message.lastCaptureError !== null
        && (typeof message.lastCaptureError !== 'string' || message.lastCaptureError.length > 64
          || !/^[a-z][A-Za-z0-9]*$/.test(message.lastCaptureError)))) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  return Object.fromEntries(['state', 'sessionId', 'available', 'sourceKind', 'frameWidth', 'frameHeight',
    'framesReceived', 'framesProcessed', 'droppedNotifications', 'rawCaptureFps', 'probeProcessedFps',
    'rawFrameIntervalP50Ms', 'rawFrameIntervalP95Ms', 'rawFrameIntervalP99Ms', 'rawTimestampAnomalies',
    'lastFrameAgeMs', 'sizeChanges', 'lastCaptureError', 'stopDurationMs']
    .map((field) => [field, message[field]]));
}

function isStableCode(value) {
  return typeof value === 'string' && /^[a-z][A-Za-z0-9]{0,63}$/.test(value);
}

function waitForClose(closedPromise, timeoutMs) {
  let timer;
  return Promise.race([
    closedPromise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { MediaHelperManager, MAX_LINE_BYTES, PROTOCOL_VERSION };

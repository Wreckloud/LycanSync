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
  'screenShareAudioCapture',
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
    onSharedTextureFrame = () => {},
    onVideoCaptureEnded = () => {},
    onVideoCaptureSuspended = () => {},
    onHelperFailure = () => {},
    onHelperClosed = () => {},
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
    this.onSharedTextureFrame = onSharedTextureFrame;
    this.onVideoCaptureEnded = onVideoCaptureEnded;
    this.onVideoCaptureSuspended = onVideoCaptureSuspended;
    this.onHelperFailure = onHelperFailure;
    this.onHelperClosed = onHelperClosed;
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
    this.videoCapture = undefined;
    this.videoCaptureStart = undefined;
    this.videoCaptureStop = undefined;
    this.lastStoppedVideoCapture = undefined;
    this.screenShareAudio = undefined;
    this.screenShareAudioStart = undefined;
    this.screenShareAudioStop = undefined;
    this.lastStoppedScreenShareAudio = undefined;
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
    if (this.videoCapture || this.videoCaptureStart) return Promise.reject(new Error('videoCaptureAlreadyRunning'));
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

  startVideo(sourceId, maxFps, sessionId = this.createRequestId()) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (typeof sourceId !== 'string' || sourceId.length > 128
        || !Number.isInteger(maxFps) || maxFps < 1 || maxFps > 60
        || typeof sessionId !== 'string' || sessionId.length > 128) {
      return Promise.reject(new Error('invalidVideoStart'));
    }
    if (this.videoCapture || this.captureProbe) return Promise.reject(new Error('videoCaptureAlreadyRunning'));
    if (this.videoCaptureStart || this.captureProbeStart) {
      return Promise.reject(new Error('videoCaptureAlreadyStarting'));
    }
    const snapshot = this.videoSourceSnapshot;
    if (!snapshot || !snapshot.ids.has(sourceId) || !snapshot.state.alive) {
      return Promise.reject(new Error('videoSourceExpired'));
    }
    this.clearIdleTimer();
    const active = { state: snapshot.state, sessionId, sourceId, maxFps, starting: true };
    this.videoCapture = active;
    snapshot.state.videoSessionId = sessionId;
    const promise = this.runStartVideo(snapshot.state, sessionId, sourceId, maxFps)
      .finally(() => {
        if (this.videoCaptureStart?.promise === promise) this.videoCaptureStart = undefined;
        if (this.canCloseWhenIdle(snapshot.state)) this.scheduleIdleShutdown(snapshot.state);
      });
    this.videoCaptureStart = { state: snapshot.state, sourceId, promise };
    return promise;
  }

  async runStartVideo(state, sessionId, sourceId, maxFps) {
    try {
      const response = await this.sendRequest(state, 'startVideo', 'acknowledged', this.requestTimeoutMs,
        { sessionId, sourceId, targetWidth: 1920, targetHeight: 1080, maxFps });
      if (response.command !== 'startVideo' || response.changed !== true) {
        throw new Error('mediaHelperInvalidVideoStart');
      }
      if (this.videoCapture?.state === state && this.videoCapture.sessionId === sessionId) {
        this.videoCapture.starting = false;
      }
      return { sessionId, changed: true };
    } catch (error) {
      if (this.videoCapture?.state === state && this.videoCapture.sessionId === sessionId) {
        this.videoCapture = undefined;
      }
      delete state.videoSessionId;
      this.videoSourceSnapshot = undefined;
      throw error;
    }
  }

  releaseSharedTextureSlot(sessionId, slotIndex) {
    const active = this.videoCapture;
    if (!active || active.sessionId !== sessionId || !Number.isInteger(slotIndex)
        || slotIndex < 0 || slotIndex >= 3) {
      return Promise.reject(new Error('sharedTextureSlotMismatch'));
    }
    return this.sendRequest(active.state, 'releaseSharedTextureSlot', 'acknowledged', this.requestTimeoutMs,
      { sessionId, slotIndex }).then((response) => {
      if (response.command !== 'releaseSharedTextureSlot') throw new Error('mediaHelperInvalidSlotRelease');
      return { changed: response.changed };
    });
  }

  stopVideo(sessionId) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (typeof sessionId !== 'string' || sessionId.length > 128) {
      return Promise.reject(new Error('invalidVideoSession'));
    }
    if (!this.videoCapture) {
      return this.lastStoppedVideoCapture === sessionId
        ? Promise.resolve({ changed: false })
        : Promise.reject(new Error('videoSessionMismatch'));
    }
    if (this.videoCapture.sessionId !== sessionId) return Promise.reject(new Error('videoSessionMismatch'));
    if (this.videoCaptureStart) {
      return this.videoCaptureStart.promise.then(() => this.stopVideo(sessionId));
    }
    if (this.videoCaptureStop) return this.videoCaptureStop;
    const active = this.videoCapture;
    const promise = this.runStopVideo(active).finally(() => {
      if (this.videoCaptureStop === promise) this.videoCaptureStop = undefined;
    });
    this.videoCaptureStop = promise;
    return promise;
  }

  startScreenShareAudio(sourceId, pipeId, sessionId) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (!/^(?:monitor|window):[1-9]\d*:\d+$/.test(sourceId || '')
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pipeId || '')
        || typeof sessionId !== 'string' || sessionId.length > 128) {
      return Promise.reject(new Error('invalidScreenShareAudioStart'));
    }
    const activeVideo = this.videoCapture;
    const snapshot = this.videoSourceSnapshot;
    if (!activeVideo || activeVideo.sessionId !== sessionId || activeVideo.sourceId !== sourceId
        || !snapshot || !snapshot.ids.has(sourceId) || snapshot.state !== activeVideo.state
        || !activeVideo.state.alive) {
      return Promise.reject(new Error('videoSourceExpired'));
    }
    if (this.screenShareAudio) {
      return this.screenShareAudio.sessionId === sessionId
        ? Promise.resolve({ ...this.screenShareAudio.result, changed: false })
        : Promise.reject(new Error('screenShareAudioAlreadyRunning'));
    }
    if (this.screenShareAudioStart) return this.screenShareAudioStart;
    this.clearIdleTimer();
    const promise = this.runStartScreenShareAudio(activeVideo.state, sourceId, pipeId, sessionId)
      .finally(() => { if (this.screenShareAudioStart === promise) this.screenShareAudioStart = undefined; });
    this.screenShareAudioStart = promise;
    return promise;
  }

  async runStartScreenShareAudio(state, sourceId, pipeId, sessionId) {
    const response = await this.sendRequest(state, 'startScreenShareAudio', 'screenShareAudioStarted', this.requestTimeoutMs,
      { sourceId, pipeId, sessionId });
    if (response.sessionId !== sessionId || response.changed !== true
        || !Number.isInteger(response.sampleRate) || response.sampleRate < 8000 || response.sampleRate > 192000
        || response.channels !== 2 || response.bitsPerSample !== 32 || response.nominalChunkMs !== 10) {
      this.failState(state, new Error('mediaHelperInvalidScreenShareAudioStart'));
      throw new Error('mediaHelperInvalidScreenShareAudioStart');
    }
    const result = {
      sampleRate: response.sampleRate,
      channels: response.channels,
      bitsPerSample: response.bitsPerSample,
      nominalChunkMs: response.nominalChunkMs,
    };
    this.screenShareAudio = { state, sessionId, sourceId, result };
    return { ...result, changed: true };
  }

  stopScreenShareAudio(sessionId) {
    if (!this.screenShareAudio) {
      return this.lastStoppedScreenShareAudio === sessionId
        ? Promise.resolve({ changed: false })
        : Promise.reject(new Error('screenShareAudioSessionMismatch'));
    }
    if (this.screenShareAudio.sessionId !== sessionId) return Promise.reject(new Error('screenShareAudioSessionMismatch'));
    if (this.screenShareAudioStop) return this.screenShareAudioStop;
    const active = this.screenShareAudio;
    const promise = this.sendRequest(active.state, 'stopScreenShareAudio', 'acknowledged', this.requestTimeoutMs,
      { sessionId }).then((response) => {
      if (response.command !== 'stopScreenShareAudio') throw new Error('mediaHelperInvalidScreenShareAudioStop');
      this.screenShareAudio = undefined;
      this.lastStoppedScreenShareAudio = sessionId;
      return { changed: response.changed };
    }).finally(() => {
      if (this.screenShareAudioStop === promise) this.screenShareAudioStop = undefined;
      if (this.canCloseWhenIdle(active.state)) this.scheduleIdleShutdown(active.state);
    });
    this.screenShareAudioStop = promise;
    return promise;
  }

  async abortVideo(sessionId) {
    const active = this.videoCapture;
    if (!active || active.sessionId !== sessionId) {
      return this.lastStoppedVideoCapture === sessionId ? { changed: false } : Promise.reject(new Error('videoSessionMismatch'));
    }
    const state = active.state;
    this.failState(state, new Error('nativeVideoAbortRequested'));
    if (!await waitForClose(state.closedPromise, this.killTimeoutMs)) {
      throw new Error('mediaHelperTerminationUnconfirmed');
    }
    return { changed: true };
  }

  async runStopVideo(active) {
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(active.state, 'stopVideo', 'acknowledged', this.requestTimeoutMs,
        { sessionId: active.sessionId });
      if (response.command !== 'stopVideo') throw new Error('mediaHelperInvalidVideoStop');
      this.videoCapture = undefined;
      this.lastStoppedVideoCapture = active.sessionId;
      delete active.state.videoSessionId;
      return { changed: response.changed };
    } finally {
      if (this.canCloseWhenIdle(active.state)) this.scheduleIdleShutdown(active.state);
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
      if (this.videoCapture?.state === state
          && (diagnostics.state === 'idle' || diagnostics.sessionId !== this.videoCapture.sessionId)) {
        this.lastStoppedVideoCapture = this.videoCapture.sessionId;
        this.videoCapture = undefined;
      }
      if (this.screenShareAudio?.state === state
          && diagnostics.screenShareAudio?.state !== 'running') {
        this.lastStoppedScreenShareAudio = this.screenShareAudio.sessionId;
        this.screenShareAudio = undefined;
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
      try { this.onHelperClosed(state); } catch { /* Process close must complete regardless of cleanup hooks. */ }
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
    if (!message || message.protocolVersion !== PROTOCOL_VERSION || typeof message.event !== 'string') {
      this.failState(state, new Error('mediaHelperInvalidResponse'));
      return;
    }
    if (message.event === 'sharedTextureFrame') {
      const active = this.videoCapture;
      if (!active || active.state !== state || active.sessionId !== message.sessionId
          || !Number.isInteger(message.slotIndex) || message.slotIndex < 0 || message.slotIndex >= 3
          || typeof message.sourceHandleHex !== 'string' || !/^[0-9a-f]{16}$/i.test(message.sourceHandleHex)
          || message.pixelFormat !== 'bgra' || !validTextureSize(message.codedSize)
          || !validTextureSize(message.contentSize)
          || message.contentSize.width > message.codedSize.width
          || message.contentSize.height > message.codedSize.height) {
        this.failState(state, new Error('mediaHelperInvalidSharedTextureFrame'));
        return;
      }
      try { this.onSharedTextureFrame(state, message); }
      catch { this.failState(state, new Error('mediaHelperSharedTextureDeliveryFailed')); }
      return;
    }
    if (message.event === 'videoCaptureEnded') {
      if (typeof message.sessionId !== 'string' || message.sessionId.length > 128
          || !isStableCode(message.code)) {
        this.failState(state, new Error('mediaHelperInvalidVideoCaptureEnded'));
        return;
      }
      const active = this.videoCapture;
      if (!active || active.state !== state || active.sessionId !== message.sessionId || active.endedNotified) {
        return;
      }
      active.endedNotified = true;
      try { this.onVideoCaptureEnded(state, { sessionId: message.sessionId, code: message.code }); }
      catch { /* The capture owner still receives the event and can stop its session. */ }
      return;
    }
    if (message.event === 'videoCaptureSuspended') {
      if (typeof message.sessionId !== 'string' || message.sessionId.length > 128
          || typeof message.suspended !== 'boolean') {
        this.failState(state, new Error('mediaHelperInvalidVideoCaptureSuspended'));
        return;
      }
      const active = this.videoCapture;
      if (!active || active.state !== state || active.sessionId !== message.sessionId
          || active.endedNotified || active.suspended === message.suspended) return;
      active.suspended = message.suspended;
      try { this.onVideoCaptureSuspended(state, { sessionId: message.sessionId, suspended: message.suspended }); }
      catch { /* The capture owner can still stop its session. */ }
      return;
    }
    if (typeof message.requestId !== 'string') {
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
    if (!state.failureNotified) {
      state.failureNotified = true;
      try { this.onHelperFailure(state, safeFailureCode(error)); } catch { /* Child teardown remains authoritative. */ }
    }
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
      && !this.closingDown(state) && this.captureProbe?.state !== state && this.videoCapture?.state !== state
      && this.screenShareAudio?.state !== state
      && this.captureProbeStart?.promise === undefined && this.videoCaptureStart?.promise === undefined
      && this.screenShareAudioStart === undefined;
  }

  invalidateState(state) {
    if (this.videoSourceSnapshot?.state === state) this.videoSourceSnapshot = undefined;
    if (this.captureProbe?.state === state) this.captureProbe = undefined;
    if (this.captureProbeStart?.state === state) this.captureProbeStart = undefined;
    if (this.videoCapture?.state === state) this.videoCapture = undefined;
    if (this.videoCaptureStart?.state === state) this.videoCaptureStart = undefined;
    if (this.screenShareAudio?.state === state) this.screenShareAudio = undefined;
    if (this.screenShareAudioStart) this.screenShareAudioStart = undefined;
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
    'rawFrameIntervalP99Ms', 'rawTimestampAnomalies', 'lastFrameAgeMs', 'sizeChanges',
    'framePoolRecreates', 'stopDurationMs',
  ];
  for (const field of numericFields) {
    const value = message[field];
    if (field === 'framePoolRecreates' && value === undefined) continue;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('mediaHelperInvalidDiagnostics');
    }
  }
  if (typeof message.available !== 'boolean'
      || (message.captureSuspended !== undefined && message.captureSuspended !== null
        && typeof message.captureSuspended !== 'boolean')
      || (message.lastCaptureError !== null
        && (typeof message.lastCaptureError !== 'string' || message.lastCaptureError.length > 64
          || !/^[a-z][A-Za-z0-9]*$/.test(message.lastCaptureError)))) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  const diagnostics = Object.fromEntries(['state', 'sessionId', 'available', 'sourceKind', 'frameWidth', 'frameHeight',
    'framesReceived', 'framesProcessed', 'droppedNotifications', 'rawCaptureFps', 'probeProcessedFps',
    'rawFrameIntervalP50Ms', 'rawFrameIntervalP95Ms', 'rawFrameIntervalP99Ms', 'rawTimestampAnomalies',
    'lastFrameAgeMs', 'sizeChanges', 'framePoolRecreates', 'lastCaptureError', 'stopDurationMs', 'captureSuspended']
    .map((field) => [field, message[field]]));
  diagnostics.framePoolRecreates ??= null;
  diagnostics.captureSuspended ??= null;
  const audio = message.screenShareAudio;
  if (!audio || !['idle', 'starting', 'running', 'stopping', 'failed'].includes(audio.state)
      || (audio.sessionId !== null && (typeof audio.sessionId !== 'string' || audio.sessionId.length > 128))
      || (audio.sourceKind !== null && !['monitor', 'window'].includes(audio.sourceKind))) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  for (const key of ['sampleRate', 'channels', 'packetsReceived', 'framesReceived', 'silentPackets', 'droppedAudioChunks']) {
    if (audio[key] !== null && (!Number.isSafeInteger(audio[key]) || audio[key] < 0)) {
      throw new Error('mediaHelperInvalidDiagnostics');
    }
  }
  diagnostics.screenShareAudio = audio;
  return diagnostics;
}

function validTextureSize(value) {
  return value && Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 32768
    && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 32768;
}

function safeFailureCode(error) {
  const value = error instanceof Error ? error.message : '';
  const code = value.match(/(?:^|:)([a-z][A-Za-z0-9]{0,63})$/)?.[1];
  return code || 'mediaHelperFailed';
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

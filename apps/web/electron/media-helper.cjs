const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { win32 } = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const CAPABILITY_NAMES = [
  'videoSourceDiscovery',
  'microphoneCapture',
  'systemAudioCapture',
  'processAudioCapture',
];

class MediaHelperManager {
  constructor({
    executablePath,
    platform = process.platform,
    spawnProcess = spawn,
    createRequestId = randomUUID,
    handshakeTimeoutMs = 5000,
    requestTimeoutMs = 5000,
    // Rust audio workers wait up to 10 seconds for startup; leave time for its result event.
    audioStartTimeoutMs = 12_000,
    shutdownTimeoutMs = 1000,
    killTimeoutMs = 500,
    idleTimeoutMs = 30_000,
    retryDelayMs = 2000,
    onMicrophoneCaptureEnded = () => {},
    onHelperFailure = () => {},
    onDiagnostic = (message) => console.error(message),
  }) {
    this.executablePath = executablePath;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.createRequestId = createRequestId;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.audioStartTimeoutMs = audioStartTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.onMicrophoneCaptureEnded = onMicrophoneCaptureEnded;
    this.onHelperFailure = onHelperFailure;
    this.onDiagnostic = onDiagnostic;
    this.state = undefined;
    this.startPromise = undefined;
    this.capabilitiesPromise = undefined;
    this.idleTimer = undefined;
    this.children = new Set();
    this.retryAfter = 0;
    this.closing = false;
    this.lastError = undefined;
    this.videoSourceSnapshot = undefined;
    // 此处只持有来源身份；实际画面和共享声音均由 OBS 宿主持有。
    this.videoCapture = undefined;
    this.videoCaptureStart = undefined;
    this.videoCaptureStop = undefined;
    this.lastStoppedVideoCapture = undefined;
    this.microphoneCapture = undefined;
    this.microphoneCaptureStart = undefined;
    this.microphoneCaptureStartingSessionId = undefined;
    this.microphoneCaptureStop = undefined;
    this.lastStoppedMicrophoneCapture = undefined;
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
    try {
      const response = await this.sendRequest(state, 'listVideoSources', 'videoSources', this.requestTimeoutMs);
      const snapshot = validateVideoSources(response);
      // 刷新期间仍可确认已有来源；仅用校验通过的新快照替换，目标身份由原生启动再次检查。
      this.videoSourceSnapshot = { state, ids: new Set(snapshot.sources.map(({ sourceId }) => sourceId)) };
      return { ...snapshot, discoveryId: state.discoveryId };
    } catch (error) {
      // 原生枚举失败会撤销来源注册表，不能继续使用失败前的快照。
      if (this.videoSourceSnapshot?.state === state) this.videoSourceSnapshot = undefined;
      throw error;
    } finally {
      if (this.canCloseWhenIdle(state)) this.scheduleIdleShutdown(state);
    }
  }



  reserveVideo(sessionId, sourceId) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (typeof sessionId !== 'string' || sessionId.length > 128
        || !/^(monitor|window):[1-9]\d*:\d+$/.test(sourceId || '')) return Promise.reject(new Error('invalidVideoStart'));
    if (this.videoCapture || this.videoCaptureStart) {
      return Promise.reject(new Error('videoCaptureAlreadyRunning'));
    }
    const snapshot = this.videoSourceSnapshot;
    if (!snapshot || !snapshot.ids.has(sourceId) || !snapshot.state.alive) return Promise.reject(new Error('videoSourceExpired'));
    this.clearIdleTimer();
    const active = { state: snapshot.state, sessionId, sourceId, starting: true, stopping: false };
    this.videoCapture = active;
    active.state.videoSessionId = sessionId;
    const promise = this.runReserveVideo(active).finally(() => {
      if (this.videoCaptureStart?.promise === promise) this.videoCaptureStart = undefined;
      if (this.canCloseWhenIdle(active.state)) this.scheduleIdleShutdown(active.state);
    });
    this.videoCaptureStart = { state: active.state, sourceId, promise };
    return promise;
  }

  async runReserveVideo(active) {
    const { state, sessionId, sourceId } = active;
    try {
      const response = await this.sendRequest(state, 'reserveVideo', 'videoReserved', this.requestTimeoutMs,
        { sessionId, sourceId });
      const target = response.target;
      const monitor = target?.kind === 'monitor' && sourceId.startsWith('monitor:')
        && typeof target.monitorName === 'string' && /^\\\\\.\\DISPLAY[1-9]\d*$/i.test(target.monitorName);
      const window = target?.kind === 'window' && sourceId.startsWith('window:')
        && typeof target.windowId === 'string' && /^[1-9]\d{0,19}$/.test(target.windowId)
        && BigInt(target.windowId) <= 0xffffffffffffffffn
        && typeof target.lifetimeName === 'string' && target.lifetimeName.length <= 128
        && /^Local\\LycanSync\.WindowLifetime\.[1-9]\d*\.[1-9]\d*\.[1-9]\d*\.[1-9]\d*$/.test(target.lifetimeName)
        && target.lifetimeName.endsWith(`.${target.windowId}`)
        && Number.isInteger(target.processId) && target.processId > 0 && target.processId <= 0xffffffff
        && typeof target.processCreationTime === 'string' && /^[1-9]\d{0,19}$/.test(target.processCreationTime)
        && BigInt(target.processCreationTime) <= 0xffffffffffffffffn && typeof target.requiresWindowCapture === 'boolean'
        && typeof target.executable === 'string' && target.executable.length <= 4096
        && win32.isAbsolute(target.executable) && /\.exe$/i.test(target.executable)
        && !/[\u0000-\u001f\u007f]/.test(target.executable);
      if (response.sessionId !== sessionId || response.sourceId !== sourceId || (!monitor && !window)) {
        const error = new Error('mediaHelperInvalidVideoTarget');
        this.failState(state, error);
        throw error;
      }
      active.starting = false;
      return monitor ? { kind: 'monitor', monitorName: target.monitorName }
        : { kind: 'window', windowId: target.windowId, lifetimeName: target.lifetimeName,
          processId: target.processId, processCreationTime: target.processCreationTime,
          requiresWindowCapture: target.requiresWindowCapture, executable: target.executable };
    } catch (error) {
      if (this.videoCapture === active) this.videoCapture = undefined;
      delete state.videoSessionId;
      this.videoSourceSnapshot = undefined;
      throw error;
    }
  }


  async setRemoteControl(sessionId, controlSessionId, controllerIdentity) {
    const active = this.videoCapture;
    if (!active || active.sessionId !== sessionId || active.starting || active.stopping || !active.sourceId.startsWith('monitor:')) {
      throw new Error('remoteControlSourceUnavailable');
    }
    if (!validOpaqueId(controlSessionId) || !validOpaqueId(controllerIdentity) || active.remoteControl) {
      throw new Error('remoteControlInvalidSession');
    }
    const response = await this.sendRequest(active.state, 'setRemoteControl', 'acknowledged', this.requestTimeoutMs,
      { sessionId, sourceId: active.sourceId, controlSessionId, controllerIdentity });
    if (this.videoCapture !== active || active.stopping || response.command !== 'setRemoteControl' || response.changed !== true) {
      throw new Error('mediaHelperInvalidRemoteControlStart');
    }
    active.remoteControl = { controlSessionId, controllerIdentity, lastMoveSequence: 0,
      lastReliableSequence: 0, accepting: true, windowAt: Date.now(), rate: 0 };
    return { changed: true };
  }

  async sendRemoteInput(sessionId, controlSessionId, controllerIdentity, sequence, input) {
    const active = this.videoCapture;
    const control = active?.remoteControl;
    const safeInput = normalizeRemoteInput(input);
    if (!active || active.sessionId !== sessionId || active.stopping || !control || !control.accepting
        || control.controlSessionId !== controlSessionId || control.controllerIdentity !== controllerIdentity
        || !Number.isSafeInteger(sequence) || sequence < 1 || !safeInput) {
      throw new Error('remoteControlInvalidSession');
    }
    const isMove = safeInput.kind === 'move';
    if (isMove) {
      if (sequence <= control.lastMoveSequence || sequence <= control.lastReliableSequence) {
        throw new Error('remoteControlInvalidSession');
      }
      control.lastMoveSequence = sequence;
    } else {
      if (sequence <= control.lastReliableSequence) throw new Error('remoteControlInvalidSession');
      control.lastReliableSequence = sequence;
    }
    const now = Date.now();
    if (now - control.windowAt >= 1000) { control.windowAt = now; control.rate = 0; }
    if (control.rate >= 120) {
      if (isMove) return { changed: false, dropped: true };
      control.accepting = false;
      await this.clearRemoteControl(sessionId, controlSessionId);
      throw new Error('remoteControlInputRateExceeded');
    }
    control.rate += 1;
    const response = await this.sendRequest(active.state, 'remoteInput', 'acknowledged', this.requestTimeoutMs,
      { sessionId, controlSessionId, controllerIdentity, sequence, input: safeInput });
    if (response.command !== 'remoteInput') throw new Error('mediaHelperInvalidRemoteInput');
    return { changed: response.changed, dropped: isMove && response.changed !== true };
  }

  async clearRemoteControl(sessionId, controlSessionId) {
    const active = this.videoCapture;
    const control = active?.remoteControl;
    if (!control) return { changed: false };
    if (!active || active.sessionId !== sessionId || control.controlSessionId !== controlSessionId) {
      throw new Error('remoteControlInvalidSession');
    }
    control.accepting = false;
    const response = await this.sendRequest(active.state, 'clearRemoteControl', 'acknowledged', this.requestTimeoutMs,
      { sessionId, controlSessionId });
    if (response.command !== 'clearRemoteControl') throw new Error('mediaHelperInvalidRemoteControlStop');
    active.remoteControl = undefined;
    return { changed: response.changed };
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
    this.videoCapture.stopping = true;
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




  startMicrophoneCapture(pipeId, sessionId, settings) {
    if (this.closing) return Promise.reject(new Error('mediaHelperShuttingDown'));
    if (this.platform !== 'win32' || !validPipeId(pipeId) || !validOpaqueId(sessionId)
        || !validMicrophoneSettings(settings)) {
      return Promise.reject(new Error('invalidMicrophoneCaptureStart'));
    }
    if (this.microphoneCapture) {
      return this.microphoneCapture.sessionId === sessionId
        ? Promise.resolve({ ...this.microphoneCapture.format, changed: false })
        : Promise.reject(new Error('microphoneCaptureAlreadyRunning'));
    }
    if (this.microphoneCaptureStart) return this.microphoneCaptureStart;
    const promise = this.runStartMicrophoneCapture(pipeId, sessionId, settings)
      .finally(() => {
        if (this.microphoneCaptureStart === promise) {
          this.microphoneCaptureStart = undefined;
          this.microphoneCaptureStartingSessionId = undefined;
        }
      });
    this.microphoneCaptureStart = promise;
    this.microphoneCaptureStartingSessionId = sessionId;
    return promise;
  }

  async runStartMicrophoneCapture(pipeId, sessionId, settings) {
    const state = await this.ensureStarted();
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(state, 'startMicrophoneCapture', 'microphoneCaptureStarted',
        this.audioStartTimeoutMs, { pipeId, sessionId, ...settings });
      if (response.sessionId !== sessionId || response.changed !== true
          || response.sampleRate !== 48000 || response.channels !== 1
          || response.bitsPerSample !== 32 || response.nominalChunkMs !== 10) {
        this.failState(state, new Error('mediaHelperInvalidMicrophoneCaptureStart'));
        throw new Error('mediaHelperInvalidMicrophoneCaptureStart');
      }
      const format = {
        sampleRate: response.sampleRate,
        channels: 1,
        bitsPerSample: 32,
        nominalChunkMs: 10,
      };
      this.microphoneCapture = { state, sessionId, format };
      state.microphoneCaptureSessionId = sessionId;
      return { ...format, changed: true };
    } finally {
      if (this.canCloseWhenIdle(state)) this.scheduleIdleShutdown(state);
    }
  }

  configureMicrophoneCapture(sessionId, settings) {
    const active = this.microphoneCapture;
    if (!active || active.sessionId !== sessionId || !validMicrophoneSettings(settings)) {
      return Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    }
    return this.sendRequest(active.state, 'configureMicrophoneCapture', 'acknowledged', this.requestTimeoutMs,
      { sessionId, ...settings }).then((response) => {
      if (response.command !== 'configureMicrophoneCapture' || response.changed !== true) {
        throw new Error('mediaHelperInvalidMicrophoneCaptureSettings');
      }
      return { changed: true };
    });
  }

  stopMicrophoneCapture(sessionId) {
    if (!this.microphoneCapture && this.microphoneCaptureStart) {
      if (this.microphoneCaptureStartingSessionId !== sessionId) {
        return Promise.reject(new Error('microphoneCaptureSessionMismatch'));
      }
      if (this.microphoneCaptureStop) return this.microphoneCaptureStop;
      const start = this.microphoneCaptureStart;
      const promise = start.then(() => {
        if (this.microphoneCaptureStop === promise) this.microphoneCaptureStop = undefined;
        return this.stopMicrophoneCapture(sessionId);
      }, (error) => {
        if (this.lastStoppedMicrophoneCapture === sessionId) return { changed: false };
        throw error;
      }).finally(() => {
        if (this.microphoneCaptureStop === promise) this.microphoneCaptureStop = undefined;
      });
      this.microphoneCaptureStop = promise;
      return promise;
    }
    if (!this.microphoneCapture) {
      return this.lastStoppedMicrophoneCapture === sessionId
        ? Promise.resolve({ changed: false })
        : Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    }
    if (this.microphoneCapture.sessionId !== sessionId) {
      return Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    }
    if (this.microphoneCaptureStop) return this.microphoneCaptureStop;
    const active = this.microphoneCapture;
    const promise = this.sendRequest(active.state, 'stopMicrophoneCapture', 'acknowledged', this.requestTimeoutMs,
      { sessionId }).then((response) => {
      if (response.command !== 'stopMicrophoneCapture') throw new Error('mediaHelperInvalidMicrophoneCaptureStop');
      this.microphoneCapture = undefined;
      this.lastStoppedMicrophoneCapture = sessionId;
      delete active.state.microphoneCaptureSessionId;
      return { changed: response.changed };
    }).finally(() => {
      if (this.microphoneCaptureStop === promise) this.microphoneCaptureStop = undefined;
      if (this.canCloseWhenIdle(active.state)) this.scheduleIdleShutdown(active.state);
    });
    this.microphoneCaptureStop = promise;
    return promise;
  }


  async runStopVideo(active) {
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(active.state, 'stopVideo', 'acknowledged', this.requestTimeoutMs,
        { sessionId: active.sessionId });
      if (response.command !== 'stopVideo') throw new Error('mediaHelperInvalidVideoStop');
      active.remoteControl = undefined;
      this.videoCapture = undefined;
      this.lastStoppedVideoCapture = active.sessionId;
      delete active.state.videoSessionId;
      return { changed: response.changed };
    } finally {
      if (this.canCloseWhenIdle(active.state)) this.scheduleIdleShutdown(active.state);
    }
  }



  async getDiagnostics() {
    const state = await this.ensureStarted();
    this.clearIdleTimer();
    try {
      const diagnostics = validateDiagnostics(
        await this.sendRequest(state, 'diagnostics', 'diagnostics', this.requestTimeoutMs),
      );
      if (this.videoCapture?.state === state
          && (diagnostics.state === 'idle' || diagnostics.sessionId !== this.videoCapture.sessionId)) {
        this.lastStoppedVideoCapture = this.videoCapture.sessionId;
        this.videoCapture = undefined;
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
        // 协议和诊断分流；安装版没有终端，诊断由主进程持久化。
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.retryAfter = Date.now() + this.retryDelayMs;
      return Promise.reject(new Error('mediaHelperStartFailed'));
    }

    let stateResolveClose;
    const state = {
      child,
      discoveryId: randomUUID(),
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
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        try { this.onDiagnostic(chunk.slice(offset, offset + 4096)); }
        catch (error) { console.error('原生媒体诊断回调失败', error.message); }
      }
    });
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
    if (!message || message.protocolVersion !== PROTOCOL_VERSION || typeof message.event !== 'string') {
      this.failState(state, new Error('mediaHelperInvalidResponse'));
      return;
    }
    if (message.event === 'microphoneCaptureEnded') {
      if (!validOpaqueId(message.sessionId) || !isStableCode(message.code)) {
        this.failState(state, new Error('mediaHelperInvalidMicrophoneCaptureEnded'));
        return;
      }
      const active = this.microphoneCapture;
      if (!active || active.state !== state || active.sessionId !== message.sessionId) return;
      this.microphoneCapture = undefined;
      this.lastStoppedMicrophoneCapture = message.sessionId;
      delete state.microphoneCaptureSessionId;
      try { this.onMicrophoneCaptureEnded(state, { sessionId: message.sessionId, code: message.code }); }
      catch { /* The capture owner still receives the failure and can release its session. */ }
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
      && !this.closingDown(state) && this.videoCapture?.state !== state && this.microphoneCapture?.state !== state
      && this.videoCaptureStart?.promise === undefined && this.microphoneCaptureStart === undefined;
  }

  invalidateState(state) {
    if (this.videoSourceSnapshot?.state === state) this.videoSourceSnapshot = undefined;
    if (this.videoCapture?.state === state) this.videoCapture = undefined;
    if (this.videoCaptureStart?.state === state) this.videoCaptureStart = undefined;
    if (this.microphoneCapture?.state === state) this.microphoneCapture = undefined;
    if (this.microphoneCaptureStart) this.microphoneCaptureStart = undefined;
    this.microphoneCaptureStartingSessionId = undefined;
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
  const microphone = result.microphoneCapture;
  const supportedMicrophone = new Map([
    ['windowsWasapiSharedModeSonora', true],
    ['platformUnsupported', false],
    ['notImplemented', false],
  ]);
  if (supportedMicrophone.get(microphone.reason) !== microphone.available) {
    throw new Error('mediaHelperInvalidCapabilities');
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
    if ((source.kind === 'monitor' && (!source.monitorOrigin
        || !Number.isInteger(source.monitorOrigin.x) || !Number.isInteger(source.monitorOrigin.y)
        || Math.abs(source.monitorOrigin.x) > 2147483647 || Math.abs(source.monitorOrigin.y) > 2147483647))
        || (source.kind === 'window' && source.monitorOrigin !== undefined)) {
      throw new Error('mediaHelperInvalidVideoSources');
    }
    if (source.windowId !== undefined && (source.kind !== 'window'
        || typeof source.windowId !== 'string' || !/^[1-9]\d{0,19}$/.test(source.windowId))) {
      throw new Error('mediaHelperInvalidVideoSources');
    }
    return {
      sourceId: source.sourceId,
      kind: source.kind,
      title: source.title,
      width: source.width,
      height: source.height,
      primary: source.primary,
      ...(source.windowId ? { windowId: source.windowId } : {}),
      ...(source.monitorOrigin ? { monitorOrigin: { x: source.monitorOrigin.x, y: source.monitorOrigin.y } } : {}),
    };
  });
  return { revision: message.revision, sources };
}

function validateDiagnostics(message) {
  if (typeof message.helperVersion !== 'string' || !/^[\w.+-]{1,80}$/.test(message.helperVersion)
      || message.captureBackend !== null
      || !['idle', 'starting', 'running', 'stopping'].includes(message.state)
      || (message.sessionId !== null && (typeof message.sessionId !== 'string' || message.sessionId.length > 128))
      || (message.sourceKind !== null && !['monitor', 'window'].includes(message.sourceKind))) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  const numericFields = [
    'frameWidth', 'frameHeight', 'framesReceived', 'framesProcessed',
  ];
  for (const field of numericFields) {
    const value = message[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('mediaHelperInvalidDiagnostics');
    }
  }
  if (message.microphoneCaptureDroppedChunks !== undefined
      && (!Number.isSafeInteger(message.microphoneCaptureDroppedChunks) || message.microphoneCaptureDroppedChunks < 0)) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  if (typeof message.available !== 'boolean'
      || (message.captureSuspended !== undefined && message.captureSuspended !== null
        && typeof message.captureSuspended !== 'boolean')) {
    throw new Error('mediaHelperInvalidDiagnostics');
  }
  const diagnostics = Object.fromEntries(['helperVersion', 'captureBackend', 'state', 'sessionId', 'available', 'sourceKind', 'frameWidth', 'frameHeight',
    'framesReceived', 'framesProcessed', 'captureSuspended']
    .map((field) => [field, message[field]]));
  diagnostics.captureSuspended ??= null;
  diagnostics.microphoneCaptureDroppedChunks = message.microphoneCaptureDroppedChunks ?? 0;
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

function safeFailureCode(error) {
  const value = error instanceof Error ? error.message : '';
  const code = value.match(/(?:^|:)([a-z][A-Za-z0-9]{0,63})$/)?.[1];
  return code || 'mediaHelperFailed';
}

function isStableCode(value) {
  return typeof value === 'string' && /^[a-z][A-Za-z0-9]{0,63}$/.test(value);
}

function validOpaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9:_-]+$/.test(value);
}

function validPipeId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validMicrophoneSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = ['inputGain', 'noiseSuppression', 'autoGainControl', 'voiceEnhancement'];
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
    && typeof value.inputGain === 'number' && Number.isFinite(value.inputGain)
    && value.inputGain >= 0 && value.inputGain <= 2
    && typeof value.noiseSuppression === 'boolean'
    && typeof value.autoGainControl === 'boolean'
    && typeof value.voiceEnhancement === 'boolean';
}

function normalizeRemoteInput(input) {
  if (!input || typeof input !== 'object') return false;
  const keys = Object.keys(input);
  const exactKeys = (...expected) => keys.length === expected.length && expected.every((key) => keys.includes(key));
  if (input.kind === 'move' && exactKeys('kind', 'x', 'y')
      && Number.isInteger(input.x) && input.x >= 0 && input.x <= 65535
      && Number.isInteger(input.y) && input.y >= 0 && input.y <= 65535) return { kind: 'move', x: input.x, y: input.y };
  if ((input.kind === 'buttonDown' || input.kind === 'buttonUp') && exactKeys('kind', 'button', 'x', 'y')
      && (input.button === 'left' || input.button === 'right')
      && Number.isInteger(input.x) && input.x >= 0 && input.x <= 65535
      && Number.isInteger(input.y) && input.y >= 0 && input.y <= 65535) {
    return { kind: input.kind, button: input.button, x: input.x, y: input.y };
  }
  if (input.kind === 'wheel' && exactKeys('kind', 'delta')
      && Number.isInteger(input.delta) && Math.abs(input.delta) <= 1200) return { kind: 'wheel', delta: input.delta };
  if ((input.kind === 'keyDown' || input.kind === 'keyUp') && exactKeys('kind', 'key')
      && typeof input.key === 'string'
      && /^(enter|escape|space|tab|backspace|delete|home|end|pageUp|pageDown|left|right|up|down|shift|control|alt|digit[0-9]|letter[A-Z])$/.test(input.key)) {
    return { kind: input.kind, key: input.key };
  }
  return null;
}

function waitForClose(closedPromise, timeoutMs) {
  let timer;
  return Promise.race([
    closedPromise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { MediaHelperManager, MAX_LINE_BYTES, PROTOCOL_VERSION };

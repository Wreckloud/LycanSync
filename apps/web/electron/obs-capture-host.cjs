const { spawn } = require('node:child_process');
const { win32 } = require('node:path');

const MAX_LINE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 4_000;
const TERMINATE_TIMEOUT_MS = 1_500;
const DIAGNOSTIC_TIMEOUT_MS = 2_000;
const CONFIGURE_TIMEOUT_MS = 3_000;
const AUDIO_START_TIMEOUT_MS = 10_000;
const AUDIO_STOP_TIMEOUT_MS = 3_000;

class ObsCaptureHostManager {
  constructor({ executablePath, modulePath, dataPath, configPath, platform = process.platform, spawnProcess = spawn,
    clientProcessId = process.pid, onAudioFailure = () => {}, onAudioStopped = () => {},
    onFrame = () => {}, onFailure = () => {}, onClosed = () => {}, onSuspended = () => {}, onDiagnostic = () => {} }) {
    this.executablePath = executablePath;
    this.modulePath = modulePath;
    this.dataPath = dataPath;
    this.configPath = configPath;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.onFrame = onFrame;
    this.onFailure = onFailure;
    this.onClosed = onClosed;
    this.onSuspended = onSuspended;
    this.onDiagnostic = onDiagnostic;
    this.onAudioFailure = onAudioFailure;
    this.onAudioStopped = onAudioStopped;
    this.clientProcessId = clientProcessId;
    this.state = undefined;
  }

  async start(sourceId, maxFps, sessionId, target, settings, resolution = { width: 1920, height: 1080 }) {
    if (this.platform !== 'win32') throw new Error('platformUnsupported');
    if (this.state) throw new Error('obsCaptureAlreadyRunning');
    if (typeof sourceId !== 'string' || !/^(monitor|window):[1-9]\d*:\d+$/.test(sourceId)
        || ![30, 60, 120, 180].includes(maxFps) || !validTarget(target, sourceId) || !isSessionId(sessionId)
        || !validResolution(resolution) || typeof this.configPath !== 'string' || !win32.isAbsolute(this.configPath)
        || !settings || typeof settings.hideCursor !== 'boolean' || typeof settings.hideBorder !== 'boolean') {
      throw new Error('invalidObsCaptureArguments');
    }

    const child = this.spawnProcess(this.executablePath,
      [this.modulePath, this.dataPath, target.kind, target.kind === 'monitor' ? target.monitorName : target.windowId,
        settings.hideCursor ? '0' : '1', settings.hideBorder ? '1' : '0', sessionId, this.configPath, String(maxFps),
        target.kind !== 'monitor' ? target.propertyName : '', target.kind !== 'monitor' ? target.propertyValue : '',
        String(resolution.width), String(resolution.height)],
      // 官方 libobs 按 bin/64bit 的相对路径查找 effect 文件，不能继承项目工作目录。
      { cwd: win32.dirname(this.executablePath), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const state = { child, alive: true, closed: false, videoSessionId: sessionId, buffer: '', startTimer: undefined,
      startResolve: undefined, startReject: undefined, failureNotified: false, executablePath: this.executablePath,
      onFailure: this.onFailure, helperVersion: undefined, maxFps, resolution: { ...resolution },
      diagnosticSequence: 0, pendingDiagnostics: undefined, configurationSequence: 0, pendingConfiguration: undefined };
    state.closePromise = new Promise((resolve) => { state.resolveClose = resolve; });
    state.releaseSharedTextureSlot = (frameSessionId, slotIndex) => {
      if (!state.alive || state.closed || frameSessionId !== state.videoSessionId
          || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 3) {
        return Promise.reject(new Error('obsCaptureSlotReleaseUnavailable'));
      }
      return writeLine(child, `release:${slotIndex}`);
    };
    this.state = state;

    const started = new Promise((resolve, reject) => {
      state.startResolve = resolve;
      state.startReject = reject;
      state.startTimer = setTimeout(() => failState(state, new Error('obsCaptureStartTimeout')), START_TIMEOUT_MS);
      state.startTimer.unref?.();
    });
    child.stdout.on('data', (chunk) => this.readStdout(state, chunk));
    child.stderr.on('data', (chunk) => this.onDiagnostic(String(chunk).trim().slice(0, 2000)));
    child.stdin.on('error', (error) => failState(state, error));
    child.once('error', (error) => {
      if (!child.pid) this.closeState(state, error);
      else failState(state, error);
    });
    child.once('close', (code, signal) => {
      this.closeState(state, code === 0 ? undefined : new Error(`obsCaptureHostExited:${code ?? signal ?? 'unknown'}`));
    });
    return started;
  }

  readStdout(state, chunk) {
    state.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_LINE_BYTES && !state.buffer.includes('\n')) {
      failState(state, new Error('obsCaptureProtocolLineTooLong'));
      return;
    }
    let newline;
    while ((newline = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        failState(state, new Error('obsCaptureProtocolLineInvalid'));
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch {
        failState(state, new Error('obsCaptureProtocolJsonInvalid'));
        return;
      }
      this.handleEvent(state, event);
      if (state.closed || state.failed) return;
    }
  }

  handleEvent(state, event) {
    if (state.failed || state.closed) return;
    if (!event || typeof event.event !== 'string') {
      failState(state, new Error('obsCaptureProtocolEventInvalid'));
      return;
    }
    if (['audioStarted', 'audioFailed', 'audioStopped'].includes(event.event)) {
      const audio = state.audio;
      // 同一画面可多次开关声音；旧尝试的响应不能结束或重新开启下一次声音。
      if (this.state !== state || !audio || event.sessionId !== state.videoSessionId || event.audioId !== audio.id) return;
      if (event.event === 'audioStopped') {
        audio.finishStart?.(new Error('screenShareAudioSessionStopped'));
        audio.finishStop?.(undefined, { changed: true });
        state.audio = undefined;
        this.onAudioStopped(state, { sessionId: state.videoSessionId, audioId: audio.id });
      } else if (event.event === 'audioFailed') {
        this.failAudio(state, audio, new Error(validAudioCode(event.code) ? event.code : 'screenShareAudioFailed'));
      } else if (!audio.stopping && !state.stopRequested) {
        if (event.sampleRate !== 48_000 || event.channels !== 2 || event.bitsPerSample !== 32 || event.nominalChunkMs !== 10
            || ![event.pluginLoadMs, event.captureReadyMs].every(value => Number.isFinite(value) && value >= 0 && value <= 300_000)) {
          this.failAudio(state, audio, new Error('screenShareAudioFormatUnsupported'));
        } else if (audio.finishStart) {
          audio.started = true;
          audio.finishStart(undefined, { sampleRate: 48_000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10,
            pluginLoadMs: event.pluginLoadMs, captureReadyMs: event.captureReadyMs });
        }
      }
      return;
    }
    if (event.event === 'captureStarted') {
      if (this.state !== state || state.closed || state.stopRequested || !state.startResolve) return;
      if (event.helperVersion !== '32.2.2') {
        failState(state, new Error('obsCaptureVersionUnsupported'));
        return;
      }
      state.helperVersion = event.helperVersion;
      clearTimeout(state.startTimer);
      state.startTimer = undefined;
      state.startResolve({ sessionId: state.videoSessionId, changed: true });
      state.startResolve = undefined;
      state.startReject = undefined;
      return;
    }
    if (event.event === 'sharedTextureFrame') {
      if (this.state !== state || state.closed || !validFrameEvent(event, state.videoSessionId)) {
        failState(state, new Error('obsCaptureFrameInvalid'));
        return;
      }
      try { this.onFrame(state, event); } catch {
        failState(state, new Error('obsCaptureFrameDeliveryFailed'));
      }
      return;
    }
    if (event.event === 'captureSuspended') {
      if (state.stopRequested) return;
      if (this.state !== state || event.sessionId !== state.videoSessionId
          || typeof event.suspended !== 'boolean') {
        failState(state, new Error('obsCaptureSuspensionInvalid'));
        return;
      }
      this.onSuspended(state, { sessionId: state.videoSessionId, suspended: event.suspended });
      return;
    }
    if (event.event === 'diagnostics') {
      const request = state.pendingDiagnostics;
      if (!request || event.requestId !== request.id) return;
      if (this.state !== state || event.sessionId !== state.videoSessionId || !validCounters(event)
          || !validAudioDiagnostics(event.screenShareAudio)) {
        failState(state, new Error('obsCaptureDiagnosticsInvalid'));
        return;
      }
      request.finish(undefined, { helperVersion: state.helperVersion, renderedFrames: event.renderedFrames,
        bridgeFrames: event.bridgeFrames, bridgeDroppedFrames: event.bridgeDroppedFrames, screenShareAudio: event.screenShareAudio });
      return;
    }
    if (event.event === 'captureConfigured' || event.event === 'captureConfigurationRejected') {
      const request = state.pendingConfiguration;
      if (!request || event.requestId !== request.id) return;
      if (this.state !== state || event.sessionId !== state.videoSessionId
          || event.maxFps !== (event.event === 'captureConfigured' ? request.maxFps : state.maxFps)
          || event.width !== (event.event === 'captureConfigured' ? request.resolution.width : state.resolution.width)
          || event.height !== (event.event === 'captureConfigured' ? request.resolution.height : state.resolution.height)) {
        failState(state, new Error('obsCaptureConfigurationInvalid'));
        return;
      }
      if (event.event === 'captureConfigurationRejected') request.finish(new Error('obsCaptureConfigurationRejected'));
      else {
        state.maxFps = event.maxFps;
        state.resolution = request.resolution;
        request.finish(undefined, { changed: true });
      }
      return;
    }
    if (event.event === 'captureStopped') return;
    if (/^[a-z][A-Za-z0-9]{0,63}$/.test(event.event)) {
      failState(state, new Error(event.event));
      return;
    }
    failState(state, new Error('obsCaptureProtocolEventInvalid'));
  }

  getDiagnostics(sessionId) {
    const state = this.state;
    if (!state || !state.alive || state.closed || state.failed || state.stopRequested
        || state.videoSessionId !== sessionId || !state.helperVersion) {
      return Promise.reject(new Error('obsCaptureDiagnosticsUnavailable'));
    }
    if (state.pendingDiagnostics) return state.pendingDiagnostics.promise;
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const request = { id: String(++state.diagnosticSequence), promise, timer: undefined, finish: (error, result) => {
      if (state.pendingDiagnostics !== request) return;
      clearTimeout(request.timer);
      state.pendingDiagnostics = undefined;
      if (error) rejectRequest(error);
      else resolveRequest(result);
    } };
    state.pendingDiagnostics = request;
    // 复用页面已有的低频采样；堵满纹理槽时仍能读取宿主的真实计数。
    request.timer = setTimeout(() => request.finish(new Error('obsCaptureDiagnosticsTimeout')), DIAGNOSTIC_TIMEOUT_MS);
    request.timer.unref?.();
    void writeLine(state.child, `diagnostics:${request.id}`).catch((error) => request.finish(error));
    return promise;
  }

  configureVideo(sessionId, maxFps, resolution = this.state?.resolution) {
    const state = this.state;
    if (!state || !state.alive || state.closed || state.failed || state.stopRequested
        || state.videoSessionId !== sessionId || !state.helperVersion || ![30, 60, 120, 180].includes(maxFps) || !validResolution(resolution)) {
      return Promise.reject(new Error('invalidVideoConfiguration'));
    }
    if (state.pendingConfiguration) return Promise.reject(new Error('obsCaptureConfigurationInProgress'));
    let resolveRequest, rejectRequest;
    const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const request = { id: String(++state.configurationSequence), maxFps, resolution: { ...resolution }, timer: undefined, finish: (error, result) => {
      if (state.pendingConfiguration !== request) return;
      clearTimeout(request.timer);
      state.pendingConfiguration = undefined;
      if (error) rejectRequest(error);
      else resolveRequest(result);
    } };
    state.pendingConfiguration = request;
    // 超时后实际尺寸和帧率未知，结束本次采集，不能按旧配置继续发送。
    request.timer = setTimeout(() => failState(state, new Error('obsCaptureConfigurationTimeout')), CONFIGURE_TIMEOUT_MS);
    request.timer.unref?.();
    void writeLine(state.child, `configure:${request.id}:${maxFps}:${resolution.width}:${resolution.height}`).catch((error) => {
      if (state.pendingConfiguration === request) failState(state, error);
    });
    return promise;
  }

  startScreenAudio(sessionId, pipeId, mode) {
    const state = this.state;
    if (!state || !state.alive || state.closed || state.failed || state.stopRequested
        || state.videoSessionId !== sessionId || !state.helperVersion || !isSessionId(pipeId)
        || !['process', 'systemMix'].includes(mode) || !Number.isInteger(this.clientProcessId)
        || this.clientProcessId <= 0 || this.clientProcessId > 0xffffffff) {
      return Promise.reject(new Error('invalidScreenShareAudioStart'));
    }
    if (state.audio) return Promise.reject(new Error('screenShareAudioAlreadyRunning'));
    const audio = { id: pipeId, stopping: false, started: false, failureNotified: false };
    state.audio = audio;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failAudio(state, audio, new Error('screenShareAudioStartTimedOut')), AUDIO_START_TIMEOUT_MS);
      timer.unref?.();
      audio.finishStart = (error, result) => {
        if (!audio.finishStart) return;
        clearTimeout(timer);
        audio.finishStart = undefined;
        if (error) reject(error); else resolve(result);
      };
    });
    void writeLine(state.child, `audioStart:${pipeId}:${mode}:${this.clientProcessId}`)
      .catch(() => this.failAudio(state, audio, new Error('screenShareAudioPipeFailed')));
    return promise;
  }

  stopScreenAudio(sessionId, audioId) {
    const state = this.state;
    if (!state || state.closed) return Promise.resolve({ changed: false });
    if (state.videoSessionId !== sessionId) return Promise.reject(new Error('screenShareAudioSessionMismatch'));
    const audio = state.audio;
    if (!audio) return Promise.resolve({ changed: false });
    if (audio.id !== audioId) return Promise.reject(new Error('screenShareAudioSessionMismatch'));
    if (audio.stopPromise) return audio.stopPromise;
    audio.stopping = true;
    audio.finishStart?.(new Error('screenShareAudioSessionStopped'));
    audio.stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => audio.finishStop(new Error('screenShareAudioStopFailed')), AUDIO_STOP_TIMEOUT_MS);
      timer.unref?.();
      audio.finishStop = (error, result) => {
        if (!audio.finishStop) return;
        clearTimeout(timer);
        audio.finishStop = undefined;
        if (error) reject(error); else resolve(result);
      };
    });
    // 声音停止不确认时保留阻挡，不杀死仍可用的画面；整次共享停止仍以宿主退出为准。
    void writeLine(state.child, `audioStop:${audioId}`)
      .catch(() => audio.finishStop?.(new Error('screenShareAudioStopFailed')));
    return audio.stopPromise;
  }

  failAudio(state, audio, error) {
    if (this.state !== state || state.audio !== audio || state.closed) return;
    audio.finishStart?.(error);
    if (!audio.failureNotified && !audio.stopping && !state.stopRequested) {
      audio.failureNotified = true;
      this.onAudioFailure(state, { sessionId: state.videoSessionId, audioId: audio.id, code: error.message });
    }
    void this.stopScreenAudio(state.videoSessionId, audio.id).catch(() => {});
  }

  async stop(sessionId) {
    const state = this.state;
    if (!state) return { changed: false };
    if (state.videoSessionId !== sessionId) throw new Error('videoSessionMismatch');
    if (state.closed) {
      if (this.state === state) this.state = undefined;
      return { changed: true };
    }
    state.stopRequested = true;
    if (state.audio) {
      state.audio.stopping = true;
      state.audio.finishStart?.(new Error('obsCaptureStopping'));
    }
    state.pendingDiagnostics?.finish(new Error('obsCaptureStopping'));
    state.pendingConfiguration?.finish(new Error('obsCaptureStopping'));
    // stdin 背压不能阻止退出计时；是否停止只以子进程关闭事件为准。
    void writeLine(state.child, 'shutdown').catch(() => {});
    await waitForClose(state, SHUTDOWN_TIMEOUT_MS);
    if (!state.closed) {
      state.child.kill();
      await waitForClose(state, TERMINATE_TIMEOUT_MS);
    }
    // 超时不是退出确认；保留当前进程身份，阻止再次启动采集。
    if (!state.closed) throw new Error('obsCaptureStopUnconfirmed');
    return { changed: true };
  }

  closeState(state, error) {
    if (state.closed) return;
    state.alive = false;
    state.closed = true;
    state.audio?.finishStart?.(error ?? new Error('obsCaptureHostClosed'));
    state.audio?.finishStop?.(undefined, { changed: true });
    state.audio = undefined;
    clearTimeout(state.startTimer);
    state.pendingDiagnostics?.finish(error ?? new Error('obsCaptureHostClosed'));
    state.pendingConfiguration?.finish(error ?? new Error('obsCaptureHostClosed'));
    const closeError = error ?? (!state.stopRequested ? new Error('obsCaptureHostClosedUnexpectedly') : undefined);
    if (closeError) failState(state, closeError, false);
    state.startReject?.(closeError ?? new Error('obsCaptureHostClosedBeforeStart'));
    state.startResolve = undefined;
    state.startReject = undefined;
    if (this.state === state) this.state = undefined;
    state.resolveClose?.();
    state.resolveClose = undefined;
    this.onClosed(state);
  }
}

function validTarget(target, sourceId) {
  if (!target || typeof target !== 'object') return false;
  if (target.kind === 'monitor') return sourceId.startsWith('monitor:')
    && typeof target.monitorName === 'string' && /^\\\\\.\\DISPLAY[1-9]\d*$/i.test(target.monitorName);
  return ['window', 'game'].includes(target.kind) && sourceId.startsWith('window:')
    && typeof target.windowId === 'string' && /^[1-9]\d{0,19}$/.test(target.windowId)
    && BigInt(target.windowId) <= 0xffffffffffffffffn && typeof target.propertyValue === 'string'
    && /^[1-9]\d{0,19}$/.test(target.propertyValue) && BigInt(target.propertyValue) <= 0xffffffffffffffffn
    && typeof target.propertyName === 'string' && target.propertyName.length <= 128
    && /^LycanSync\.MediaHelper\.Window\.\d+\.\d+\.\d+$/.test(target.propertyName);
}

function validFrameEvent(event, sessionId) {
  return event.sessionId === sessionId && Number.isInteger(event.slotIndex) && event.slotIndex >= 0
    && event.slotIndex < 3 && typeof event.sourceHandleHex === 'string'
    && /^[0-9a-f]{16}$/i.test(event.sourceHandleHex) && event.pixelFormat === 'bgra'
    && isPositiveSize(event.codedSize) && isPositiveSize(event.contentSize)
    && event.contentSize.width <= event.codedSize.width && event.contentSize.height <= event.codedSize.height
    && Number.isSafeInteger(event.timestampMicros) && event.timestampMicros >= 0
    && Number.isSafeInteger(event.bridgeFrames) && event.bridgeFrames > 0
    && validCounters(event);
}

function validCounters(event) {
  return [event.renderedFrames, event.bridgeFrames, event.bridgeDroppedFrames]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    && event.renderedFrames >= event.bridgeFrames + event.bridgeDroppedFrames;
}

function validAudioCode(code) {
  return ['screenShareAudioAlreadyRunning', 'screenShareAudioStartFailed', 'screenShareAudioStartTimedOut',
    'screenShareAudioUnsupported', 'screenShareAudioTargetUnavailable', 'screenShareAudioPipeFailed',
    'screenShareAudioStopFailed', 'screenShareAudioFailed', 'screenShareAudioFormatUnsupported'].includes(code);
}

function validAudioDiagnostics(audio) {
  return audio && ['idle', 'starting', 'running', 'stopping', 'failed'].includes(audio.state)
    && ((Number.isInteger(audio.sampleRate) && audio.sampleRate >= 8000 && audio.sampleRate <= 192000
      && Number.isInteger(audio.channels) && audio.channels >= 1 && audio.channels <= 8)
      || (audio.sampleRate === null && audio.channels === null))
    && ['packetsReceived', 'framesReceived', 'silentPackets', 'droppedAudioChunks']
      .every((key) => Number.isSafeInteger(audio[key]) && audio[key] >= 0)
    && audio.silentPackets <= audio.packetsReceived && (audio.lastError === null || validAudioCode(audio.lastError));
}

function validResolution(size) {
  return size && [360, 720, 1080, 1440].includes(size.height) && size.width === size.height * 16 / 9;
}

function isPositiveSize(size) {
  return size && Number.isInteger(size.width) && size.width > 0 && size.width <= 8192
    && Number.isInteger(size.height) && size.height > 0 && size.height <= 8192;
}

function isSessionId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function writeLine(child, line) {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

function waitForClose(state, timeoutMs) {
  if (state.closed) return Promise.resolve();
  let timer;
  return Promise.race([state.closePromise, new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

function failState(state, error, kill = true) {
  state.failed = true;
  state.pendingDiagnostics?.finish(error);
  state.pendingConfiguration?.finish(error);
  if (state.startReject) {
    clearTimeout(state.startTimer);
    state.startTimer = undefined;
    state.startReject(error);
    state.startResolve = undefined;
    state.startReject = undefined;
  }
  if (!state.failureNotified) {
    state.failureNotified = true;
    state.onFailure?.(state, error);
  }
  if (kill && state.alive && !state.closed) state.child.kill();
}

module.exports = { ObsCaptureHostManager };

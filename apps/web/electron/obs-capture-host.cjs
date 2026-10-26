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
const IDLE_TIMEOUT_MS = 180_000;

class ObsCaptureHostManager {
  constructor({ executablePath, modulePath, dataPath, configPath, platform = process.platform, spawnProcess = spawn,
    clientProcessId = process.pid, onAudioFailure = () => {}, onAudioStopped = () => {},
    onFrame = () => {}, onFailure = () => {}, onClosed = () => {}, onSuspended = () => {}, onDiagnostic = () => {},
    onCaptureDiagnostic = () => {} }) {
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
    this.onCaptureDiagnostic = onCaptureDiagnostic;
    this.onAudioFailure = onAudioFailure;
    this.onAudioStopped = onAudioStopped;
    this.clientProcessId = clientProcessId;
    this.state = undefined;
    this.disposed = false;
  }

  ensureHost() {
    if (this.disposed) throw new Error('obsCaptureHostDisposed');
    if (this.platform !== 'win32') throw new Error('platformUnsupported');
    if (this.state) {
      if (this.state.failed || this.state.shuttingDown) throw new Error('obsCaptureHostUnavailable');
      return this.state;
    }
    if (typeof this.configPath !== 'string' || !win32.isAbsolute(this.configPath)) throw new Error('invalidObsCaptureArguments');
    const args = [this.modulePath, this.dataPath, this.configPath];
    if (this.adapterIndex !== undefined) args.push(String(this.adapterIndex));
    const child = this.spawnProcess(this.executablePath, args,
      // 官方 libobs 按 bin/64bit 的相对路径查找 effect 文件，不能继承项目工作目录。
      { cwd: win32.dirname(this.executablePath), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const state = { child, alive: true, closed: false, videoSessionId: undefined, buffer: '', startTimer: undefined,
      startResolve: undefined, startReject: undefined, failureNotified: false, executablePath: this.executablePath,
      onFailure: this.onFailure, helperVersion: undefined,
      diagnosticSequence: 0, pendingDiagnostics: undefined, configurationSequence: 0, pendingConfiguration: undefined };
    state.closePromise = new Promise((resolve) => { state.resolveClose = resolve; });
    state.releaseSharedTextureSlot = (frameSessionId, slotIndex) => {
      if (!state.alive || state.closed || frameSessionId !== state.videoSessionId
          || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 3) {
        return Promise.reject(new Error('obsCaptureSlotReleaseUnavailable'));
      }
      return writeLine(child, `release:${frameSessionId}:${slotIndex}`);
    };
    this.state = state;

    state.corePromise = new Promise((resolve, reject) => {
      state.coreResolve = resolve;
      state.coreReject = reject;
      state.coreTimer = setTimeout(() => failState(state, new Error('obsCapturePrepareTimeout')), START_TIMEOUT_MS);
      state.coreTimer.unref?.();
    });
    // 后台预热和实际启动共用 Promise；失败仍传给等待者，避免未等待的准备产生未处理拒绝。
    void state.corePromise.catch(() => {});
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
    return state;
  }

  prepare(graphics = false) {
    if (this.state?.shutdownPromise) return this.state.shutdownPromise.then(() => this.prepare(graphics));
    let state;
    try { state = this.ensureHost(); } catch (error) { return Promise.reject(error); }
    clearTimeout(state.idleTimer);
    if (!graphics) return state.corePromise.then(() => this.scheduleIdle(state));
    if (!state.preparePromise) {
      state.preparePromise = new Promise((resolve, reject) => {
        state.prepareResolve = resolve;
        state.prepareReject = reject;
        state.prepareTimer = setTimeout(() => failState(state, new Error('obsCapturePrepareTimeout')), START_TIMEOUT_MS);
        state.prepareTimer.unref?.();
      });
      void state.corePromise.then(() => writeLine(state.child, 'prepare')).catch(error => failState(state, error));
    }
    return state.preparePromise.then(() => this.scheduleIdle(state));
  }

  scheduleIdle(state) {
    clearTimeout(state.idleTimer);
    if (this.state !== state || state.videoSessionId || state.shuttingDown || state.failed || state.closed) return;
    state.idleTimer = setTimeout(() => { void this.shutdown(false, 'idle').catch(error => this.onDiagnostic(error.message)); }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  async start(sourceId, maxFps, sessionId, target, settings, resolution = { width: 1920, height: 1080 }, rebuilding = false) {
    const windowMethod = settings?.windowMethod === undefined ? 'auto' : settings.windowMethod;
    if (typeof sourceId !== 'string' || !/^(monitor|window):[1-9]\d*:\d+$/.test(sourceId)
        || ![30, 60, 120].includes(maxFps) || !validTarget(target, sourceId) || !isSessionId(sessionId)
        || !validResolution(resolution) || !settings || typeof settings.hideCursor !== 'boolean' || typeof settings.hideBorder !== 'boolean'
        || !['auto', 'game', 'bitblt', 'wgc'].includes(windowMethod)
        || (target.kind === 'monitor' && windowMethod !== 'auto')
        || (target.kind === 'game' && !['auto', 'game'].includes(windowMethod))
        || (target.kind === 'window' && windowMethod === 'game')) {
      throw new Error('invalidObsCaptureArguments');
    }
    if (this.state?.videoSessionId) throw new Error('obsCaptureAlreadyRunning');
    if (this.state?.shutdownPromise) await this.state.shutdownPromise;
    const state = this.ensureHost();
    if (state.videoSessionId) throw new Error('obsCaptureAlreadyRunning');
    clearTimeout(state.idleTimer);
    state.videoSessionId = sessionId;
    state.stopRequested = false;
    state.failureNotified = false;
    state.startSent = false;
    state.maxFps = maxFps;
    state.resolution = { ...resolution };
    state.captureKind = target.kind;
    state.requestedMethod = windowMethod;
    state.borderAllowed = target.kind === 'window' && !settings.hideBorder;
    state.captureMethod = undefined;
    state.evidenceStages = new Set();
    state.stopPromise = undefined;
    const started = new Promise((resolve, reject) => {
      state.startResolve = resolve;
      state.startReject = reject;
      state.startTimer = setTimeout(() => failState(state, new Error('obsCaptureStartTimeout')), START_TIMEOUT_MS);
      state.startTimer.unref?.();
    });
    void state.corePromise.then(() => {
      if (state.stopRequested || state.closed || state.failed || state.videoSessionId !== sessionId) return;
      state.startSent = true;
      return writeLine(state.child, ['start', target.kind, target.kind === 'monitor' ? target.monitorName : target.windowId,
        settings.hideCursor ? '0' : '1', settings.hideBorder ? '1' : '0', sessionId, maxFps,
        target.kind !== 'monitor' ? target.lifetimeName : '', target.kind !== 'monitor' ? target.processId : '',
        resolution.width, resolution.height, state.requestedMethod,
        target.kind !== 'monitor' ? target.processCreationTime : ''].join('|'));
    }).catch(error => failState(state, error));
    const result = await started;
    if (result.adapterIndex === undefined) return result;
    // 预热显卡不能原地更换；只允许重建一次，并等待旧进程确实退出。
    await this.shutdown(false, 'adapterChange');
    if (state.stopPromise || state.stopRequested) throw new Error('obsCaptureStopping');
    if (rebuilding) throw new Error('dxgiAdapterMismatch');
    this.adapterIndex = result.adapterIndex;
    return this.start(sourceId, maxFps, sessionId, target, settings, resolution, true);
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
    if (event.event === 'coreReady') {
      clearTimeout(state.coreTimer);
      state.coreResolve?.();
      state.coreResolve = undefined;
      state.coreReject = undefined;
      return;
    }
    if (event.event === 'enginePrepared') {
      clearTimeout(state.prepareTimer);
      state.prepareResolve?.();
      state.prepareResolve = undefined;
      state.prepareReject = undefined;
      return;
    }
    if (event.event === 'captureStopped') {
      if (event.sessionId === state.videoSessionId && state.stopRequested) this.completeStop(state);
      return;
    }
    if (event.event === 'adapterRequired') {
      if (this.state !== state || state.captureKind !== 'monitor' || event.sessionId !== state.videoSessionId
          || !state.startResolve || state.stopRequested || !Number.isInteger(event.adapterIndex)
          || event.adapterIndex < 0 || event.adapterIndex >= 64) {
        failState(state, new Error('obsCaptureProtocolEventInvalid'));
        return;
      }
      clearTimeout(state.startTimer);
      state.startSent = false;
      this.onCaptureDiagnostic(state, { stage: 'obsAdapterRebuildRequired', adapterMatched: false,
        adapterIndex: event.adapterIndex, captureMethod: 'dxgi' });
      state.startResolve({ adapterIndex: event.adapterIndex });
      state.startResolve = undefined;
      state.startReject = undefined;
      return;
    }
    if (event.event === 'capturePreparation') {
      if (event.sessionId === state.lastStoppedSessionId && event.sessionId !== state.videoSessionId) return;
      if (this.state !== state || event.sessionId !== state.videoSessionId
          || !['graphicsStarting', 'graphicsReady', 'sourceStarting'].includes(event.stage)) {
        failState(state, new Error('obsCaptureProtocolEventInvalid'));
        return;
      }
      if (state.stopRequested || state.evidenceStages.has(event.stage)) return;
      state.evidenceStages.add(event.stage);
      this.onCaptureDiagnostic(state, { stage: { graphicsStarting: 'obsGraphicsStarting', graphicsReady: 'obsGraphicsReady',
        sourceStarting: 'obsSourceStarting' }[event.stage] });
      return;
    }
    if (event.event === 'captureEvidence') {
      if (event.sessionId === state.lastStoppedSessionId && event.sessionId !== state.videoSessionId) return;
      const method = event.captureMethod;
      const expectedMethods = state.captureKind === 'monitor' ? ['dxgi'] : state.captureKind === 'game' ? ['game']
        : state.requestedMethod === 'bitblt' ? ['bitblt-window'] : state.requestedMethod === 'wgc' ? ['wgc-window']
          : ['bitblt-window', 'wgc-window'];
      if (this.state !== state || event.sessionId !== state.videoSessionId
          || !['configured', 'rendering', 'sourceReady', 'gpuDelayed'].includes(event.stage) || !expectedMethods.includes(method)
          || (state.captureMethod && state.captureMethod !== method)
          || (state.captureKind === 'window' && (event.requestedMethod !== state.requestedMethod
            || event.borderAllowed !== state.borderAllowed || event.clientArea !== true))
          || (event.windowFallbackReason !== undefined && (state.captureKind !== 'window'
            || state.requestedMethod !== 'auto' || method !== 'bitblt-window'
            || !['captureSettingsUnsupported', 'captureBorderAccessDenied', 'obsWindowRuntimeUnavailable'].includes(event.windowFallbackReason)))
          || !Number.isInteger(event.adapterIndex) || event.adapterIndex < 0 || event.adapterIndex >= 64
          || ![event.sourceWidth, event.sourceHeight].every(value => Number.isInteger(value) && value >= 0 && value <= 32768)
          || (event.captureApi !== undefined && (method !== 'dxgi' || !['DuplicateOutput1', 'DuplicateOutput'].includes(event.captureApi)))
          || (method === 'dxgi' && event.adapterMatched !== true)) {
        failState(state, new Error('obsCaptureProtocolEventInvalid'));
        return;
      }
      if (state.stopRequested || state.evidenceStages.has(event.stage)) return;
      state.captureMethod = method;
      state.evidenceStages.add(event.stage);
      this.onCaptureDiagnostic(state, { stage: { configured: 'obsCaptureConfigured', rendering: 'obsRenderObserved',
        sourceReady: 'obsSourceReady', gpuDelayed: 'obsGpuFrameDeferred' }[event.stage], captureMethod: method, adapterIndex: event.adapterIndex,
        sourceWidth: event.sourceWidth, sourceHeight: event.sourceHeight,
        ...(event.captureApi ? { captureApi: event.captureApi } : {}),
        ...(state.captureKind === 'window' ? { requestedMethod: event.requestedMethod,
          borderAllowed: event.borderAllowed, clientArea: true,
          ...(event.windowFallbackReason ? { windowFallbackReason: event.windowFallbackReason } : {}) } : {}),
        ...(method === 'dxgi' ? { adapterMatched: true } : {}) });
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
      if (this.state !== state || state.closed || state.stopRequested || !state.startResolve
          || event.sessionId !== state.videoSessionId) return;
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
      if (event.sessionId === state.lastStoppedSessionId && event.sessionId !== state.videoSessionId) return;
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
      if (event.sessionId === state.lastStoppedSessionId && event.sessionId !== state.videoSessionId) return;
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
      // 统计格式错误只结束本次读取，不让诊断功能中断仍可用的共享。
      if (!validObsRender(event.obsRender)) {
        request.finish(new Error('obsRenderDiagnosticsInvalid'));
        return;
      }
      request.finish(undefined, { helperVersion: state.helperVersion, renderedFrames: event.renderedFrames,
        bridgeFrames: event.bridgeFrames, bridgeDroppedFrames: event.bridgeDroppedFrames, screenShareAudio: event.screenShareAudio,
        obsRender: { configuration: event.obsRender.configuration, elapsedMs: event.obsRender.elapsedMs,
          totalFrames: event.obsRender.totalFrames, laggedFrames: event.obsRender.laggedFrames,
          activeFps: event.obsRender.activeFps, averageRenderMs: event.obsRender.averageRenderMs } });
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
    if (event.event === 'captureTargetClosed' && state.helperVersion && !state.startReject) {
      if (event.sessionId === state.lastStoppedSessionId && event.sessionId !== state.videoSessionId) return;
      if (event.sessionId !== state.videoSessionId) { failState(state, new Error('obsCaptureProtocolEventInvalid')); return; }
      if (state.stopRequested) return;
      const sessionId = state.videoSessionId;
      // 目标退出仍走已确认的停止清理；不标记宿主故障或提前杀掉进程。
      if (!state.failureNotified) {
        state.failureNotified = true;
        state.onFailure?.(state, new Error('captureTargetClosed'));
      }
      void this.stop(sessionId).catch(error => failState(state, error));
      return;
    }
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
        || state.videoSessionId !== sessionId || !state.helperVersion || ![30, 60, 120].includes(maxFps) || !validResolution(resolution)) {
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
    if (!state.videoSessionId && state.lastStoppedSessionId === sessionId) return { changed: false };
    if (state.videoSessionId !== sessionId) throw new Error('videoSessionMismatch');
    if (state.closed) {
      if (this.state === state) this.state = undefined;
      return { changed: true };
    }
    if (state.stopPromise) return state.stopPromise;
    state.stopRequested = true;
    clearTimeout(state.startTimer);
    state.startReject?.(new Error('obsCaptureStopping'));
    state.startResolve = undefined;
    state.startReject = undefined;
    if (state.audio) {
      state.audio.stopping = true;
      state.audio.finishStart?.(new Error('obsCaptureStopping'));
    }
    state.pendingDiagnostics?.finish(new Error('obsCaptureStopping'));
    state.pendingConfiguration?.finish(new Error('obsCaptureStopping'));
    const startSent = state.startSent;
    state.captureStopPromise = new Promise(resolve => { state.captureStopResolve = resolve; });
    state.stopPromise = (async () => {
      if (!startSent) this.completeStop(state);
      else {
        void writeLine(state.child, `stop:${sessionId}`).catch(() => {});
        let timer;
        await Promise.race([state.captureStopPromise, state.closePromise, new Promise(resolve => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
          timer.unref?.();
        })]).finally(() => clearTimeout(timer));
        // 停止未确认就退出整个宿主；进程也未退出时保留阻挡，不能复用未知资源。
        if (!state.closed && state.videoSessionId === sessionId) await this.shutdown(true, 'stopTimeout');
      }
      return { changed: true };
    })();
    return state.stopPromise;
  }

  completeStop(state) {
    state.audio?.finishStart?.(new Error('obsCaptureStopping'));
    state.audio?.finishStop?.(undefined, { changed: true });
    this.onAudioStopped(state);
    state.audio = undefined;
    state.lastStoppedSessionId = state.videoSessionId;
    this.onCaptureDiagnostic(state, { stage: 'obsCaptureStopped', stopMode: state.startSent ? 'graceful' : 'beforeStart' });
    state.videoSessionId = undefined;
    state.stopRequested = false;
    state.captureStopResolve?.();
    state.captureStopResolve = undefined;
    this.scheduleIdle(state);
  }

  shutdown(force = false, reason = 'shutdown') {
    const state = this.state;
    if (!state || state.closed) return Promise.resolve();
    if (state.shutdownPromise) return state.shutdownPromise;
    state.shuttingDown = true;
    state.shutdownReason = reason;
    clearTimeout(state.idleTimer);
    state.shutdownPromise = (async () => {
      void writeLine(state.child, 'shutdown').catch(() => {});
      if (!force) await waitForClose(state, SHUTDOWN_TIMEOUT_MS);
      if (!state.closed) {
        state.forceTerminated = true;
        state.child.kill();
        await waitForClose(state, TERMINATE_TIMEOUT_MS);
      }
      if (!state.closed) throw new Error('obsCaptureStopUnconfirmed');
    })();
    return state.shutdownPromise;
  }

  dispose() {
    this.disposed = true;
    return this.shutdown();
  }

  closeState(state, error) {
    if (state.closed) return;
    state.alive = false;
    state.closed = true;
    state.audio?.finishStart?.(error ?? new Error('obsCaptureHostClosed'));
    state.audio?.finishStop?.(undefined, { changed: true });
    state.audio = undefined;
    clearTimeout(state.startTimer);
    clearTimeout(state.coreTimer);
    clearTimeout(state.prepareTimer);
    clearTimeout(state.idleTimer);
    state.coreReject?.(error ?? new Error('obsCaptureHostClosed'));
    state.prepareReject?.(error ?? new Error('obsCaptureHostClosed'));
    state.captureStopResolve?.();
    state.pendingDiagnostics?.finish(error ?? new Error('obsCaptureHostClosed'));
    state.pendingConfiguration?.finish(error ?? new Error('obsCaptureHostClosed'));
    const closeError = error ?? (!state.stopRequested && !state.shuttingDown ? new Error('obsCaptureHostClosedUnexpectedly') : undefined);
    if (closeError && state.shutdownReason !== 'adapterChange') failState(state, closeError, false);
    state.startReject?.(closeError ?? new Error('obsCaptureHostClosedBeforeStart'));
    state.startResolve = undefined;
    state.startReject = undefined;
    if (this.state === state) this.state = undefined;
    this.onCaptureDiagnostic(state, { stage: 'obsHostExited',
      stopMode: state.forceTerminated ? 'forced' : state.shuttingDown && !error ? 'graceful' : 'unexpected',
      stopReason: state.shutdownReason ?? 'failure' });
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
    && BigInt(target.windowId) <= 0xffffffffffffffffn
    && Number.isInteger(target.processId) && target.processId > 0 && target.processId <= 0xffffffff
    && typeof target.processCreationTime === 'string' && /^[1-9]\d{0,19}$/.test(target.processCreationTime)
    && BigInt(target.processCreationTime) <= 0xffffffffffffffffn
    && typeof target.lifetimeName === 'string' && target.lifetimeName.length <= 128
    && /^Local\\LycanSync\.WindowLifetime\.[1-9]\d*\.[1-9]\d*\.[1-9]\d*\.[1-9]\d*$/.test(target.lifetimeName)
    && target.lifetimeName.endsWith(`.${target.windowId}`);
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

function validObsRender(render) {
  return render && Number.isSafeInteger(render.configuration) && render.configuration > 0
    && Number.isSafeInteger(render.elapsedMs) && render.elapsedMs >= 0
    && [render.totalFrames, render.laggedFrames].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    && render.laggedFrames <= render.totalFrames
    && ((render.activeFps === null && render.averageRenderMs === null)
      || (render.elapsedMs >= 2000 && Number.isFinite(render.activeFps) && render.activeFps >= 0 && render.activeFps <= 1000
        && Number.isFinite(render.averageRenderMs) && render.averageRenderMs >= 0));
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
  return size && [720, 1080, 1440].includes(size.height) && size.width === size.height * 16 / 9;
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
  if (state.closed && kill) return;
  state.failed = true;
  clearTimeout(state.coreTimer);
  clearTimeout(state.prepareTimer);
  clearTimeout(state.idleTimer);
  state.coreReject?.(error);
  state.prepareReject?.(error);
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
  if (kill && state.alive && !state.closed) {
    state.forceTerminated = true;
    state.shutdownReason ??= 'failure';
    state.child.kill();
  }
}

module.exports = { ObsCaptureHostManager };

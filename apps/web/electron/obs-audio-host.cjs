const { spawn } = require('node:child_process');
const { win32 } = require('node:path');

const ERROR_CODES = new Set(['obsAudioInitFailed', 'obsCaptureVersionUnsupported', 'microphoneModuleLoadFailed',
  'microphoneCaptureStartFailed', 'microphoneProcessingFailed', 'microphoneCapturePipeFailed',
  'microphoneCaptureStartTimedOut', 'microphoneCaptureFailed', 'microphoneDeviceUnavailable', 'invalidMicrophoneCommand']);
function validSettings(settings) {
  return settings && Number.isFinite(settings.inputGain) && settings.inputGain >= 0 && settings.inputGain <= 2
    && ['noiseSuppression', 'autoGainControl', 'voiceEnhancement'].every(key => typeof settings[key] === 'boolean');
}
function settingsCommand(settings) {
  return `${settings.inputGain}|${Number(settings.noiseSuppression)}${Number(settings.autoGainControl)}${Number(settings.voiceEnhancement)}`;
}

// 麦克风拥有独立 OBS 进程，视频预热、换显卡与共享故障不得撤销它。
class ObsAudioHostManager {
  constructor({ executablePath, modulePath, dataPath, configPath, platform = process.platform, spawnProcess = spawn,
    startTimeoutMs = 12_000, stopTimeoutMs = 4000, killTimeoutMs = 1500, requestTimeoutMs = 3000,
    onFailure = () => {}, onDiagnostic = () => {} }) {
    Object.assign(this, { executablePath, modulePath, dataPath, configPath, platform, spawnProcess,
      startTimeoutMs, stopTimeoutMs, killTimeoutMs, requestTimeoutMs, onFailure, onDiagnostic });
    this.state = undefined;
    this.disposed = false;
    this.lastStopped = undefined;
  }

  start(pipeId, sessionId, settings, deviceId = 'default', pushToTalk = false) {
    if (this.disposed) return Promise.reject(new Error('obsAudioHostDisposed'));
    if (this.platform !== 'win32') return Promise.reject(new Error('platformUnsupported'));
    if (typeof pipeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pipeId)
        || typeof sessionId !== 'string' || !sessionId || Buffer.byteLength(sessionId) > 128 || /[\u0000-\u001f\u007f]/.test(sessionId)
        || typeof deviceId !== 'string' || !deviceId || deviceId.length > 1024 || /[\u0000-\u001f\u007f]/.test(deviceId)
        || typeof pushToTalk !== 'boolean'
        || !validSettings(settings) || !win32.isAbsolute(this.configPath)) {
      return Promise.reject(new Error('invalidMicrophoneCaptureStart'));
    }
    if (this.state) return this.state.sessionId === sessionId && !this.state.stopping
      ? this.state.start : Promise.reject(new Error('microphoneCaptureAlreadyRunning'));
    let child;
    try {
      child = this.spawnProcess(this.executablePath, [this.modulePath, this.dataPath, this.configPath,
        pipeId, settingsCommand(settings), deviceId, pushToTalk ? '1' : '0'], { cwd: win32.dirname(this.executablePath), windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return Promise.reject(new Error('microphoneCaptureStartFailed')); }
    const state = { child, sessionId, alive: true, buffer: '', requests: new Map(), sequence: 0,
      ready: false, stopped: false, pushToTalk, startedAt: performance.now() };
    this.state = state;
    state.start = new Promise((resolve, reject) => { state.resolveStart = resolve; state.rejectStart = reject; });
    void state.start.catch(() => {});
    state.closed = new Promise(resolve => { state.resolveClose = resolve; });
    state.startTimer = setTimeout(() => this.fail(state, 'microphoneCaptureStartTimedOut'), this.startTimeoutMs);
    state.startTimer.unref?.();
    child.stdout.on('data', chunk => this.read(state, chunk));
    // 原始 WASAPI 日志可能包含设备 ID，宿主不转发原文。
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail(state, 'microphoneCapturePipeFailed'));
    child.once('error', () => {
      this.fail(state, 'microphoneCaptureStartFailed');
      if (!child.pid) this.close(state, 1);
    });
    child.once('close', code => this.close(state, code));
    return state.start;
  }

  read(state, chunk) {
    if (!state.alive || state.failed) return;
    state.buffer += String(chunk);
    if (Buffer.byteLength(state.buffer) > 8192) { this.fail(state, 'obsAudioProtocolInvalid'); return; }
    for (let end = state.buffer.indexOf('\n'); end >= 0; end = state.buffer.indexOf('\n')) {
      const line = state.buffer.slice(0, end); state.buffer = state.buffer.slice(end + 1);
      let event;
      try { event = JSON.parse(line); } catch { this.fail(state, 'obsAudioProtocolInvalid'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { this.fail(state, 'obsAudioProtocolInvalid'); return; }
      if (event.event === 'ready' && !state.ready && !state.stopping
          && event.obsVersion === '32.2.2' && event.processing === 'sonora-0.2.0'
          && event.sampleRate === 48000 && event.channels === 1 && event.bitsPerSample === 32 && event.nominalChunkMs === 10) {
        state.ready = true;
        clearTimeout(state.startTimer);
        state.resolveStart({ sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
        const timing = {};
        for (const key of ['coreReadyMs', 'pluginLoadMs', 'sourceSetupMs', 'firstBlockWaitMs']) {
          if (Number.isInteger(event[key]) && event[key] >= 0 && event[key] <= this.startTimeoutMs) timing[key] = event[key];
        }
        this.onDiagnostic({ stage: 'microphoneReady', backend: 'obsLibobs', processing: 'sonora-0.2.0',
          durationMs: Math.round(performance.now() - state.startedAt), ...timing });
      } else if (event.event === 'configured' && state.requests.get(event.requestId)?.kind === 'configure') {
        const request = state.requests.get(event.requestId);
        clearTimeout(request.timer); state.requests.delete(event.requestId); request.resolve({ changed: true });
      } else if (event.event === 'statistics' && state.requests.get(event.requestId)?.kind === 'statistics'
          && [event.framesReceived, event.droppedChunks, event.sourceFrames].every(value => Number.isSafeInteger(value) && value >= 0)
          && [0, 1, 2].includes(event.sourceState) && typeof event.pushToTalk === 'boolean' && typeof event.transmissionAllowed === 'boolean') {
        const request = state.requests.get(event.requestId);
        clearTimeout(request.timer); state.requests.delete(event.requestId);
        request.resolve({ framesReceived: event.framesReceived, droppedChunks: event.droppedChunks,
          sourceState: event.sourceState, sourceFrames: event.sourceFrames,
          pushToTalk: event.pushToTalk, transmissionAllowed: event.transmissionAllowed });
      } else if (event.event === 'statistics' && Number.isSafeInteger(event.requestId)
          && event.requestId > 0 && event.requestId <= state.sequence && !state.requests.has(event.requestId)) {
        // 诊断超时的迟到响应不改变采集状态。
      } else if (event.event === 'stopped' && state.stopping && !state.stopped) state.stopped = true;
      else if (event.event === 'failed' && ERROR_CODES.has(event.code)) {
        const pipeFailure = {};
        if (event.code === 'microphoneCapturePipeFailed'
            && ['samples', 'open', 'completionEvent', 'write', 'writeWait', 'writeResult', 'shortWrite'].includes(event.pipePhase)) {
          pipeFailure.pipePhase = event.pipePhase;
          if (Number.isInteger(event.win32Error) && event.win32Error > 0 && event.win32Error <= 0xffffffff) {
            pipeFailure.win32Error = event.win32Error;
          }
        }
        this.onDiagnostic({ stage: 'microphoneSourceFailed', code: event.code, ...pipeFailure,
          ...(typeof event.hresult === 'string' && /^0x[0-9a-fA-F]{8}$/.test(event.hresult) ? { message: event.hresult } : {}) });
        this.fail(state, event.code);
      } else if (!state.stopping) this.fail(state, 'obsAudioProtocolInvalid');
    }
  }

  request(sessionId, kind, command) {
    const state = this.state;
    if (!state || state.sessionId !== sessionId || !state.ready || state.stopping || state.failed) {
      return Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    }
    if (state.requests.size >= 8) return Promise.reject(new Error('microphoneRequestBusy'));
    return new Promise((resolve, reject) => {
      const id = ++state.sequence;
      const timer = setTimeout(() => {
        state.requests.delete(id); reject(new Error('microphoneRequestTimedOut'));
        if (kind === 'configure') this.fail(state, 'microphoneRequestTimedOut');
      }, this.requestTimeoutMs);
      timer.unref?.();
      state.requests.set(id, { resolve, reject, timer, kind });
      state.child.stdin.write(command(id) + '\n', error => { if (error) this.fail(state, 'microphoneCapturePipeFailed'); });
    });
  }

  configure(sessionId, settings) {
    if (!validSettings(settings)) return Promise.reject(new Error('invalidMicrophoneCaptureSettings'));
    return this.request(sessionId, 'configure', id => `configure|${id}|${settingsCommand(settings)}`);
  }

  getDiagnostics(sessionId) { return this.request(sessionId, 'statistics', id => `statistics|${id}`); }

  setTransmission(sessionId, pushToTalk, held, epoch) {
    const state = this.state;
    if (!state || state.sessionId !== sessionId || !state.ready || state.stopping || state.failed) return;
    if (typeof pushToTalk !== 'boolean' || typeof held !== 'boolean' || !Number.isSafeInteger(epoch)
        || epoch < 0 || epoch > 0xffffffff) throw new Error('invalidMicrophoneTransmission');
    const mode = state.pushToTalk !== pushToTalk ? `mode|${Number(pushToTalk)}\n` : '';
    state.pushToTalk = pushToTalk;
    state.transmissionEpoch = epoch;
    state.child.stdin.write(`${mode}transmit|${epoch}|${held && pushToTalk ? 350 : 0}\n`, error => {
      if (error) this.fail(state, 'microphoneCapturePipeFailed');
    });
  }

  cancelTransmission(sessionId) {
    if (this.state?.pushToTalk) this.setTransmission(sessionId, true, false, this.state.transmissionEpoch ?? 0);
  }

  fail(state, code) {
    if (!state.alive || state.failed) return;
    state.failed = code;
    clearTimeout(state.startTimer);
    state.rejectStart(new Error(code));
    this.rejectRequests(state, code);
    if (state.ready && !state.stopping) this.onFailure(state.sessionId, code);
    // 停止结果由同一份 stop Promise 记录，主进程同步请求清理时不重复报错。
    void this.stop(state.sessionId).catch(() => {});
  }

  rejectRequests(state, code) {
    for (const request of state.requests.values()) { clearTimeout(request.timer); request.reject(new Error(code)); }
    state.requests.clear();
  }

  close(state, code) {
    if (!state.alive) return;
    const expected = state.stopping && state.stopped && code === 0;
    state.alive = false;
    clearTimeout(state.startTimer); clearTimeout(state.stopTimer); clearTimeout(state.killTimer);
    state.rejectStart(new Error(state.failed || 'microphoneCaptureSessionStopped'));
    this.rejectRequests(state, 'microphoneCaptureSessionStopped');
    if (this.state === state) this.state = undefined;
    this.lastStopped = state.sessionId;
    state.resolveClose(expected);
    this.onDiagnostic({ stage: 'microphoneHostExited', stopMode: expected ? 'graceful' : state.killed ? 'forced' : 'unexpected',
      ...(Number.isInteger(code) ? { exitCode: code } : {}),
      ...(state.stopStartedAt !== undefined ? { durationMs: Math.round(performance.now() - state.stopStartedAt) } : {}) });
    if (!expected && !state.stopping && !state.failed) this.onFailure(state.sessionId, 'microphoneCaptureFailed');
  }

  stop(sessionId) {
    const state = this.state;
    if (!state) return this.lastStopped === sessionId
      ? Promise.resolve({ changed: false }) : Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    if (state.sessionId !== sessionId) return Promise.reject(new Error('microphoneCaptureSessionMismatch'));
    if (state.stop) return state.stop;
    state.stopping = true;
    state.stopStartedAt = performance.now();
    clearTimeout(state.startTimer);
    state.rejectStart(new Error('microphoneCaptureSessionStopped'));
    this.rejectRequests(state, 'microphoneCaptureSessionStopped');
    state.stop = state.closed.then(expected => {
      if (!expected) {
        this.onDiagnostic({ stage: 'microphoneStopFailed', code: 'microphoneCaptureStopFailed' });
        throw new Error('microphoneCaptureStopFailed');
      }
      return { changed: true };
    });
    state.child.stdin.write('stop\n', () => {});
    state.stopTimer = setTimeout(() => {
      if (!state.alive) return;
      state.killed = true;
      state.child.kill();
      state.killTimer = setTimeout(() => {
        if (!state.alive) return;
        // 未确认退出仍保留 state，下一次启动不能叠加进程。
        state.resolveClose(false);
      }, this.killTimeoutMs);
      state.killTimer.unref?.();
    }, this.stopTimeoutMs);
    state.stopTimer.unref?.();
    return state.stop;
  }

  async dispose() {
    this.disposed = true;
    if (this.state) await this.stop(this.state.sessionId);
  }
}

module.exports = { ObsAudioHostManager };

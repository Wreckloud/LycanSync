const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');

const { validNativeAudioSessionId } = require('./native-audio-session.cjs');
const LOOP_SAMPLE_MS = 250;

function microphoneDelivery(audio, now = performance.now()) {
  const overdue = Math.max(0, Math.round(now - audio.loopTick - LOOP_SAMPLE_MS));
  const pendingStall = overdue >= 100;
  return {
    pipeReadPackets: audio.pipeReadPackets,
    lastPipeReadAgeMs: audio.lastRead === null ? null : Math.round(now - audio.lastRead),
    maxPipeReadGapMs: audio.maxReadGap,
    lastMainStallMs: pendingStall ? overdue : audio.lastStallMs,
    lastMainStallAgeMs: pendingStall ? 0 : audio.lastStallAt === null ? null : Math.round(now - audio.lastStallAt),
    hostDroppedChunks: audio.hostDroppedChunks,
    hostDropSampleAgeMs: audio.hostSampleAt === null ? null : Math.round(now - audio.hostSampleAt),
    mainDroppedChunks: audio.droppedChunks, rendererDroppedChunks: audio.rendererDroppedChunks,
    workletDroppedChunks: audio.workletDroppedChunks, queuedChunks: audio.queue.length,
  };
}

function validMicrophoneSettings(settings) {
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    && Object.keys(settings).length === 5
    && typeof settings.inputGain === 'number' && Number.isFinite(settings.inputGain)
    && settings.inputGain >= 0 && settings.inputGain <= 2
    && typeof settings.noiseSuppression === 'boolean'
    && typeof settings.autoGainControl === 'boolean'
    && typeof settings.voiceEnhancement === 'boolean'
    && typeof settings.echoCancellation === 'boolean';
}

// OBS 宿主持有采集进程；本模块独占页面音频管道、交付队列和该会话的停止状态。
function createNativeMicrophone({ host: obsAudioHost, getWindow, isClosing, writeDiagnostic: writeMediaDiagnostic,
  platform = process.platform, createPipeServer = createServer }) {
  let nativeMicrophoneSession;
  let lastMicrophoneDroppedChunks = 0;
  function finishNativeMicrophonePipe(audio, { destroy = false } = {}) {
    if (!audio) return;
    clearInterval(audio.loopTimer);
    audio.stopping = true;
    audio.queue.length = 0;
    audio.inFlight = undefined;
    audio.buffer = Buffer.alloc(0);
    if (audio.socket && !audio.socket.destroyed) {
      if (destroy) audio.socket.destroy(); else audio.socket.end();
    }
    if (audio.server.listening) audio.server.close();
  }

  function handleNativeMicrophonePipeData(audio, incoming) {
    if (nativeMicrophoneSession !== audio || audio.stopping) return;
    const now = performance.now();
    const gap = audio.lastRead === null ? null : Math.round(now - audio.lastRead);
    if (gap !== null) audio.maxReadGap = Math.max(audio.maxReadGap ?? 0, gap);
    if (gap >= 500) void writeMediaDiagnostic({ stage: 'microphonePipeReadResumed', ...microphoneDelivery(audio, now) });
    audio.lastRead = now;
    audio.buffer = audio.buffer.length ? Buffer.concat([audio.buffer, incoming]) : incoming;
    while (audio.buffer.length >= 8) {
      const frames = audio.buffer.readUInt32LE(0);
      const transmissionEpoch = audio.buffer.readUInt32LE(4);
      if (frames !== 480) {
        notifyNativeMicrophoneError(audio, 'microphoneCaptureInvalidPacket');
        return;
      }
      const packetBytes = 8 + frames * 4;
      if (audio.buffer.length < packetBytes) break;
      audio.pipeReadPackets++;
      const pcm = Uint8Array.from(audio.buffer.subarray(8, packetBytes));
      audio.buffer = audio.buffer.subarray(packetBytes);
      if (audio.queue.length === 12) {
        audio.queue.shift();
        audio.droppedChunks++;
      }
      audio.queue.push({ frames, pcm, transmissionEpoch });
    }
    if (audio.buffer.length > 65_536) {
      notifyNativeMicrophoneError(audio, 'microphoneCaptureBufferOverflow');
      return;
    }
    sendNextNativeMicrophoneChunk(audio);
  }

  function sendNextNativeMicrophoneChunk(audio) {
    const mainWindow = getWindow();
    if (nativeMicrophoneSession !== audio || audio.stopping || audio.inFlight || !audio.queue.length
        || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const sequence = ++audio.sequence;
    const packet = audio.queue.shift();
    audio.inFlight = sequence;
    mainWindow.webContents.send('media:native-microphone-frame', {
      sessionId: audio.sessionId, sequence, frames: packet.frames, sampleRate: 48_000, channels: 1, pcm: packet.pcm, transmissionEpoch: packet.transmissionEpoch,
    });
  }

  function acknowledgeNativeMicrophoneChunk(sessionId, sequence, droppedChunks, workletDropped = 0) {
    if (!validNativeAudioSessionId(sessionId) || !Number.isSafeInteger(sequence)
        || !Number.isSafeInteger(droppedChunks) || droppedChunks < 0
        || !Number.isSafeInteger(workletDropped) || workletDropped < 0) return;
    const audio = nativeMicrophoneSession;
    if (!audio || audio.sessionId !== sessionId || audio.inFlight !== sequence) return;
    audio.rendererDroppedChunks = Math.max(audio.rendererDroppedChunks, droppedChunks);
    audio.workletDroppedChunks = Math.max(audio.workletDroppedChunks, workletDropped);
    audio.inFlight = undefined;
    sendNextNativeMicrophoneChunk(audio);
  }

  function notifyNativeMicrophoneError(audio, code) {
    if (!audio || nativeMicrophoneSession !== audio || audio.failureNotified || audio.stopping) return;
    audio.failureNotified = true;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'microphoneCaptureFailed';
    void writeMediaDiagnostic({ stage: 'microphoneCaptureFailed', code: safeCode, ...microphoneDelivery(audio) });
    finishNativeMicrophonePipe(audio, { destroy: true });
    const mainWindow = getWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('media:native-microphone-error', { sessionId: audio.sessionId, code: safeCode });
    }
    // 宿主管理器记录停止失败；错误通知与主动停止使用同一结果，不能提前清除会话身份。
    void stopNativeMicrophoneCapture(audio.sessionId).catch(() => {});
  }

  async function startNativeMicrophoneCapture(sessionId, settings, deviceId, pushToTalk) {
    if (isClosing() || platform !== 'win32') throw new Error('platformUnsupported');
    if (!validNativeAudioSessionId(sessionId) || !validMicrophoneSettings(settings)) {
      throw new Error('invalidMicrophoneCaptureStart');
    }
    if (nativeMicrophoneSession) {
      if (nativeMicrophoneSession.sessionId === sessionId && !nativeMicrophoneSession.stopping) {
        return nativeMicrophoneSession.startPromise;
      }
      throw new Error('microphoneCaptureAlreadyRunning');
    }
    lastMicrophoneDroppedChunks = 0;
    const pipeId = randomUUID();
    const server = createPipeServer();
    const audio = {
      sessionId, pipeId, server, socket: undefined, buffer: Buffer.alloc(0), queue: [],
      inFlight: undefined, sequence: 0, droppedChunks: 0, rendererDroppedChunks: 0,
      stopping: false, failureNotified: false, hostDroppedChunks: null, hostStarted: false,
      hostSampleAt: null, pipeReadPackets: 0, lastRead: null, maxReadGap: null, workletDroppedChunks: 0,
      loopTick: performance.now(), lastStallMs: null, lastStallAt: null,
    };
    // 单调时钟用来区分主进程调度停顿与单独的管道断流；只在本次采集期间采样。
    audio.loopTimer = setInterval(() => {
      const now = performance.now();
      const late = Math.round(now - audio.loopTick - LOOP_SAMPLE_MS);
      audio.loopTick = now;
      if (late >= 100) { audio.lastStallMs = late; audio.lastStallAt = now; }
    }, LOOP_SAMPLE_MS);
    audio.loopTimer.unref();
    nativeMicrophoneSession = audio;
    server.on('connection', (socket) => {
      if (nativeMicrophoneSession !== audio || audio.stopping || audio.socket) { socket.destroy(); return; }
      audio.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => handleNativeMicrophonePipeData(audio, chunk));
      socket.once('error', () => notifyNativeMicrophoneError(audio, 'microphoneCapturePipeFailed'));
      socket.once('close', () => {
        if (nativeMicrophoneSession === audio && !audio.stopping) {
          notifyNativeMicrophoneError(audio, 'microphoneCapturePipeClosed');
        }
      });
    });
    server.on('error', () => notifyNativeMicrophoneError(audio, 'microphoneCapturePipeFailed'));
    audio.startPromise = (async () => {
      try {
        await new Promise((resolveListen, rejectListen) => {
          const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
          const onListening = () => { server.removeListener('error', onError); resolveListen(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(`\\\\.\\pipe\\lycansync-microphone-audio-${pipeId}`);
        });
        if (nativeMicrophoneSession !== audio || audio.stopping) throw new Error('microphoneCaptureSessionStopped');
        audio.hostStarted = true;
        const format = await obsAudioHost.start(pipeId, sessionId, settings, deviceId, pushToTalk);
        if (nativeMicrophoneSession !== audio || audio.stopping) throw new Error('microphoneCaptureSessionStopped');
        return format;
      } catch (error) {
        finishNativeMicrophonePipe(audio, { destroy: true });
        if (nativeMicrophoneSession === audio) {
          if (audio.hostStarted) {
            try { await stopNativeMicrophoneCapture(sessionId); }
            catch (stopError) {
              // 参数校验或创建进程之前失败时，宿主没有接管这个会话。
              if (stopError.message === 'microphoneCaptureSessionMismatch' && nativeMicrophoneSession === audio) {
                nativeMicrophoneSession = undefined;
              }
            }
          } else nativeMicrophoneSession = undefined;
        }
        if (error.message !== 'microphoneCaptureSessionStopped') {
          const code = /^[a-z][A-Za-z0-9]{0,63}$/.test(error.message) ? error.message : 'microphoneCaptureStartFailed';
          void writeMediaDiagnostic({ stage: 'microphoneStartFailed', code });
        }
        throw error;
      }
    })();
    return audio.startPromise;
  }

  async function stopNativeMicrophoneCapture(sessionId) {
    const audio = nativeMicrophoneSession;
    if (!audio) return { changed: false };
    if (audio.sessionId !== sessionId) throw new Error('microphoneCaptureSessionMismatch');
    if (audio.stopPromise) return audio.stopPromise;
    audio.stopPromise = (async () => {
      // 立即撤销页面交付，但保持管道排空至宿主停止，避免正常停止被误报为写管道故障。
      audio.stopping = true;
      clearInterval(audio.loopTimer);
      audio.queue.length = 0;
      try { return audio.hostStarted ? await obsAudioHost.stop(sessionId) : { changed: false }; }
      finally { finishNativeMicrophonePipe(audio, { destroy: true }); }
    })().then(result => {
      lastMicrophoneDroppedChunks = audio.hostDroppedChunks === null ? null
        : audio.hostDroppedChunks + audio.droppedChunks + audio.rendererDroppedChunks + audio.workletDroppedChunks;
      if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
      return result;
    }).catch(error => {
      // 停止失败仍占用会话；允许之后核对迟到的宿主退出，但不把重试当作已经成功。
      audio.stopPromise = undefined;
      throw error;
    });
    return audio.stopPromise;
  }

  async function diagnostics() {
    const diagnostics = {};
    const microphone = nativeMicrophoneSession;
    let microphoneDrops = null;
    diagnostics.microphoneCapture = null;
    if (microphone && !microphone.stopping) {
      try {
        const capture = await obsAudioHost.getDiagnostics(microphone.sessionId);
        microphoneDrops = capture.droppedChunks;
        if (nativeMicrophoneSession === microphone && !microphone.stopping) {
          diagnostics.microphoneCapture = { sourceState: capture.sourceState, sourceFrames: capture.sourceFrames,
            framesReceived: capture.framesReceived, pushToTalk: capture.pushToTalk, transmissionAllowed: capture.transmissionAllowed,
            processingMetrics: capture.processingMetrics, echoMetrics: capture.echoMetrics };
        }
        microphone.hostDroppedChunks = microphoneDrops;
        microphone.hostSampleAt = performance.now();
      } catch { /* 可选统计缺失不终止语音；报告保留未知值。 */ }
      if (nativeMicrophoneSession !== microphone) microphoneDrops = null;
    }
    diagnostics.microphoneCaptureDroppedChunks = microphone
      ? microphoneDrops === null ? null : microphoneDrops + microphone.droppedChunks + microphone.rendererDroppedChunks + microphone.workletDroppedChunks
      : lastMicrophoneDroppedChunks;
    if (microphone && nativeMicrophoneSession === microphone && !microphone.stopping) {
      diagnostics.microphoneDelivery = microphoneDelivery(microphone);
    }
    return diagnostics;
  }

  function notifyFailure(sessionId, code) {
    if (nativeMicrophoneSession?.sessionId === sessionId) notifyNativeMicrophoneError(nativeMicrophoneSession, code);
  }

  function setTransmission(sessionId, pushToTalk, held, epoch) {
    if (nativeMicrophoneSession?.sessionId === sessionId && !nativeMicrophoneSession.stopping) {
      obsAudioHost.setTransmission(sessionId, pushToTalk, held, epoch);
    }
  }

  return { start: startNativeMicrophoneCapture, stop: stopNativeMicrophoneCapture,
    acknowledge: acknowledgeNativeMicrophoneChunk, notifyFailure, diagnostics, setTransmission,
    configure: (sessionId, settings) => obsAudioHost.configure(sessionId, settings),
    cancelTransmission: () => { if (nativeMicrophoneSession) obsAudioHost.cancelTransmission(nativeMicrophoneSession.sessionId); },
    get sessionId() { return nativeMicrophoneSession?.sessionId; } };
}

module.exports = { createNativeMicrophone, validMicrophoneSettings };

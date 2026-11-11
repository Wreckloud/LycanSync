const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const { validNativeAudioSessionId } = require('./native-audio-session.cjs');

// 共享声音的本机管道独立于页面发布；录制仍需要声音时只暂停交付，宿主继续持有来源。
function createNativeScreenAudio({ host: obsCaptureHost, getVideo, getRecording, getWindow, isClosing,
  capability: screenShareAudioCapability, writeDiagnostic: writeMediaDiagnostic, platform = process.platform,
  createPipeServer = createServer }) {
  let nativeScreenAudioSession;
  let lastScreenAudioDroppedChunks = 0;

  function finishNativeScreenAudioPipe(audio, { destroy = false } = {}) {
    if (!audio) return;
    audio.stopping = true;
    audio.queue.length = 0;
    audio.inFlight = undefined;
    audio.buffer = Buffer.alloc(0);
    if (audio.socket && !audio.socket.destroyed) {
      if (destroy) audio.socket.destroy(); else audio.socket.end();
    }
    if (audio.server.listening) audio.server.close();
  }

  function confirmStopped(sessionId, pipeId) {
    const audio = nativeScreenAudioSession;
    if (!audio || audio.sessionId !== sessionId
        || (pipeId !== undefined && pipeId !== audio.pipeId)) return;
    notifyNativeScreenAudioError(audio, 'screenShareAudioFailed');
    finishNativeScreenAudioPipe(audio, { destroy: true });
    lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
    if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
  }

  function handleNativeScreenAudioPipeData(audio, incoming) {
    if (nativeScreenAudioSession !== audio || audio.stopping) return;
    audio.buffer = audio.buffer.length ? Buffer.concat([audio.buffer, incoming]) : incoming;
    while (audio.buffer.length >= 4) {
      const frames = audio.buffer.readUInt32LE(0);
      if (!frames || frames > 4096) {
        notifyNativeScreenAudioError(audio, 'screenShareAudioInvalidPacket');
        return;
      }
      const packetBytes = 4 + frames * 2 * 4;
      if (audio.buffer.length < packetBytes) break;
      const pcm = Uint8Array.from(audio.buffer.subarray(4, packetBytes));
      audio.buffer = audio.buffer.subarray(packetBytes);
      if (audio.queue.length === 12) {
        audio.queue.shift();
        audio.droppedChunks++;
      }
      if (audio.publishing) audio.queue.push({ frames, pcm });
    }
    if (audio.buffer.length > 65_536) {
      notifyNativeScreenAudioError(audio, 'screenShareAudioBufferOverflow');
      return;
    }
    sendNextNativeScreenAudioChunk(audio);
  }

  function sendNextNativeScreenAudioChunk(audio) {
    const mainWindow = getWindow();
    if (!audio.publishing || nativeScreenAudioSession !== audio || audio.stopping || !audio.format || audio.inFlight || !audio.queue.length
        || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const sequence = ++audio.sequence;
    const packet = audio.queue.shift();
    audio.inFlight = sequence;
    mainWindow.webContents.send('media:native-screen-audio-frame', {
      sessionId: audio.sessionId,
      sequence,
      frames: packet.frames,
      sampleRate: audio.sampleRate,
      channels: 2,
      pcm: packet.pcm,
    });
  }

  function acknowledgeNativeScreenAudioChunk(sessionId, sequence, droppedChunks) {
    if (!validNativeAudioSessionId(sessionId) || !Number.isSafeInteger(sequence)
        || !Number.isSafeInteger(droppedChunks) || droppedChunks < 0) return;
    const audio = nativeScreenAudioSession;
    if (!audio || audio.sessionId !== sessionId || audio.inFlight !== sequence) return;
    audio.rendererDroppedChunks = Math.max(audio.rendererDroppedChunks, droppedChunks);
    audio.inFlight = undefined;
    sendNextNativeScreenAudioChunk(audio);
  }

  function notifyNativeScreenAudioError(audio, code) {
    const recording = getRecording();
    const mainWindow = getWindow();
    if (!audio || audio.failureNotified || audio.stopping) return;
    // 共享整体结束时声音随之结束；录制收尾是否成功由录制宿主确认。
    if (getVideo()?.sessionId === audio.sessionId && getVideo().stopping) return;
    audio.failureNotified = true;
    if (recording.media?.videoSessionId === audio.sessionId && recording.media.options.applicationAudio) {
      void recording.failMedia(recording.media.id, 'recordingApplicationAudioUnavailable').catch(() => {});
    }
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
    finishNativeScreenAudioPipe(audio, { destroy: true });
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('media:native-screen-audio-error', { sessionId: audio.sessionId, code: safeCode });
    }
    void stopNativeScreenAudio(audio.sessionId, true).catch((error) => {
      void writeMediaDiagnostic({ stage: 'stopScreenAudioAfterFailure', message: String(error.message).slice(0, 500) });
    });
  }

  async function startNativeScreenAudio(sourceId, sessionId, publishing = true) {
    const video = getVideo();
    if (isClosing() || platform !== 'win32') throw new Error('platformUnsupported');
    if (!video || video.starting || video.stopping || video.sessionId !== sessionId || video.sourceId !== sourceId) {
      throw new Error('videoSourceExpired');
    }
    if (nativeScreenAudioSession) {
      if (nativeScreenAudioSession.sessionId === sessionId && !nativeScreenAudioSession.stopping) {
        nativeScreenAudioSession.publishing ||= publishing;
        return nativeScreenAudioSession.startPromise;
      }
      throw new Error('screenShareAudioAlreadyRunning');
    }
    lastScreenAudioDroppedChunks = 0;
    const pipeId = randomUUID();
    const server = createPipeServer();
    const audio = {
      sessionId, pipeId, server, socket: undefined, buffer: Buffer.alloc(0), queue: [],
      inFlight: undefined, sequence: 0, sampleRate: undefined, droppedChunks: 0,
      rendererDroppedChunks: 0, stopping: false, failureNotified: false, publishing,
    };
    nativeScreenAudioSession = audio;
    server.on('connection', (socket) => {
      if (nativeScreenAudioSession !== audio || audio.stopping || audio.socket) {
        socket.destroy();
        return;
      }
      audio.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => handleNativeScreenAudioPipeData(audio, chunk));
      socket.once('error', () => notifyNativeScreenAudioError(audio, 'screenShareAudioPipeFailed'));
      socket.once('close', () => {
        if (nativeScreenAudioSession === audio && !audio.stopping) {
          notifyNativeScreenAudioError(audio, 'screenShareAudioPipeClosed');
        }
      });
    });
    server.on('error', () => notifyNativeScreenAudioError(audio, 'screenShareAudioPipeFailed'));
    audio.startPromise = (async () => {
      try {
        await new Promise((resolveListen, rejectListen) => {
          const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
          const onListening = () => { server.removeListener('error', onError); resolveListen(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(`\\\\.\\pipe\\lycansync-screen-audio-${pipeId}`);
        });
        if (nativeScreenAudioSession !== audio || audio.stopping || getVideo() !== video || video.stopping) {
          throw new Error('screenShareAudioSessionStopped');
        }
        const capability = screenShareAudioCapability();
        const mode = capability.available && capability.reason === 'windowsApplicationLoopbackProcessTree' ? 'process'
          : capability.available && capability.reason === 'windowsSystemMixLoopback' ? 'systemMix' : undefined;
        if (!mode) throw new Error('screenShareAudioUnsupported');
        audio.captureStart = obsCaptureHost.startScreenAudio(sessionId, pipeId, mode);
        const format = await audio.captureStart;
        if (nativeScreenAudioSession !== audio || audio.stopping || getVideo() !== video || video.stopping) {
          throw new Error('screenShareAudioSessionStopped');
        }
        audio.sampleRate = format.sampleRate;
        audio.format = format;
        sendNextNativeScreenAudioChunk(audio);
        return format;
      } catch (error) {
        finishNativeScreenAudioPipe(audio, { destroy: true });
        try { if (nativeScreenAudioSession === audio) await stopScreenAudioCapture(audio); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], '共享声音启动失败，请重启应用后再试。');
        }
        if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
        throw error;
      }
    })();
    return audio.startPromise;
  }

  async function stopScreenAudioCapture(audio) {
    if (!audio.captureStart) return { changed: false };
    return obsCaptureHost.stopScreenAudio(audio.sessionId, audio.pipeId);
  }

  async function stopNativeScreenAudio(sessionId, force = false) {
    const recording = getRecording();
    const audio = nativeScreenAudioSession;
    if (!audio) return { changed: false };
    if (audio.sessionId !== sessionId) throw new Error('screenShareAudioSessionMismatch');
    if (!force && recording.media?.videoSessionId === sessionId
        && recording.media.options.applicationAudio) {
      pausePublishing(sessionId);
      return { changed: true };
    }
    if (audio.stopPromise) return audio.stopPromise;
    audio.stopPromise = (async () => {
      const helperStop = stopScreenAudioCapture(audio);
      // 先切断本机交付，再等待来源清理；失败时保留身份，不能重新启动声音。
      finishNativeScreenAudioPipe(audio, { destroy: true });
      try {
        const result = await helperStop;
        if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
        return result;
      } finally {
        if (!nativeScreenAudioSession || nativeScreenAudioSession === audio) {
          lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
        }
      }
    })();
    return audio.stopPromise;
  }

  function pausePublishing(sessionId) {
    const audio = nativeScreenAudioSession;
    if (audio?.sessionId !== sessionId) return;
    audio.publishing = false; audio.queue.length = 0; audio.inFlight = undefined;
  }

  function notifyFailure(sessionId, code, pipeId) {
    const audio = nativeScreenAudioSession;
    if (audio?.sessionId === sessionId && (pipeId === undefined || audio.pipeId === pipeId)) notifyNativeScreenAudioError(audio, code);
  }

  return { start: startNativeScreenAudio, stop: stopNativeScreenAudio, acknowledge: acknowledgeNativeScreenAudioChunk,
    confirmStopped, notifyFailure, pausePublishing,
    get sessionId() { return nativeScreenAudioSession?.sessionId; },
    get publishing() { return nativeScreenAudioSession?.publishing ?? false; },
    get droppedChunks() { return nativeScreenAudioSession
      ? nativeScreenAudioSession.droppedChunks + nativeScreenAudioSession.rendererDroppedChunks : lastScreenAudioDroppedChunks; } };
}

module.exports = { createNativeScreenAudio };

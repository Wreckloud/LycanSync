const { mkdir, readFile, writeFile, rename, open, stat, statfs } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');

const RECORDING_CODES = new Set(['recordingShareUnavailable', 'recordingBusy', 'recordingPathInvalid',
  'recordingHardwareEncoderUnavailable', 'recordingEncoderStartFailed', 'recordingAudioEncoderUnavailable',
  'recordingOutputUnavailable', 'recordingModuleUnavailable', 'recordingApplicationAudioUnavailable',
  'recordingDiskFull', 'recordingWriteFailed', 'recordingHostExited', 'recordingStartTimedOut', 'recordingStopUnconfirmed', 'recordingVoiceUnavailable']);

function recordingError(error) {
  return RECORDING_CODES.has(error?.message) ? error.message
    : error?.code === 'ENOSPC' ? 'recordingDiskFull' : 'recordingWriteFailed';
}

// 主进程唯一持有录像路径、文件段和输出状态；页面只能修改偏好及请求开始／停止。
function createRecording({ dataDirectory, host, getVideo, ensureAudio, releaseAudio, ensureVoice, releaseVoice, onChange, onDiagnostic,
  io = { mkdir, readFile, writeFile, rename, open, stat, statfs }, createId = randomUUID }) {
  const settingsPath = join(dataDirectory, 'recording-settings.json');
  let settings = { directory: join(dataDirectory, 'recordings'), applicationAudio: true, microphone: false, friends: false };
  let loaded;
  let active;
  let latest;
  let continuing = false;
  let generation = 0;
  let saveSettings = Promise.resolve();

  function snapshot() {
    const current = active ?? latest;
    return { holdingResources: Boolean(active), phase: current?.phase ?? 'idle', recordingId: current?.id ?? null, startedAt: current?.startedAt ?? null,
      bytes: current?.bytes ?? 0, error: current?.error ?? null, saved: Boolean(current?.saved),
      continuing, applicationAudio: current?.options.applicationAudio ?? settings.applicationAudio };
  }
  function publish() { onChange(snapshot()); }
  async function load() {
    loaded ??= (async () => {
      try {
        const value = JSON.parse(await io.readFile(settingsPath, 'utf8'));
        if (!value || !isAbsolute(value.directory) || !['applicationAudio', 'microphone', 'friends'].every(key => typeof value[key] === 'boolean')) {
          throw new Error('recordingPathInvalid');
        }
        settings = { directory: value.directory, applicationAudio: value.applicationAudio, microphone: value.microphone, friends: value.friends };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    await loaded;
    return { ...settings };
  }
  async function configure(patch) {
    await load();
    if (active || continuing) throw new Error('recordingBusy');
    const next = { ...settings, ...patch };
    if (typeof next.directory !== 'string' || !isAbsolute(next.directory) || next.directory.includes('\0')
        || !['applicationAudio', 'microphone', 'friends'].every(key => typeof next[key] === 'boolean')) throw new Error('recordingPathInvalid');
    const result = saveSettings.then(async () => {
      await io.mkdir(dataDirectory, { recursive: true });
      await io.writeFile(settingsPath + '.pending', JSON.stringify(next));
      await io.rename(settingsPath + '.pending', settingsPath);
      settings = next;
      return { ...settings };
    });
    saveSettings = result.catch(() => {});
    return result;
  }
  async function updateSize(current) {
    try { current.bytes = (await io.stat(current.path)).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function finishAudio(current) {
    const cleanups = [];
    if (current.voiceAcquired) { current.voiceAcquired = false; cleanups.push(releaseVoice(current.id)); }
    if (current.audioAcquired) { current.audioAcquired = false; cleanups.push(releaseAudio(current.videoSessionId)); }
    const results = await Promise.allSettled(cleanups);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function start() {
    await load();
    if (active) throw new Error('recordingBusy');
    const video = getVideo();
    if (!video || video.starting || video.stopping) throw new Error('recordingShareUnavailable');
    const current = { id: createId(), videoSessionId: video.sessionId, options: { ...settings },
      phase: 'starting', startedAt: null, bytes: 0, error: null, saved: false, generation: ++generation };
    active = current; publish();
    current.start = (async () => {
      try {
        await io.mkdir(current.options.directory, { recursive: true });
        const space = await io.statfs(current.options.directory);
        if (space.bavail * space.bsize < 256 * 1024 * 1024) throw new Error('recordingDiskFull');
        current.path = join(current.options.directory, `LycanSync-${new Date().toISOString().replace(/[:.]/g, '-')}-${current.id}.mkv`);
        // 独占预留，绝不覆盖已有文件；失败时保留部分录像供用户检查。
        const file = await io.open(current.path, 'wx'); await file.close();
        if (active !== current || current.phase !== 'starting' || getVideo() !== video) throw new Error('recordingShareUnavailable');
        if (current.options.applicationAudio) {
          current.audioPreparing = true;
          try { await ensureAudio(current.videoSessionId); current.audioAcquired = true; }
          catch { throw new Error('recordingApplicationAudioUnavailable'); }
          finally { current.audioPreparing = false; }
        }
        if (active !== current || current.phase !== 'starting') throw new Error('recordingShareUnavailable');
        if (current.options.microphone || current.options.friends) {
          current.voicePreparing = true;
          try { await ensureVoice(current.id); current.voiceAcquired = true; }
          catch { throw new Error('recordingVoiceUnavailable'); }
          finally { current.voicePreparing = false; }
        }
        if (active !== current || current.phase !== 'starting' || getVideo() !== video) throw new Error('recordingShareUnavailable');
        current.hostStarted = true;
        await host.startRecording(current.videoSessionId, current.id, current.path, current.options.applicationAudio,
          current.options.microphone || current.options.friends);
        if (active !== current || current.phase !== 'starting') throw new Error('recordingShareUnavailable');
        if (current.hostEnded) throw new Error(current.error ?? 'recordingWriteFailed');
        current.phase = 'recording'; current.startedAt = Date.now();
        onDiagnostic({ stage: 'recordingStarted', applicationAudio: current.options.applicationAudio,
          microphone: current.options.microphone, friends: current.options.friends }); publish(); return snapshot();
      } catch (error) {
        const cancelled = current.phase === 'stopping' && !current.error;
        if (current.hostStarted) {
          try { await host.stopRecording(current.videoSessionId, current.id); }
          catch (stopError) { current.error = recordingError(stopError); }
        }
        if (current.error === 'recordingStopUnconfirmed') {
          current.phase = 'failed'; publish();
          throw new Error(current.error);
        }
        await finishAudio(current).catch(() => { current.error ??= 'recordingApplicationAudioUnavailable'; });
        current.phase = cancelled ? 'idle' : 'failed';
        if (!cancelled) current.error ??= recordingError(error);
        if (active === current) { active = undefined; latest = current; publish(); }
        if (!cancelled) onDiagnostic({ stage: 'recordingFailed', code: current.error });
        throw new Error(cancelled ? 'recordingCancelled' : current.error);
      }
    })();
    return current.start;
  }
  async function stop(preserveContinuation = false) {
    generation++;
    if (!preserveContinuation) continuing = false;
    const current = active;
    if (!current) return snapshot();
    if (current.stop) return current.stop;
    current.phase = 'stopping'; publish();
    current.stop = (async () => {
      try {
        if (current.audioPreparing) await releaseAudio(current.videoSessionId);
        if (current.voicePreparing) await releaseVoice(current.id);
        if (current.hostStarted && !current.hostEnded) {
          const result = await host.stopRecording(current.videoSessionId, current.id);
          current.hostEnded = true;
          current.outputFrames = result?.outputFrames ?? current.outputFrames ?? 0;
        }
        if (current.start) await current.start.catch(() => {});
        await finishAudio(current);
        await updateSize(current);
        current.saved = current.startedAt !== null && current.outputFrames > 0 && current.bytes > 0 && !current.error;
        current.phase = current.error ? 'failed' : current.saved ? 'saved' : 'idle';
        onDiagnostic({ stage: 'recordingStopped', ...(current.error ? { code: current.error } : {}), bytes: current.bytes, outputFrames: current.outputFrames ?? 0,
          durationMs: current.startedAt === null ? 0 : Date.now() - current.startedAt, saved: current.saved });
      } catch (error) {
        current.phase = 'failed'; current.error = recordingError(error);
        // 只有输出停止未确认才继续阻挡；落盘或音频清理失败不能把已停止输出永久锁住。
        if (current.hostEnded || !current.hostStarted) {
          if (active === current) { active = undefined; latest = current; }
        }
        onDiagnostic({ stage: 'recordingFailed', code: current.error });
        publish(); throw new Error(current.error);
      }
      if (active === current) { active = undefined; latest = current; }
      publish(); return snapshot();
    })();
    return current.stop;
  }
  function hostEvent(_state, event) {
    const current = active;
    if (!current || current.id !== event.recordingId || event.event === 'recordingStarted') return;
    current.hostEnded = true;
    current.outputFrames = event.outputFrames ?? 0;
    if (current.error === 'recordingStopUnconfirmed') current.error = null;
    if (event.code) current.error = RECORDING_CODES.has(event.code) ? event.code : 'recordingWriteFailed';
    if (current.phase === 'failed') current.stop = undefined;
    if (current.phase === 'recording' || current.phase === 'failed') void stop().catch(() => {});
  }
  async function fail(id, code) {
    if (!active || active.id !== id || !RECORDING_CODES.has(code)) throw new Error('recordingSessionMismatch');
    active.error = code;
    return stop();
  }
  async function withVideoChange(operation) {
    if (!active) return operation();
    if (continuing || active.phase !== 'recording') throw new Error('recordingBusy');
    continuing = true;
    try {
      await stop(true);
      const version = generation;
      const result = await operation();
      if (version === generation && getVideo()) {
        try { await start(); } catch { /* 共享配置已成功，录像失败由独立状态反馈。 */ }
      }
      return result;
    } finally { continuing = false; publish(); }
  }
  return { load, configure, start, stop, fail, hostEvent, withVideoChange, snapshot,
    get active() { return active; },
    async status() { if (active?.path) await updateSize(active); return snapshot(); },
    async revealPath() {
      await load();
      if (latest?.saved) return latest.path;
      await io.mkdir(settings.directory, { recursive: true }); return settings.directory;
    },
  };
}

module.exports = { createRecording };

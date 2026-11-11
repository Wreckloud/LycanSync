const { mkdir, readFile, writeFile, rename, open, stat, statfs } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRecordingLibrary } = require('./recording-library.cjs');

const RECORDING_CODES = new Set(['recordingShareUnavailable', 'recordingBusy', 'recordingPathInvalid',
  'recordingHardwareEncoderUnavailable', 'recordingEncoderStartFailed', 'recordingAudioEncoderUnavailable',
  'recordingOutputUnavailable', 'recordingModuleUnavailable', 'recordingApplicationAudioUnavailable',
  'recordingDiskFull', 'recordingWriteFailed', 'recordingHostExited', 'recordingStartTimedOut', 'recordingStopUnconfirmed', 'recordingVoiceUnavailable', 'recordingLibraryUnavailable', 'replaySaveUnconfirmed']);

function recordingError(error) {
  return RECORDING_CODES.has(error?.message) ? error.message
    : error?.code === 'ENOSPC' ? 'recordingDiskFull' : 'recordingWriteFailed';
}

// 主进程唯一持有录像路径、文件段和输出状态；页面只能修改偏好及请求开始／停止。
function createRecording({ dataDirectory, host, getVideo, ensureAudio, releaseAudio, ensureVoice, releaseVoice, onChange, onDiagnostic,
  io = { mkdir, readFile, writeFile, rename, open, stat, statfs }, createId = randomUUID }) {
  const settingsPath = join(dataDirectory, 'recording-settings.json');
  let settings = { directory: join(dataDirectory, 'recordings'), applicationAudio: true, microphone: false, friends: false,
    replaySeconds: 60, videoHeight: 1080, videoFps: 60 };
  let loaded;
  let active;
  let latest;
  let media;
  let replay;
  let latestReplay;
  let continuing = false;
  let generation = 0;
  let diagnosticSequence = 0;
  let saveSettings = Promise.resolve();
  const library = createRecordingLibrary({ dataDirectory, isActive: id => active?.id === id || replay?.saving?.id === id });

  function snapshot() {
    const current = active ?? latest;
    return { holdingResources: Boolean(active), phase: current?.phase ?? 'idle', recordingId: current?.id ?? null, startedAt: current?.startedAt ?? null,
      bytes: current?.bytes ?? 0, error: current?.error ?? null, saved: Boolean(current?.saved),
      continuing, applicationAudio: current?.options.applicationAudio ?? settings.applicationAudio,
      mediaId: media?.id ?? null, mediaVoices: Boolean(media && !media.stopping && (media.options.microphone || media.options.friends)
        && (active?.media === media && ['starting', 'recording'].includes(active.phase)
          || replay?.media === media && ['starting', 'buffering'].includes(replay.phase))),
      replay: { id: replay?.id ?? null, holdingResources: Boolean(replay), phase: (replay ?? latestReplay)?.phase ?? 'idle',
        seconds: (replay ?? latestReplay)?.options.replaySeconds ?? settings.replaySeconds,
        saving: Boolean(replay?.saving), error: (replay ?? latestReplay)?.error ?? null,
        warming: Boolean(replay?.phase === 'buffering' && replay.monotonicStart !== undefined
          && performance.now() - replay.monotonicStart < replay.options.replaySeconds * 1000),
        lastSavedDuringWarmup: Boolean((replay ?? latestReplay)?.lastSavedDuringWarmup),
        lastSavedId: (replay ?? latestReplay)?.lastSavedId ?? null } };
  }
  function publish() { onChange(snapshot()); }
  async function load() {
    loaded ??= (async () => {
      try {
        const value = JSON.parse(await io.readFile(settingsPath, 'utf8'));
        if (!value || !isAbsolute(value.directory) || !['applicationAudio', 'microphone', 'friends'].every(key => typeof value[key] === 'boolean')) {
          throw new Error('recordingPathInvalid');
        }
        const replaySeconds = value.replaySeconds ?? 60;
        const videoHeight = value.videoHeight ?? 1080, videoFps = value.videoFps ?? 60;
        if (![30, 60, 120].includes(replaySeconds) || ![720, 1080, 1440].includes(videoHeight) || ![30, 60, 120].includes(videoFps)) throw new Error('recordingPathInvalid');
        settings = { directory: value.directory, applicationAudio: value.applicationAudio, microphone: value.microphone, friends: value.friends,
          replaySeconds, videoHeight, videoFps };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    await loaded;
    return { ...settings };
  }
  async function configure(patch) {
    await load();
    if (active || replay || continuing) throw new Error('recordingBusy');
    const next = { ...settings, ...patch };
    if (typeof next.directory !== 'string' || !isAbsolute(next.directory) || next.directory.includes('\0')
        || !['applicationAudio', 'microphone', 'friends'].every(key => typeof next[key] === 'boolean') || ![30, 60, 120].includes(next.replaySeconds)
        || ![720, 1080, 1440].includes(next.videoHeight) || ![30, 60, 120].includes(next.videoFps)) throw new Error('recordingPathInvalid');
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
  async function acquireMedia(current) {
    if (media && (media.videoSessionId !== current.videoSessionId || media.stopping
        || ['applicationAudio', 'microphone', 'friends', 'videoHeight', 'videoFps'].some(key => media.options[key] !== current.options[key]))) throw new Error('recordingBusy');
    if (!media) {
      const shared = { id: current.id, videoSessionId: current.videoSessionId, options: current.options, owners: new Set() };
      media = shared;
      shared.start = (async () => {
        await host.setRecordingFrameRate(shared.videoSessionId, shared.options.videoFps);
        shared.videoPrepared = true;
        if (shared.cancelled) throw new Error('recordingCancelled');
        if (shared.options.applicationAudio) {
          shared.audioPreparing = true;
          try { await ensureAudio(shared.videoSessionId); shared.audioAcquired = true; }
          catch { throw new Error('recordingApplicationAudioUnavailable'); }
          finally { shared.audioPreparing = false; }
        }
        if (shared.options.microphone || shared.options.friends) {
          if (shared.cancelled) throw new Error('recordingCancelled');
          shared.voicePreparing = true;
          try { await ensureVoice(shared.id); shared.voiceAcquired = true; }
          catch { throw new Error('recordingVoiceUnavailable'); }
          finally { shared.voicePreparing = false; }
        }
      })();
    }
    const shared = media;
    current.media = shared;
    shared.owners.add(current.id); publish();
    await shared.start;
    return shared.id;
  }
  async function cancelPreparing(current, force = false) {
    const shared = current.media;
    if (!shared || !force && shared.owners.size !== 1) return;
    shared.cancelled = true; shared.stopping = true;
    if (shared.audioPreparing) await releaseAudio(shared.videoSessionId);
    if (shared.voicePreparing) await releaseVoice(shared.id);
  }
  async function finishMedia(current) {
    const shared = current.media;
    if (!shared) return;
    current.media = undefined;
    shared.owners.delete(current.id);
    if (shared.owners.size) return;
    shared.stopping = true;
    const cleanups = [];
    if (shared.voiceAcquired) { shared.voiceAcquired = false; cleanups.push(releaseVoice(shared.id)); }
    if (shared.audioAcquired) { shared.audioAcquired = false; cleanups.push(releaseAudio(shared.videoSessionId)); }
    if (shared.videoPrepared) { shared.videoPrepared = false; cleanups.push(host.setRecordingFrameRate(shared.videoSessionId, 0)); }
    const results = await Promise.allSettled(cleanups);
    if (media === shared) media = undefined;
    publish();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function start(previousId) {
    await load();
    if (active || replay && replay.phase !== 'buffering') throw new Error('recordingBusy');
    if (previousId !== undefined && (latest?.id !== previousId || latest.error || !['saved', 'idle'].includes(latest.phase))) throw new Error('recordingSessionMismatch');
    const video = getVideo();
    if (!video || video.starting || video.stopping) throw new Error('recordingShareUnavailable');
    generation++;
    const current = { id: createId(), videoSessionId: video.sessionId, options: { ...settings },
      diagnosticId: ++diagnosticSequence, requestedAt: performance.now(),
      phase: 'starting', startedAt: null, bytes: 0, error: null, saved: false };
    current.librarySessionId = previousId ? latest.librarySessionId : current.id;
    active = current; publish();
    current.start = (async () => {
      try {
        await library.ready();
        await io.mkdir(current.options.directory, { recursive: true });
        const space = await io.statfs(current.options.directory);
        if (space.bavail * space.bsize < 256 * 1024 * 1024) throw new Error('recordingDiskFull');
        current.path = join(current.options.directory, `LycanSync-${new Date().toISOString().replace(/[:.]/g, '-')}-${current.id}.mkv`);
        // 独占预留，绝不覆盖已有文件；失败时保留部分录像供用户检查。
        const file = await io.open(current.path, 'wx'); await file.close();
        await library.register(current); current.registered = true;
        if (active !== current || current.phase !== 'starting' || getVideo() !== video) throw new Error('recordingShareUnavailable');
        const pipelineId = await acquireMedia(current);
        if (active !== current || current.phase !== 'starting' || getVideo() !== video) throw new Error('recordingShareUnavailable');
        current.hostStarted = true;
        const started = await host.startRecording(current.videoSessionId, current.id, current.path, current.options.applicationAudio,
          current.options.microphone || current.options.friends, pipelineId, current.options);
        if (active !== current || current.phase !== 'starting') throw new Error('recordingShareUnavailable');
        if (current.hostEnded) throw new Error(current.error ?? 'recordingWriteFailed');
        current.phase = 'recording'; current.startedAt = Date.now();
        current.monotonicStart = performance.now(); current.width = started?.width; current.height = started?.height;
        onDiagnostic({ operationId: current.diagnosticId, stage: 'recordingStarted', startupMs: Math.round(performance.now() - current.requestedAt), applicationAudio: current.options.applicationAudio,
          width: started?.width, height: started?.height, configuredFrameRate: started?.frameRate,
          encoder: started?.encoder, configuredRateControl: started?.configuredRateControl, configuredLookahead: started?.configuredLookahead,
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
        await finishMedia(current).catch(error => { current.error ??= recordingError(error); });
        current.phase = cancelled ? 'idle' : 'failed';
        if (!cancelled) current.error ??= recordingError(error);
        if (current.registered && !cancelled) {
          try { await library.finish(current); }
          catch { current.error = 'recordingLibraryUnavailable'; }
        }
        if (active === current) { active = undefined; latest = current; publish(); }
        if (!cancelled) onDiagnostic({ operationId: current.diagnosticId, stage: 'recordingFailed', code: current.error });
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
    const stopRequestedAt = performance.now();
    current.phase = 'stopping'; publish();
    current.stop = (async () => {
      try {
        await cancelPreparing(current);
        if (current.hostStarted && !current.hostEnded) {
          const result = await host.stopRecording(current.videoSessionId, current.id);
          current.hostEnded = true;
          current.outputFrames = result?.outputFrames ?? current.outputFrames ?? 0;
        }
        if (current.start) await current.start.catch(() => {});
        await finishMedia(current);
        await updateSize(current);
        current.saved = current.startedAt !== null && current.outputFrames > 0 && current.bytes > 0 && !current.error;
        current.durationMs = current.monotonicStart === undefined ? null : Math.max(0, Math.round(performance.now() - current.monotonicStart));
        if (current.registered) await library.finish(current);
        current.phase = current.error ? 'failed' : current.saved ? 'saved' : 'idle';
        onDiagnostic({ operationId: current.diagnosticId, stage: 'recordingStopped', ...(current.error ? { code: current.error } : {}), bytes: current.bytes, outputFrames: current.outputFrames ?? 0,
          durationMs: current.durationMs ?? 0, stopMs: Math.round(performance.now() - stopRequestedAt), saved: current.saved });
      } catch (error) {
        current.phase = 'failed'; current.error = recordingError(error);
        // 只有输出停止未确认才继续阻挡；落盘或音频清理失败不能把已停止输出永久锁住。
        if (current.hostEnded || !current.hostStarted) {
          if (active === current) { active = undefined; latest = current; }
        }
        onDiagnostic({ operationId: current.diagnosticId, stage: 'recordingFailed', code: current.error });
        publish(); throw new Error(current.error);
      }
      if (active === current) { active = undefined; latest = current; }
      publish(); return snapshot();
    })();
    return current.stop;
  }
  async function startReplay(resuming = false) {
    await load();
    if (replay || continuing && !resuming || active && active.phase !== 'recording') throw new Error('recordingBusy');
    const video = getVideo();
    if (!video || video.starting || video.stopping) throw new Error('recordingShareUnavailable');
    const current = { id: createId(), videoSessionId: video.sessionId, options: { ...settings }, diagnosticId: ++diagnosticSequence, requestedAt: performance.now(), phase: 'starting', error: null };
    replay = current; publish();
    current.start = (async () => {
      try {
        await library.ready();
        const pipelineId = await acquireMedia(current);
        if (replay !== current || current.phase !== 'starting' || getVideo() !== video) throw new Error('recordingShareUnavailable');
        current.hostStarted = true;
        const started = await host.startReplay(current.videoSessionId, current.id, current.options.replaySeconds,
          current.options.applicationAudio, current.options.microphone || current.options.friends, pipelineId, current.options);
        if (current.hostEnded || replay !== current || current.phase !== 'starting') throw new Error('recordingShareUnavailable');
        current.width = started.width; current.height = started.height;
        current.phase = 'buffering'; current.monotonicStart = performance.now();
        onDiagnostic({ operationId: current.diagnosticId, stage: 'replayStarted', startupMs: Math.round(performance.now() - current.requestedAt), seconds: current.options.replaySeconds, width: current.width, height: current.height, configuredFrameRate: started.frameRate,
          encoder: started.encoder, configuredRateControl: started.configuredRateControl, configuredLookahead: started.configuredLookahead,
          memoryBudgetMb: started.memoryBudgetMb });
        publish(); return snapshot();
      } catch (error) {
        const cancelled = current.phase === 'stopping' && !current.error;
        if (current.hostStarted && !current.hostEnded) {
          try { await host.stopReplay(current.videoSessionId, current.id); current.hostEnded = true; }
          catch { current.error = 'recordingStopUnconfirmed'; }
        }
        if (current.error !== 'recordingStopUnconfirmed') {
          await finishMedia(current).catch(error => { current.error ??= recordingError(error); });
          if (replay === current) { replay = undefined; latestReplay = current; }
        }
        current.phase = cancelled && !current.error ? 'idle' : 'failed';
        if (!cancelled) current.error ??= recordingError(error);
        if (current.error) onDiagnostic({ operationId: current.diagnosticId, stage: 'replayFailed', code: current.error });
        publish(); throw new Error(cancelled && !current.error ? 'recordingCancelled' : current.error);
      }
    })();
    return current.start;
  }
  async function keepReplayFile(current, saved) {
    try { current.bytes = (await io.stat(current.path)).size; }
    catch (error) { if (error.code === 'ENOENT' && !saved) return; throw error; }
    current.saved = saved && current.bytes > 0;
    if (!current.bytes && saved) throw new Error('recordingWriteFailed');
    if (!current.registered) { await library.register(current); current.registered = true; }
    await library.finish(current);
  }
  async function saveReplay() {
    const current = replay;
    if (!current || current.phase !== 'buffering' || current.error || current.saving) throw new Error('recordingBusy');
    const saved = { id: createId(), librarySessionId: current.id, width: current.width, height: current.height };
    const saveRequestedAt = performance.now();
    const bufferedMs = Math.max(0, Math.round(saveRequestedAt - current.monotonicStart));
    const duringWarmup = bufferedMs < current.options.replaySeconds * 1000;
    saved.path = join(current.options.directory, `LycanSync-Replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${saved.id}.mkv`);
    current.saving = saved; publish();
    saved.promise = (async () => {
      try {
        await io.mkdir(current.options.directory, { recursive: true });
        const space = await io.statfs(current.options.directory);
        if (space.bavail * space.bsize < 256 * 1024 * 1024) throw new Error('recordingDiskFull');
        await host.saveReplay(current.videoSessionId, current.id, saved.id, saved.path);
        await keepReplayFile(saved, true);
        current.lastSavedId = saved.id;
        current.lastSavedDuringWarmup = duringWarmup;
        onDiagnostic({ operationId: current.diagnosticId, stage: 'replaySaved', bytes: saved.bytes, duringWarmup, bufferedMs,
          seconds: current.options.replaySeconds, saveMs: Math.round(performance.now() - saveRequestedAt) });
      } catch (error) {
        current.error = recordingError(error);
        if (current.error === 'replaySaveUnconfirmed') current.unconfirmed = saved;
        else await keepReplayFile(saved, false).catch(() => { current.error = 'recordingLibraryUnavailable'; });
        onDiagnostic({ operationId: current.diagnosticId, stage: 'replayFailed', code: current.error });
        throw new Error(current.error);
      } finally { current.saving = undefined; publish(); }
    })();
    await saved.promise;
    return snapshot();
  }
  async function stopReplay(preserveContinuation = false) {
    generation++;
    if (!preserveContinuation) continuing = false;
    const current = replay;
    if (!current) return snapshot();
    if (current.stop) return current.stop;
    current.phase = 'stopping'; publish();
    const stopStartedAt = performance.now();
    onDiagnostic({ operationId: current.diagnosticId, stage: 'replayStopRequested', saving: Boolean(current.saving) });
    current.stop = (async () => {
      try {
        await cancelPreparing(current);
        if (current.saving) await current.saving.promise.catch(() => {});
        if (current.hostStarted && !current.hostEnded) {
          await host.stopReplay(current.videoSessionId, current.id); current.hostEnded = true;
        }
        await current.start?.catch(() => {});
        await finishMedia(current);
        if (current.unconfirmed) await keepReplayFile(current.unconfirmed, false);
      } catch (error) {
        current.phase = 'failed'; current.error = recordingError(error);
        if (current.hostEnded || !current.hostStarted) { if (replay === current) { replay = undefined; latestReplay = current; } }
        onDiagnostic({ operationId: current.diagnosticId, stage: 'replayFailed', code: current.error }); publish(); throw new Error(current.error);
      }
      current.phase = current.error ? 'failed' : 'idle';
      if (replay === current) { replay = undefined; latestReplay = current; }
      onDiagnostic({ operationId: current.diagnosticId, stage: 'replayStopped', durationMs: Math.round(performance.now() - stopStartedAt),
        ...(current.error ? { code: current.error } : {}) }); publish(); return snapshot();
    })();
    return current.stop;
  }
  function replayHostEvent(_state, event) {
    const current = replay;
    if (!current || current.id !== event.replayId || !['replayStopped', 'replayFailed'].includes(event.event)) return;
    current.hostEnded = true;
    if (current.error === 'recordingStopUnconfirmed') current.error = null;
    if (event.code) current.error = recordingError(new Error(event.code));
    if (current.phase === 'failed') current.stop = undefined;
    if (current.phase === 'buffering' || current.phase === 'failed') void stopReplay().catch(() => {});
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
  async function withVideoChange(operation) {
    if (!active && !replay) return operation();
    if (continuing || active && active.phase !== 'recording' || replay && replay.phase !== 'buffering') throw new Error('recordingBusy');
    continuing = true;
    try {
      const previousId = active?.id;
      const resumeReplay = Boolean(replay);
      await stopReplay(true); await stop(true);
      const version = generation;
      const result = await operation();
      if (version === generation && getVideo()) {
        try {
          if (resumeReplay) await startReplay(true);
          if (previousId) await start(previousId);
        } catch { /* 共享配置已成功，本地输出失败由独立状态反馈。 */ }
      }
      return result;
    } finally { continuing = false; publish(); }
  }
  return { load, configure, start, stop, hostEvent, withVideoChange, snapshot, library,
    startReplay: () => startReplay(), saveReplay, stopReplay, replayHostEvent,
    get replay() { return replay; }, get media() { return media; },
    async stopAll() {
      let cancellationFailure;
      if (media) {
        media.stopping = true; publish();
        try { await cancelPreparing({ media }, true); } catch (error) { cancellationFailure = error; }
      }
      const results = await Promise.allSettled([stopReplay(), stop()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (cancellationFailure) throw cancellationFailure;
      return snapshot();
    },
    async failMedia(id, code) {
      if (media?.id !== id) throw new Error('recordingSessionMismatch');
      if (!['recordingVoiceUnavailable', 'recordingApplicationAudioUnavailable'].includes(code)) throw new Error('recordingSessionMismatch');
      if (active) active.error = code;
      if (replay) replay.error = code;
      return this.stopAll();
    },
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

const { randomUUID } = require('node:crypto');
const { leagueCaptureApplication } = require('./league-capture.cjs');
const { createNativeVideoTextures } = require('./native-video-textures.cjs');

// 页面只读当前会话；来源预留、采集、纹理及关联资源的停止由此处统一编排。
function createNativeVideoSession({ host: obsCaptureHost, mediaHelper, getSources, isCaptureGame,
  getBridge, getWindow, sharedTexture, getRecording, screenAudio: nativeScreenAudio, getGameFollow,
  isClosing, setMediaBackgroundActive, writeDiagnostic: writeMediaDiagnostic, recordFailure: recordVideoFailure,
  platform = process.platform }) {
  let nativeVideoSession;
  let nativeVideoPreparation;
  let lastStoppedNativeVideoSession;
  const nativeVideoTextures = createNativeVideoTextures({ getVideo: () => nativeVideoSession, getBridge, getWindow,
    sharedTexture, writeDiagnostic: writeMediaDiagnostic, recordFailure: recordVideoFailure,
    notifyFailure: notifyNativeVideoError });

  function notifyNativeVideoError(video, code) {
    const mainWindow = getWindow();
    if (!video || nativeVideoSession !== video || video.failureNotified) return video?.stopPromise;
    video.failureNotified = true;
    video.stopping = true;
    video.lastError = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'nativeVideoFailed';
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('media:native-video-error', {
        sessionId: video.sessionId,
        code: video.lastError,
      });
    }
    nativeVideoTextures.releaseImports(video);
    return stopNativeVideo(video.sessionId, code === 'captureTargetClosed' && Boolean(video.gameFollowId)).catch((error) => {
      recordVideoFailure('stopAfterFailure', error);
      console.error(`native video stop after capture failure failed: ${error.message}`);
    });
  }

  function handleVideoCaptureSuspended(state, event) {
    const mainWindow = getWindow();
    const video = nativeVideoSession;
    if (!video || video.sessionId !== event.sessionId || video.stopping
        || (video.helperState && video.helperState !== state)
        || state.videoSessionId !== event.sessionId) return;
    video.helperState = state;
    video.suspended = event.suspended;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('media:native-video-suspended', event);
    }
  }

  async function prepareNativeVideoSource(sourceId) {
    if (sourceId === null) { nativeVideoPreparation = undefined; return { prepared: false }; }
    const state = mediaHelper.videoSourceSnapshot?.state;
    if (!getSources().has(sourceId) || !state?.alive || state.closed) throw new Error('videoSourceExpired');
    if (nativeVideoPreparation?.sourceId === sourceId && nativeVideoPreparation.state === state) {
      return nativeVideoPreparation.promise;
    }
    const preparation = { sourceId, state };
    nativeVideoPreparation = preparation;
    const startedAt = performance.now();
    preparation.promise = (async () => {
      try {
        const target = await mediaHelper.inspectVideoSource(sourceId);
        const game = target.kind === 'window' && !target.requiresWindowCapture
          && await isCaptureGame(target.executable);
        if (isClosing() || nativeVideoPreparation !== preparation || mediaHelper.videoSourceSnapshot?.state !== state
            || !getSources().has(sourceId)) return { prepared: false };
        preparation.result = { target, game };
        void writeMediaDiagnostic({ stage: 'screenSourcePrepared', sourceKind: target.kind,
          durationMs: Math.round(performance.now() - startedAt) });
        return { prepared: true, ...(target.kind === 'window' && leagueCaptureApplication(target.executable)
          ? { followGame: 'league' } : {}) };
      } catch (error) {
        if (nativeVideoPreparation === preparation) nativeVideoPreparation = undefined;
        throw error;
      }
    })();
    return preparation.promise;
  }

  async function startNativeVideo(sourceId, maxFps, settings, resolution, gameFollowId) {
    const leagueCaptureFollow = getGameFollow();
    if (isClosing()) throw new Error('mediaHelperShuttingDown');
    if (platform !== 'win32') throw new Error('platformUnsupported');
    if (![30, 60, 120].includes(maxFps)
        || typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidVideoStart');
    if (settings?.followGame && (settings.followGame !== 'league' || !['auto', undefined].includes(settings.windowMethod))) {
      throw new Error('nativeGameFollowTargetInvalid');
    }
    if (nativeVideoSession) throw new Error('videoCaptureAlreadyRunning');
    const continuingGameFollow = Boolean(gameFollowId);
    getBridge();
    const sessionId = randomUUID();
    const source = getSources().get(sourceId);
    if (!source || !sourceId.startsWith(`${source.kind}:`)) throw new Error('videoSourceExpired');
    const video = { sessionId, sourceId, sourceKind: source.kind, starting: true,
      startedAt: performance.now(),
      imported: new Map(), pendingSlotReleases: new Set(), stopping: false, failureNotified: false };
    nativeVideoSession = video;
    void writeMediaDiagnostic({ stage: 'screenVideoStartRequested', sourceKind: source.kind,
      width: resolution?.width, height: resolution?.height, maxFps,
      ...(source.kind === 'window' ? { requestedMethod: settings?.windowMethod === undefined ? 'auto' : settings.windowMethod,
        ...(typeof settings?.hideBorder === 'boolean' ? { borderAllowed: !settings.hideBorder } : {}) } : {}),
      hostReused: Boolean(obsCaptureHost.state && !obsCaptureHost.state.closed && !obsCaptureHost.state.failed) });
    try {
      video.renderer = getWindow()?.webContents;
      if (!video.renderer || video.renderer.isDestroyed()) throw new Error('sharedTextureReceiverUnavailable');
      // 纹理接收与画布复制依赖主页面；共享期间切到游戏不能把该页面降为后台节流。
      setMediaBackgroundActive(video.renderer, 'video', true);
      video.backgroundActive = true;
      const reservation = mediaHelper.reserveVideo(sessionId, sourceId);
      video.targetState = mediaHelper.videoCapture?.state;
      let target = await reservation;
      if (isClosing() || video.stopping || nativeVideoSession !== video) throw new Error('nativeVideoSessionStopped');
      if (settings?.followGame !== undefined && settings.followGame !== 'league') throw new Error('nativeGameFollowTargetInvalid');
      if (settings?.followGame === 'league') {
        if (gameFollowId) leagueCaptureFollow.bind(gameFollowId, sourceId, target);
        else gameFollowId = leagueCaptureFollow.begin(sourceId, target);
        video.gameFollowId = gameFollowId;
      } else if (gameFollowId) throw new Error('nativeGameFollowTargetInvalid');
      const preparation = nativeVideoPreparation;
      if (preparation?.sourceId === sourceId) nativeVideoPreparation = undefined;
      const prepared = preparation?.sourceId === sourceId && preparation.state === video.targetState
        && preparation.result?.target.kind === target.kind ? preparation.result : undefined;
      const preparationReused = target.kind === 'window' && prepared?.target.windowId === target.windowId
        && prepared.target.lifetimeName === target.lifetimeName
        && prepared.target.processId === target.processId
        && prepared.target.processCreationTime === target.processCreationTime
        && prepared.target.requiresWindowCapture === target.requiresWindowCapture
        && prepared.target.executable === target.executable;
      void writeMediaDiagnostic({ stage: 'screenSourceReserved', durationMs: Math.round(performance.now() - video.startedAt),
        preparationReused,
        ...(target.kind === 'window' ? { requiresWindowCapture: target.requiresWindowCapture } : {}) });
      if (target.kind === 'window') {
        const method = settings?.windowMethod ?? 'auto';
        const game = method === 'game' || (method === 'auto' && !target.requiresWindowCapture
          && (preparationReused ? prepared.game : await isCaptureGame(target.executable)));
        // 程序分类只决定采集方式；授权范围仍是注册表预留的精确窗口实例。
        const { windowId, lifetimeName, processId, processCreationTime } = target;
        target = { kind: game ? 'game' : 'window', windowId, lifetimeName, processId, processCreationTime };
      }
      if (isClosing() || video.stopping || nativeVideoSession !== video) throw new Error('nativeVideoSessionStopped');
      const obsStartedAt = performance.now();
      const start = obsCaptureHost.start(sourceId, maxFps, sessionId, target, settings, resolution);
      video.helperState = obsCaptureHost.state;
      const started = await start;
      if (started.sessionId !== sessionId || !started.changed || isClosing() || video.stopping || nativeVideoSession !== video) {
        throw new Error('mediaHelperInvalidVideoStart');
      }
      video.starting = false;
      void writeMediaDiagnostic({ stage: 'obsReady', durationMs: Math.round(performance.now() - obsStartedAt) });
      if (gameFollowId && !continuingGameFollow) void writeMediaDiagnostic({ stage: 'gameFollowEnabled' });
      return { sessionId, changed: true, ...(gameFollowId ? { gameFollowId } : {}) };
    } catch (error) {
      if (!video.failureNotified) {
        if (['captureBorderUnsupported', 'captureBorderAccessDenied', 'captureSettingsUnsupported'].includes(error.message)) {
          void writeMediaDiagnostic({ stage: 'screenCaptureSelectionUnavailable', code: error.message });
        } else recordVideoFailure('startCapture', error);
      }
      video.stopping = true;
      try { await (video.stopPromise ?? stopNativeVideo(sessionId)); }
      catch (stopError) {
        recordVideoFailure('stopObsCaptureAfterStartFailure', stopError);
        throw new Error('obsCaptureStopUnconfirmed');
      }
      throw error;
    }
  }

  function restoreNativeVideoBackgroundThrottling(video) {
    if (!video.backgroundActive) return;
    setMediaBackgroundActive(video.renderer, 'video', false);
    video.backgroundActive = false;
  }

  async function stopObsVideo(video) {
    // 未确认采集清理或宿主退出时保留来源身份，不能让另一来源越过清理。
    const state = obsCaptureHost.state;
    const ownsCapture = !state || state.videoSessionId === video.sessionId;
    const stopped = ownsCapture
      ? await obsCaptureHost.stop(video.sessionId) : { changed: false };
    if (video.helperState && (video.helperState !== state || ownsCapture)) nativeVideoTextures.releaseHost(video.helperState);
    if (video.targetState && mediaHelper.videoCapture?.sessionId === video.sessionId) {
      const released = await mediaHelper.stopVideo(video.sessionId);
      return { changed: stopped.changed || released.changed };
    }
    return stopped;
  }

  async function stopNativeVideo(sessionId, preserveGameFollow = false) {
    const leagueCaptureFollow = getGameFollow();
    const recording = getRecording();
    const video = nativeVideoSession;
    if (!video) {
      return lastStoppedNativeVideoSession === sessionId
        ? { changed: false }
        : Promise.reject(new Error('videoSessionMismatch'));
    }
    if (video.sessionId !== sessionId) throw new Error('videoSessionMismatch');
    if (!preserveGameFollow && video.gameFollowId) leagueCaptureFollow.end(video.gameFollowId);
    if (video.stopPromise) return video.stopPromise;
    video.stopping = true;
    if (video.renderer && !video.renderer.isDestroyed()) {
      video.renderer.send('media:native-video-stopping', { sessionId });
    }
    const startedAt = performance.now();
    video.stopPromise = (async () => {
      // 先撤销输入和释放按住的键；画面/GPU 回收再慢也不能继续接受远控。
      const active = mediaHelper.videoCapture;
      const control = active?.sessionId === sessionId ? active.remoteControl : undefined;
      let controlFailure;
      if (control) {
        try { await mediaHelper.clearRemoteControl(sessionId, control.controlSessionId); }
        catch (error) {
          controlFailure = error;
          recordVideoFailure('revokeRemoteControlBeforeVideoStop', error);
        }
      }
      if (recording.active?.videoSessionId === sessionId || recording.replay?.videoSessionId === sessionId) {
        nativeScreenAudio.pausePublishing(sessionId);
        await recording.stopAll().catch(error => {
          void writeMediaDiagnostic({ stage: 'recordingFailed', code: error.message });
        });
      }
      if (nativeScreenAudio.sessionId === sessionId) {
        await nativeScreenAudio.stop(sessionId).catch(() => {});
      }
      nativeVideoTextures.releaseImports(video);
      const deadline = Date.now() + 1_200;
      while ((video.imported.size || video.pendingSlotReleases.size) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (video.imported.size || video.pendingSlotReleases.size) {
        void writeMediaDiagnostic({ stage: 'screenTextureReleaseTimeout',
          importedCount: video.imported.size, pendingReleaseCount: video.pendingSlotReleases.size });
        // 外部纹理未归还时不复用宿主；退出确认后才释放来源并允许下一次共享。
        await obsCaptureHost.shutdown(true, 'textureTimeout');
        await stopObsVideo(video);
        void writeMediaDiagnostic({ stage: 'screenVideoStopRecovered' });
      } else {
        await stopObsVideo(video);
      }
      if (controlFailure) throw controlFailure;
      if (nativeVideoSession === video) {
        restoreNativeVideoBackgroundThrottling(video);
        nativeVideoSession = undefined;
      }
      lastStoppedNativeVideoSession = sessionId;
      void writeMediaDiagnostic({ stage: 'screenVideoStopped', durationMs: Math.round(performance.now() - startedAt) });
      return { changed: true };
    })().catch(error => {
      void writeMediaDiagnostic({ stage: 'screenVideoStopFailed',
        code: String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1],
        durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    });
    return video.stopPromise;
  }

  async function switchNativeGameVideo(gameFollowId, sourceId, maxFps, settings, resolution) {
    const leagueCaptureFollow = getGameFollow();
    const follow = leagueCaptureFollow.require(gameFollowId);
    if (![30, 60, 120].includes(maxFps) || !settings || typeof settings.hideCursor !== 'boolean'
        || typeof settings.hideBorder !== 'boolean' || !['auto', undefined].includes(settings.windowMethod)
        || !resolution || ![720, 1080, 1440].includes(resolution.height) || resolution.width !== resolution.height * 16 / 9) {
      throw new Error('nativeGameFollowTargetInvalid');
    }
    if (follow.switching) throw new Error('nativeGameFollowBusy');
    follow.switching = true;
    const startedAt = performance.now();
    try {
      const selected = await leagueCaptureFollow.findSource(gameFollowId);
      if (selected.sourceId !== sourceId) throw new Error('nativeGameFollowTargetInvalid');
      const old = nativeVideoSession;
      if (old) {
        if (old.gameFollowId !== gameFollowId) throw new Error('nativeGameFollowUnavailable');
        await stopNativeVideo(old.sessionId, true);
      }
      if (isClosing() || leagueCaptureFollow.require(gameFollowId) !== follow) throw new Error('nativeGameFollowUnavailable');
      void writeMediaDiagnostic({ stage: 'gameFollowSourceSwitch' });
      const started = await startNativeVideo(sourceId, maxFps, { ...settings, followGame: 'league' }, resolution, gameFollowId);
      void writeMediaDiagnostic({ stage: 'gameFollowSourceSwitched', durationMs: Math.round(performance.now() - startedAt) });
      return started;
    } catch (error) {
      if (follow.cancelled || isClosing()) {
        void writeMediaDiagnostic({ stage: 'gameFollowSwitchCancelled' });
        throw error;
      }
      const code = ['nativeGameFollowUnavailable', 'nativeGameFollowTargetInvalid', 'nativeGameFollowTargetAmbiguous',
        'nativeGameFollowBusy', 'captureTargetClosed'].includes(error.message) ? error.message : 'nativeGameFollowFailed';
      void writeMediaDiagnostic({ stage: 'gameFollowSwitchFailed', code,
        durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    } finally { follow.switching = false; }
  }

  return { prepare: prepareNativeVideoSource, start: startNativeVideo, stop: stopNativeVideo,
    switchGame: switchNativeGameVideo, notifyFailure: notifyNativeVideoError, suspend: handleVideoCaptureSuspended,
    receiveFrame: nativeVideoTextures.receiveFrame, releaseHost: nativeVideoTextures.releaseHost,
    get current() { return nativeVideoSession; } };
}

module.exports = { createNativeVideoSession };

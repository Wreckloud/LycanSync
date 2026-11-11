// 负责 Electron 纹理引用和宿主句柄；会话停止必须等待接收方释放，不能提前复用槽位。
function createNativeVideoTextures({ getVideo, getBridge, getWindow, sharedTexture,
  writeDiagnostic: writeMediaDiagnostic, recordFailure: recordVideoFailure, notifyFailure: notifyNativeVideoError }) {
  const helperProcessBridges = new WeakMap();

  function releaseHelperProcessBridge(state) {
    const bridge = helperProcessBridges.get(state);
    if (!bridge) return;
    bridge.release();
    helperProcessBridges.delete(state);
  }

  function releaseNativeVideoImports(video) {
    for (const imported of video.imported.values()) {
      try { imported.release(); } catch { /* Electron may already have released this import. */ }
    }
    // 主进程引用释放不等于 GPU 已用完；保留槽位登记，直到 allReferencesReleased 删除。
  }

  function releaseNativeVideoSlot(state, sessionId, slotIndex) {
    return state.releaseSharedTextureSlot(sessionId, slotIndex);
  }

  function handleNativeSharedTextureFrame(state, frame) {
    const video = getVideo();
    if (!video || video.sessionId !== frame.sessionId || video.stopping || video.suspended) {
      if (video && video.sessionId === frame.sessionId) {
        void releaseNativeVideoSlot(state, frame.sessionId, frame.slotIndex).catch(() => {});
      }
      return;
    }
    video.helperState = state;
    if (!video.sourceFrameReceived) {
      video.sourceFrameReceived = true;
      void writeMediaDiagnostic({ stage: 'obsSourceFirstFrame', durationMs: Math.round(performance.now() - video.startedAt) });
    }
    video.frameWidth = frame.contentSize.width;
    video.frameHeight = frame.contentSize.height;
    let helperBridge = helperProcessBridges.get(state);
    let owned;
    let imported;
    let importStage = 'loadBridge';
    let importRegistered = false;
    let releaseBeforeRegistration = false;
    let slotReleaseStarted = false;
    let mainReferenceReleased = false;
    let transferPending = false;
    const releaseImport = () => {
      // Electron 确认交付时才登记接收方引用，提前释放会让迟到确认找不到纹理。
      if (!imported || mainReferenceReleased || transferPending) return;
      // 正常交付和停止清理可能先后到达，同一主进程引用只能归还一次。
      mainReferenceReleased = true;
      imported.release();
    };
    const releaseSlot = () => {
      if (slotReleaseStarted) return;
      if (!importRegistered) {
        releaseBeforeRegistration = true;
        return;
      }
      slotReleaseStarted = true;
      video.imported.delete(frame.slotIndex);
      if (state.alive && !state.closed) {
        video.pendingSlotReleases.add(frame.slotIndex);
        void releaseNativeVideoSlot(state, video.sessionId, frame.slotIndex).catch((error) => {
          if (getVideo() !== video) return;
          if (!video.failureNotified) recordVideoFailure('releaseTextureSlot', error, frame);
          notifyNativeVideoError(video, 'sharedTextureSlotReleaseFailed');
        }).finally(() => video.pendingSlotReleases.delete(frame.slotIndex));
      }
    };
    try {
      const nativeMediaBridge = getBridge();
      if (!helperBridge) {
        importStage = 'openHelper';
        helperBridge = nativeMediaBridge.openSpawnedMediaHelper(state.child.pid, state.executablePath);
        helperProcessBridges.set(state, helperBridge);
      }
      importStage = 'validateTexturePool';
      if (video.imported.has(frame.slotIndex) || video.imported.size >= 3) {
        throw new Error('sharedTexturePoolInvariantFailed');
      }
      importStage = 'duplicateHandle';
      owned = helperBridge.duplicateSharedTexture(frame.sourceHandleHex);
      importStage = 'importTexture';
      imported = owned.withImportHandle((ntHandle) => sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: frame.pixelFormat,
          codedSize: frame.codedSize,
          visibleRect: { x: 0, y: 0, width: frame.contentSize.width, height: frame.contentSize.height },
          timestamp: frame.timestampMicros,
          handle: { ntHandle },
        },
        allReferencesReleased: releaseSlot,
      }));
      owned.release();
      if (releaseBeforeRegistration) {
        importRegistered = true;
        releaseSlot();
        releaseImport();
        return;
      }
      video.imported.set(frame.slotIndex, { release: releaseImport });
      importRegistered = true;
      importStage = 'sendTexture';
      transferPending = true;
      void sharedTexture.sendSharedTexture({
        frame: video.renderer.mainFrame,
        importedSharedTexture: imported,
      }, 'native-screen-frame', video.sessionId).then(() => {
        transferPending = false;
        releaseImport();
        if (!video.textureDelivered && !video.stopping && getVideo() === video) {
          video.textureDelivered = true;
          void writeMediaDiagnostic({ stage: 'screenTextureDelivered', durationMs: Math.round(performance.now() - video.startedAt) });
        }
      }).catch((error) => {
        transferPending = false;
        const code = /^transfer shared texture timed out after 1000ms,/.test(String(error?.message))
          ? 'sharedTextureTransferTimedOut' : 'sharedTextureTransferFailed';
        if (!video.failureNotified && !video.stopping && getVideo() === video) {
          const mainWindow = getWindow();
          const rendererAlive = !video.renderer.isDestroyed();
          recordVideoFailure('sendTexture', error, frame, { code,
            rendererAlive,
            ...(rendererAlive ? { rendererLoading: video.renderer.isLoadingMainFrame(),
              backgroundThrottling: video.renderer.getBackgroundThrottling() } : {}),
            ...(mainWindow && !mainWindow.isDestroyed() ? { windowMinimized: mainWindow.isMinimized(),
              windowVisible: mainWindow.isVisible() } : {}),
            importedCount: video.imported.size, pendingReleaseCount: video.pendingSlotReleases.size });
        }
        releaseImport();
        // 超时后可能仍有迟到交付；由原有停止流程回收，不能直接重发或复用槽位。
        if (!video.stopping && getVideo() === video) notifyNativeVideoError(video, code);
      });
    } catch (error) {
      transferPending = false;
      // 每次采集只保存首次失败；不记录纹理句柄、窗口标题或账号凭据。
      if (!video.failureNotified) recordVideoFailure(importStage, error, frame);
      owned?.release();
      if (imported) releaseImport();
      else void releaseNativeVideoSlot(state, video.sessionId, frame.slotIndex).catch(() => {});
      notifyNativeVideoError(video, 'sharedTextureImportFailed');
    }
  }

  return { receiveFrame: handleNativeSharedTextureFrame, releaseImports: releaseNativeVideoImports,
    releaseHost: releaseHelperProcessBridge };
}

module.exports = { createNativeVideoTextures };

const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

if (process.platform === 'win32') contextBridge.exposeInMainWorld('lycanAudioShortcuts', {
  begin: () => ipcRenderer.invoke('audio-shortcuts:begin'),
  configure: (owner, bindings, pushToTalk) => ipcRenderer.invoke('audio-shortcuts:configure', owner, bindings, pushToTalk),
  readHold: (owner, roomId, sequence) => ipcRenderer.invoke('audio-shortcuts:hold', owner, roomId, sequence),
  onHold: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('audio-shortcuts:hold', listener);
    return () => ipcRenderer.removeListener('audio-shortcuts:hold', listener);
  },
  activate: (owner, roomId) => ipcRenderer.invoke('audio-shortcuts:activate', owner, roomId),
  capture: (owner, enabled) => ipcRenderer.invoke('audio-shortcuts:capture', owner, enabled),
  end: owner => ipcRenderer.invoke('audio-shortcuts:end', owner),
  onAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('audio-shortcuts:action', listener);
    return () => ipcRenderer.removeListener('audio-shortcuts:action', listener);
  },
  onError: callback => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on('audio-shortcuts:error', listener);
    return () => ipcRenderer.removeListener('audio-shortcuts:error', listener);
  },
});

contextBridge.exposeInMainWorld('lycanVoiceOverlay', {
  begin: () => ipcRenderer.invoke('voice-overlay:begin'),
  configure: (owner, settings) => ipcRenderer.invoke('voice-overlay:configure', owner, settings),
  update: (owner, snapshot) => ipcRenderer.invoke('voice-overlay:update', owner, snapshot),
  edit: (owner, enabled) => ipcRenderer.invoke('voice-overlay:edit', owner, enabled),
  end: (owner) => ipcRenderer.invoke('voice-overlay:end', owner),
  displays: () => ipcRenderer.invoke('voice-overlay:displays'),
  onError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('voice-overlay:error', listener);
    return () => ipcRenderer.removeListener('voice-overlay:error', listener);
  },
  onPlacement: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('voice-overlay:placement', listener);
    return () => ipcRenderer.removeListener('voice-overlay:placement', listener);
  },
  onEditingChange: (callback) => {
    const listener = (_event, editing) => callback(editing);
    ipcRenderer.on('voice-overlay:editing', listener);
    return () => ipcRenderer.removeListener('voice-overlay:editing', listener);
  },
});

let nativeVideoSurface;
let stoppedNativeVideoSessionId;
let suspendedNativeVideoSessionId;

function releaseNativeVideoCanvas(sessionId) {
  if (!nativeVideoSurface || nativeVideoSurface.sessionId !== sessionId) return;
  nativeVideoSurface.canvas.width = 0;
  nativeVideoSurface.canvas.height = 0;
  nativeVideoSurface = undefined;
}

function stopReceivingNativeVideo(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  stoppedNativeVideoSessionId = sessionId;
  releaseNativeVideoCanvas(sessionId);
}

function copyNativeVideoFrame(frame, sessionId) {
  const width = frame.visibleRect?.width ?? frame.displayWidth;
  const height = frame.visibleRect?.height ?? frame.displayHeight;
  if (nativeVideoSurface && nativeVideoSurface.sessionId !== sessionId) releaseNativeVideoCanvas(nativeVideoSurface.sessionId);
  if (!nativeVideoSurface || nativeVideoSurface.width !== width || nativeVideoSurface.height !== height) {
    // 1080p 共享的下层按 1/3 和 2/3 缩放；缩成小窗时已有三层会用 1/4 和 1/2。
    // 让缩小后的画面也有偶数像素，避免 H.264 再次裁边或切换软编。
    const shortSide = Math.min(width, height);
    const previewDivisor = Math.round((shortSide + shortSide % 2) / 360);
    const alignment = shortSide >= 960 && shortSide <= 1080 ? 6 : previewDivisor === 2 ? 8 : 2;
    const canvasWidth = Math.ceil(width / alignment) * alignment;
    const canvasHeight = Math.ceil(height / alignment) * alignment;
    if (!nativeVideoSurface) {
      const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('nativeVideoCanvasUnavailable');
      nativeVideoSurface = { sessionId, canvas, context, width, height };
    } else {
      const { canvas, context } = nativeVideoSurface;
      if (canvas.width === canvasWidth && canvas.height === canvasHeight) {
        // 相邻尺寸可能复用同一画布；上帧右边或下边的内容不能留在补边里。
        if (width < nativeVideoSurface.width) context.clearRect(width, 0, canvasWidth - width, canvasHeight);
        if (height < nativeVideoSurface.height) context.clearRect(0, height, canvasWidth, canvasHeight - height);
      } else {
        if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
        if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
      }
      nativeVideoSurface.width = width;
      nativeVideoSurface.height = height;
    }
  }
  // 当前 Electron 的外部纹理直接进入视频轨道会卡住；画布快照隔开两边的资源归属。
  nativeVideoSurface.context.drawImage(frame, 0, 0, width, height);
  return new VideoFrame(nativeVideoSurface.canvas, { timestamp: frame.timestamp });
}

sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }, token, sessionId) => {
  let frame;
  let copiedFrame;
  try {
    if (token !== 'native-screen-frame' || typeof sessionId !== 'string' || !sessionId
        || sessionId === stoppedNativeVideoSessionId || sessionId === suspendedNativeVideoSessionId) return;
    frame = importedSharedTexture.getVideoFrame();
    copiedFrame = copyNativeVideoFrame(frame, sessionId);
    window.postMessage({ type: 'lycan-native-screen-frame', sessionId, frame: copiedFrame }, '*', [copiedFrame]);
    copiedFrame = undefined;
  } catch (error) {
    releaseNativeVideoCanvas(sessionId);
    ipcRenderer.send('media:native-video:receiver-error', {
      sessionId, message: String(error?.message ?? error).slice(0, 2000),
    });
  } finally {
    copiedFrame?.close();
    frame?.close();
    importedSharedTexture.release();
  }
});

ipcRenderer.on('media:native-video-error', (_event, failure) => stopReceivingNativeVideo(failure?.sessionId));
ipcRenderer.on('media:native-video-stopping', (_event, status) => stopReceivingNativeVideo(status?.sessionId));
ipcRenderer.on('media:native-video-suspended', (_event, status) => {
  if (status?.suspended) {
    suspendedNativeVideoSessionId = status.sessionId;
    releaseNativeVideoCanvas(status.sessionId);
  } else if (suspendedNativeVideoSessionId === status?.sessionId) suspendedNativeVideoSessionId = undefined;
});

// 只暴露固定操作，不向页面开放 Node.js 或任意 IPC 通道。
contextBridge.exposeInMainWorld('lycanDesktop', {
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  runStartupUpdate: () => ipcRenderer.invoke('update:startup'),
  getUpdateState: () => ipcRenderer.invoke('update:state:get'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  restartForUpdate: () => ipcRenderer.invoke('update:restart'),
  skipStartupUpdate: () => ipcRenderer.invoke('update:skip'),
  reportStartupTiming: (stage, durationMs) => ipcRenderer.send('app:startup-timing', stage, durationMs),
  reportVoiceJoinTiming: (timing) => ipcRenderer.send('media:voice-join-timing', timing),
  reportCapturePickerTiming: (stage, durationMs, details) => ipcRenderer.send('media:screen-picker-timing', stage, durationMs, details),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  clearSession: () => ipcRenderer.invoke('auth:clear'),
  returnToAccountEntry: () => ipcRenderer.invoke('auth:return'),
  getAutoLogin: (accountId) => ipcRenderer.invoke('auth:auto-login:get', accountId),
  setAutoLogin: (accountId, enabled, manualEntryRequired) => ipcRenderer.invoke('auth:auto-login:set', accountId, enabled, manualEntryRequired),
  getAccessLink: () => ipcRenderer.invoke('auth:access:get'),
  openQqLogin: (url) => ipcRenderer.invoke('auth:qq:open', url),
  onQqLogin: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('auth:qq:complete', listener);
    return () => ipcRenderer.removeListener('auth:qq:complete', listener);
  },
  parseAccessLink: (value) => ipcRenderer.invoke('auth:access:parse', value),
  prepareAccessLink: (offer) => ipcRenderer.invoke('auth:access:prepare', offer),
  onAccessLink: (callback) => {
    const listener = (_event, offer) => callback(offer);
    ipcRenderer.on('auth:access:offer', listener);
    return () => ipcRenderer.removeListener('auth:access:offer', listener);
  },
  getServerSettings: () => ipcRenderer.invoke('settings:server:get'),
  setServerAddress: (value) => ipcRenderer.invoke('settings:server:set', value),
  minimize: () => ipcRenderer.send('window:minimize'),
  getWindowVisibility: () => ipcRenderer.invoke('window:visibility'),
  focusViewerWindow: (id) => ipcRenderer.invoke('viewer:focus', id),
  onWindowVisibility: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on('window:visibility', listener);
    return () => ipcRenderer.removeListener('window:visibility', listener);
  },
  onViewerClosed: (callback) => {
    const listener = (_event, closed) => callback(closed);
    ipcRenderer.on('viewer:closed', listener);
    return () => ipcRenderer.removeListener('viewer:closed', listener);
  },
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  prepareCapture: (graphics = false) => ipcRenderer.invoke('capture:prepare', graphics),
  getRecordingSettings: () => ipcRenderer.invoke('recording:settings'),
  configureRecording: (settings) => ipcRenderer.invoke('recording:configure', settings),
  saveDirectory: (kind, action) => ipcRenderer.invoke('settings:save-directory', kind, action),
  failRecordingVoice: (id) => ipcRenderer.invoke('recording:voice-failed', id),
  sendRecordingVoice: (id, position, pcm) => ipcRenderer.invoke('recording:voice', id, position, pcm),
  startRecording: (previousId) => ipcRenderer.invoke('recording:start', previousId),
  stopRecording: (id) => ipcRenderer.invoke('recording:stop', id),
  startReplay: () => ipcRenderer.invoke('recording:replay-start'),
  saveReplay: () => ipcRenderer.invoke('recording:replay-save'),
  stopReplay: () => ipcRenderer.invoke('recording:replay-stop'),
  configureReplay: (settings) => ipcRenderer.invoke('recording:replay-settings', settings),
  getRecordingStatus: () => ipcRenderer.invoke('recording:status'),
  getRecordingFrameRate: id => ipcRenderer.invoke('recording:frame-rate', id),
  exportRecordingClip: (requestId, id, startMs, endMs) => ipcRenderer.invoke('recording:clip', requestId, id, startMs, endMs),
  cancelRecordingClip: requestId => ipcRenderer.invoke('recording:clip-cancel', requestId),
  onRecordingClipProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('recording:clip-progress', listener);
    return () => ipcRenderer.removeListener('recording:clip-progress', listener);
  },
  updateRecordingDuration: (id, durationMs) => ipcRenderer.invoke('recording:duration', id, durationMs),
  getRecordingLibrary: (offset, kind) => ipcRenderer.invoke('recording:library', offset, kind),
  recordingFile: (id, action) => ipcRenderer.invoke('recording:file', id, action),
  onRecordingState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('recording:state', listener);
    return () => ipcRenderer.removeListener('recording:state', listener);
  },
  getProcessMetrics: () => ipcRenderer.invoke('diagnostics:process-metrics'),
  downloadChatFile: async (id, path, name, size, onProgress) => {
    const listener = (_event, jobId, bytes) => { if (jobId === id) onProgress(bytes); };
    ipcRenderer.on('chat:download-progress', listener);
    try { return await ipcRenderer.invoke('chat:download', id, path, name, size); }
    finally { ipcRenderer.removeListener('chat:download-progress', listener); }
  },
  cancelChatDownload: id => ipcRenderer.send('chat:cancel-download', id),
  exportDiagnosticReport: report => ipcRenderer.invoke('diagnostics:export', report),
  prepareDiagnosticUpload: report => ipcRenderer.invoke('diagnostics:prepare-upload', report),
  cleanDiagnosticCopies: () => ipcRenderer.invoke('diagnostics:clean-copies'),
  diagnosticFile: (id, action) => ipcRenderer.invoke('diagnostics:file', id, action),
  cancelDiagnosticFile: () => ipcRenderer.send('diagnostics:cancel-file'),
  saveDiagnosticSnapshot: (report) => ipcRenderer.invoke('diagnostics:checkpoint', report),
  getSavedDiagnosticReport: () => ipcRenderer.invoke('diagnostics:saved'),
  clearSavedDiagnosticReports: () => ipcRenderer.invoke('diagnostics:clear-saved'),
  getSystemIdleState: () => ipcRenderer.invoke('presence:system-idle-state'),
  getAutoStart: () => ipcRenderer.invoke('settings:auto-start:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:auto-start:set', enabled),
  getTraySettings: () => ipcRenderer.invoke('settings:tray:get'),
  setCloseToTray: (enabled) => ipcRenderer.invoke('settings:tray:set', enabled),
  getCurrentActivity: () => ipcRenderer.invoke('activity:current'),
  listActivityWindows: () => ipcRenderer.invoke('activity:windows'),
  configureActivityMappings: (mappings, selectedExecutable) => ipcRenderer.invoke('activity:configure', mappings, selectedExecutable),
  getNativeMediaCapabilities: () => ipcRenderer.invoke('media:capabilities'),
  listNativeVideoSources: () => ipcRenderer.invoke('media:video-sources'),
  prepareNativeVideoSource: (sourceId) => ipcRenderer.invoke('media:video-source:prepare', sourceId),
  getNativeVideoSourceThumbnails: (sources) => ipcRenderer.invoke('media:video-source-thumbnails', sources),
  getScreenShareSupport: () => ipcRenderer.invoke('settings:screen-share:support'),
  startNativeVideo: (sourceId, maxFps, settings, resolution, discoveryId) => ipcRenderer.invoke('media:native-video:start', sourceId, maxFps, settings, resolution, discoveryId),
  findNativeGameSource: (id) => ipcRenderer.invoke('media:game-follow:source', id),
  switchNativeGameVideo: (id, sourceId, maxFps, settings, resolution) => {
    stopReceivingNativeVideo(nativeVideoCanvasSessionId);
    return ipcRenderer.invoke('media:game-follow:switch', id, sourceId, maxFps, settings, resolution);
  },
  endNativeGameFollow: (id) => ipcRenderer.invoke('media:game-follow:end', id),
  recordScreenShareStartupTiming: (sessionId, stage, durationMs, audioTiming) =>
    ipcRenderer.send('media:screen-share-startup', sessionId, stage, durationMs, audioTiming),
  stopNativeVideo: async (sessionId) => {
    // 等待主进程清理时，迟到帧只能归还纹理，不能重建持有最后一帧的画布。
    stopReceivingNativeVideo(sessionId);
    try { return await ipcRenderer.invoke('media:native-video:stop', sessionId); }
    finally { releaseNativeVideoCanvas(sessionId); }
  },
  configureNativeVideo: (sessionId, maxFps, resolution, deliveryOnly = false) => ipcRenderer.invoke('media:native-video:configure', sessionId, maxFps, resolution, deliveryOnly),
  authorizeNativeRemoteControl: (sessionId, controlSessionId, controllerIdentity) =>
    ipcRenderer.invoke('media:remote-control:authorize', sessionId, controlSessionId, controllerIdentity),
  sendNativeRemoteInput: (sessionId, controlSessionId, controllerIdentity, sequence, input) =>
    ipcRenderer.invoke('media:remote-control:input', sessionId, controlSessionId, controllerIdentity, sequence, input),
  revokeNativeRemoteControl: (sessionId, controlSessionId) =>
    ipcRenderer.invoke('media:remote-control:revoke', sessionId, controlSessionId),
  onNativeVideoError: (callback) => {
    const listener = (_event, failure) => callback(failure);
    ipcRenderer.on('media:native-video-error', listener);
    return () => ipcRenderer.removeListener('media:native-video-error', listener);
  },
  onNativeVideoSuspended: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('media:native-video-suspended', listener);
    return () => ipcRenderer.removeListener('media:native-video-suspended', listener);
  },
  listApplicationAudioSources: () => ipcRenderer.invoke('media:application-audio:sources'),
  startApplicationAudio: (sourceId, publicationId) => ipcRenderer.invoke('media:application-audio:start', sourceId, publicationId),
  startNativeScreenAudio: (sourceId, sessionId, publicationId) => ipcRenderer.invoke('media:native-screen-audio:start', sourceId, sessionId, publicationId),
  stopNativeScreenAudio: (sessionId) => ipcRenderer.invoke('media:native-screen-audio:stop', sessionId),
  onNativeScreenAudioChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('media:native-screen-audio-frame', listener);
    return () => ipcRenderer.removeListener('media:native-screen-audio-frame', listener);
  },
  acknowledgeNativeScreenAudioChunk: (sessionId, sequence, droppedChunks) =>
    ipcRenderer.send('media:native-screen-audio:consumed', sessionId, sequence, droppedChunks),
  onNativeScreenAudioError: (callback) => {
    const listener = (_event, failure) => callback(failure);
    ipcRenderer.on('media:native-screen-audio-error', listener);
    return () => ipcRenderer.removeListener('media:native-screen-audio-error', listener);
  },
  setMicrophoneEchoOutput: selector => ipcRenderer.invoke('media:microphone-echo-output', selector),
  listMicrophoneDevices: () => ipcRenderer.invoke('media:microphone-devices'),
  startNativeMicrophone: (sessionId, settings, deviceId, pushToTalk) => ipcRenderer.invoke('media:native-microphone:start', sessionId, settings, deviceId, pushToTalk),
  setNativeMicrophoneTransmission: (sessionId, pushToTalk, held, epoch) => ipcRenderer.send('media:native-microphone:transmission', sessionId, pushToTalk, held, epoch),
  configureNativeMicrophone: (sessionId, settings) => ipcRenderer.invoke('media:native-microphone:configure', sessionId, settings),
  stopNativeMicrophone: (sessionId) => ipcRenderer.invoke('media:native-microphone:stop', sessionId),
  onNativeMicrophoneChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('media:native-microphone-frame', listener);
    return () => ipcRenderer.removeListener('media:native-microphone-frame', listener);
  },
  acknowledgeNativeMicrophoneChunk: (sessionId, sequence, droppedChunks, workletDropped) =>
    ipcRenderer.send('media:native-microphone:consumed', sessionId, sequence, droppedChunks, workletDropped),
  onNativeMicrophoneError: (callback) => {
    const listener = (_event, failure) => callback(failure);
    ipcRenderer.on('media:native-microphone-error', listener);
    return () => ipcRenderer.removeListener('media:native-microphone-error', listener);
  },
  getNativeMediaDiagnostics: () => ipcRenderer.invoke('media:diagnostics'),
  onActivityChange: (callback) => {
    const listener = (_event, activity) => callback(activity);
    ipcRenderer.on('activity:changed', listener);
    return () => ipcRenderer.removeListener('activity:changed', listener);
  },
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
  close: () => ipcRenderer.send('window:close'),
  finishClose: () => ipcRenderer.send('window:closed-media'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  onClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:release-media', listener);
    return () => ipcRenderer.removeListener('window:release-media', listener);
  },
});

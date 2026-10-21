const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

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

let nativeVideoCanvas;
let nativeVideoContext;
let nativeVideoCanvasSessionId;

function releaseNativeVideoCanvas(sessionId) {
  if (!nativeVideoCanvas || nativeVideoCanvasSessionId !== sessionId) return;
  nativeVideoCanvas.width = 0;
  nativeVideoCanvas.height = 0;
  nativeVideoCanvas = undefined;
  nativeVideoContext = undefined;
  nativeVideoCanvasSessionId = undefined;
}

function copyNativeVideoFrame(frame, sessionId) {
  const width = frame.visibleRect?.width ?? frame.displayWidth;
  const height = frame.visibleRect?.height ?? frame.displayHeight;
  if (nativeVideoCanvasSessionId !== sessionId) releaseNativeVideoCanvas(nativeVideoCanvasSessionId);
  if (!nativeVideoCanvas) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('nativeVideoCanvasUnavailable');
    nativeVideoCanvas = canvas;
    nativeVideoContext = context;
    nativeVideoCanvasSessionId = sessionId;
  }
  if (nativeVideoCanvas.width !== width) nativeVideoCanvas.width = width;
  if (nativeVideoCanvas.height !== height) nativeVideoCanvas.height = height;
  // 当前 Electron 的外部纹理直接进入视频轨道会卡住；画布快照隔开两边的资源归属。
  nativeVideoContext.drawImage(frame, 0, 0, width, height);
  return new VideoFrame(nativeVideoCanvas, { timestamp: frame.timestamp });
}

sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }, token, sessionId) => {
  let frame;
  let copiedFrame;
  try {
    if (token !== 'native-screen-frame' || typeof sessionId !== 'string' || !sessionId) return;
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

ipcRenderer.on('media:native-video-error', (_event, failure) => releaseNativeVideoCanvas(failure?.sessionId));
ipcRenderer.on('media:native-video-suspended', (_event, status) => {
  if (status?.suspended) releaseNativeVideoCanvas(status.sessionId);
});

// 只暴露固定操作，不向页面开放 Node.js 或任意 IPC 通道。
contextBridge.exposeInMainWorld('lycanDesktop', {
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  runStartupUpdate: () => ipcRenderer.invoke('update:startup'),
  getUpdateState: () => ipcRenderer.invoke('update:state:get'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  restartForUpdate: () => ipcRenderer.invoke('update:restart'),
  skipStartupUpdate: () => ipcRenderer.invoke('update:skip'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  clearSession: () => ipcRenderer.invoke('auth:clear'),
  getAccessLink: () => ipcRenderer.invoke('auth:access:get'),
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
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  setWindowLayout: (mode, height) => ipcRenderer.invoke('window:layout', mode, height),
  getProcessMetrics: () => ipcRenderer.invoke('diagnostics:process-metrics'),
  exportDiagnosticReport: (report) => ipcRenderer.invoke('diagnostics:export', report),
  getSystemIdleState: () => ipcRenderer.invoke('presence:system-idle-state'),
  getAutoStart: () => ipcRenderer.invoke('settings:auto-start:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:auto-start:set', enabled),
  getCurrentActivity: () => ipcRenderer.invoke('activity:current'),
  listActivityWindows: () => ipcRenderer.invoke('activity:windows'),
  configureActivityMappings: (mappings) => ipcRenderer.invoke('activity:configure', mappings),
  getNativeMediaCapabilities: () => ipcRenderer.invoke('media:capabilities'),
  listNativeVideoSources: () => ipcRenderer.invoke('media:video-sources'),
  getNativeVideoSourceThumbnails: (sources) => ipcRenderer.invoke('media:video-source-thumbnails', sources),
  getScreenShareSupport: () => ipcRenderer.invoke('settings:screen-share:support'),
  startNativeVideo: (sourceId, maxFps, settings, resolution) => ipcRenderer.invoke('media:native-video:start', sourceId, maxFps, settings, resolution),
  recordScreenShareStartupTiming: (sessionId, stage, durationMs, audioTiming) =>
    ipcRenderer.send('media:screen-share-startup', sessionId, stage, durationMs, audioTiming),
  stopNativeVideo: async (sessionId) => {
    // 停止等待前释放画布；清理期间迟到的旧帧也不能留下缓存或影响新会话。
    releaseNativeVideoCanvas(sessionId);
    try { return await ipcRenderer.invoke('media:native-video:stop', sessionId); }
    finally { releaseNativeVideoCanvas(sessionId); }
  },
  configureNativeVideo: (sessionId, maxFps, resolution) => ipcRenderer.invoke('media:native-video:configure', sessionId, maxFps, resolution),
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
  startNativeScreenAudio: (sourceId, sessionId) => ipcRenderer.invoke('media:native-screen-audio:start', sourceId, sessionId),
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
  startNativeMicrophone: (sessionId, settings) => ipcRenderer.invoke('media:native-microphone:start', sessionId, settings),
  configureNativeMicrophone: (sessionId, settings) => ipcRenderer.invoke('media:native-microphone:configure', sessionId, settings),
  stopNativeMicrophone: (sessionId) => ipcRenderer.invoke('media:native-microphone:stop', sessionId),
  onNativeMicrophoneChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('media:native-microphone-frame', listener);
    return () => ipcRenderer.removeListener('media:native-microphone-frame', listener);
  },
  acknowledgeNativeMicrophoneChunk: (sessionId, sequence, droppedChunks) =>
    ipcRenderer.send('media:native-microphone:consumed', sessionId, sequence, droppedChunks),
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

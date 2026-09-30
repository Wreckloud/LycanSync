const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }, token) => {
  let frame;
  try {
    if (token !== 'native-screen-frame') return;
    frame = importedSharedTexture.getVideoFrame();
    window.postMessage({ type: 'lycan-native-screen-frame', frame }, '*', [frame]);
    frame = undefined;
  } catch {
    ipcRenderer.send('media:native-video:receiver-error');
  } finally {
    frame?.close();
    importedSharedTexture.release();
  }
});

// 只暴露固定操作，不向页面开放 Node.js 或任意 IPC 通道。
contextBridge.exposeInMainWorld('lycanDesktop', {
  clearSession: () => ipcRenderer.invoke('auth:clear'),
  minimize: () => ipcRenderer.send('window:minimize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  getProcessMetrics: () => ipcRenderer.invoke('diagnostics:process-metrics'),
  getSystemIdleState: () => ipcRenderer.invoke('presence:system-idle-state'),
  getAutoStart: () => ipcRenderer.invoke('settings:auto-start:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:auto-start:set', enabled),
  getCurrentActivity: () => ipcRenderer.invoke('activity:current'),
  getNativeMediaCapabilities: () => ipcRenderer.invoke('media:capabilities'),
  listNativeVideoSources: () => ipcRenderer.invoke('media:video-sources'),
  getNativeVideoSourceThumbnails: (sources) => ipcRenderer.invoke('media:video-source-thumbnails', sources),
  startNativeCaptureProbe: (sourceId) => ipcRenderer.invoke('media:capture-probe:start', sourceId),
  stopNativeCaptureProbe: (sessionId) => ipcRenderer.invoke('media:capture-probe:stop', sessionId),
  startNativeVideo: (sourceId, maxFps) => ipcRenderer.invoke('media:native-video:start', sourceId, maxFps),
  stopNativeVideo: (sessionId) => ipcRenderer.invoke('media:native-video:stop', sessionId),
  onNativeVideoError: (callback) => {
    const listener = (_event, code) => callback(code);
    ipcRenderer.on('media:native-video-error', listener);
    return () => ipcRenderer.removeListener('media:native-video-error', listener);
  },
  startNativeScreenAudio: (sourceId, sessionId) => ipcRenderer.invoke('media:native-screen-audio:start', sourceId, sessionId),
  stopNativeScreenAudio: (sessionId) => ipcRenderer.invoke('media:native-screen-audio:stop', sessionId),
  onNativeScreenAudioChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('media:native-screen-audio-frame', listener);
    return () => ipcRenderer.removeListener('media:native-screen-audio-frame', listener);
  },
  acknowledgeNativeScreenAudioChunk: (sequence, droppedChunks) =>
    ipcRenderer.send('media:native-screen-audio:consumed', sequence, droppedChunks),
  onNativeScreenAudioError: (callback) => {
    const listener = (_event, code) => callback(code);
    ipcRenderer.on('media:native-screen-audio-error', listener);
    return () => ipcRenderer.removeListener('media:native-screen-audio-error', listener);
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
  selectSource: (requestId, sourceId) => ipcRenderer.send('capture:select', requestId, sourceId),
  onSources: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('capture:sources', listener);
    return () => ipcRenderer.removeListener('capture:sources', listener);
  },
  onClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:release-media', listener);
    return () => ipcRenderer.removeListener('window:release-media', listener);
  },
});

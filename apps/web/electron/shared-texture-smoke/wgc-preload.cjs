const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, token) => {
  let frame;
  try {
    if (token !== 'wgc-frame') throw new Error('unexpectedSharedTextureMessage');
    frame = importedSharedTexture.getVideoFrame();
    window.postMessage({ type: 'wgc-shared-frame', frame }, '*', [frame]);
  } catch {
    ipcRenderer.send('wgc-smoke:frame-dropped');
  } finally {
    importedSharedTexture.release();
  }
});

contextBridge.exposeInMainWorld('wgcSmoke', {
  start: (sourceId) => ipcRenderer.invoke('wgc-smoke:start', sourceId),
  stop: () => ipcRenderer.invoke('wgc-smoke:stop'),
  onSources: (callback) => {
    const listener = (_event, sources) => callback(sources);
    ipcRenderer.on('wgc-smoke:sources', listener);
    return () => ipcRenderer.removeListener('wgc-smoke:sources', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('wgc-smoke:status', listener);
    return () => ipcRenderer.removeListener('wgc-smoke:status', listener);
  },
  onStopTrack: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('wgc-smoke:stop-renderer-track', listener);
    return () => ipcRenderer.removeListener('wgc-smoke:stop-renderer-track', listener);
  },
  frameWritten: () => ipcRenderer.send('wgc-smoke:frame-written'),
  frameDropped: () => ipcRenderer.send('wgc-smoke:frame-dropped'),
});

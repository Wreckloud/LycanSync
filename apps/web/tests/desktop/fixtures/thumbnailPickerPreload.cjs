const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lycanDesktop', {
  listNativeVideoSources: () => ipcRenderer.invoke('thumbnail-test:sources'),
  getNativeVideoSourceThumbnails: sources => ipcRenderer.invoke('thumbnail-test:images', sources),
  prepareNativeVideoSource: async () => ({ prepared: false }),
  getCurrentActivity: async () => null,
  getScreenShareSupport: async () => ({ hideBorder: false }),
});

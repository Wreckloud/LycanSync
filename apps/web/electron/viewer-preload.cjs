const { contextBridge, ipcRenderer } = require('electron');

// 不直接安装业务、设备或任意 IPC 接口；同源 opener 仍在同一可信脚本边界内。
contextBridge.exposeInMainWorld('lycanViewerWindow', {
  ready: () => ipcRenderer.invoke('viewer:ready'),
  setPinned: (enabled) => ipcRenderer.invoke('viewer:pin', enabled),
  toggleFullscreen: () => ipcRenderer.invoke('viewer:fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('viewer:fullscreen', false),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('viewer:state', listener);
    return () => ipcRenderer.removeListener('viewer:state', listener);
  },
  onDisarm: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('viewer:disarm', listener);
    return () => ipcRenderer.removeListener('viewer:disarm', listener);
  },
});

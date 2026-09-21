const { contextBridge, ipcRenderer } = require('electron');

// 只暴露固定操作，不向页面开放 Node.js 或任意 IPC 通道。
contextBridge.exposeInMainWorld('lycanDesktop', {
  clearSession: () => ipcRenderer.invoke('auth:clear'),
  minimize: () => ipcRenderer.send('window:minimize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  getProcessMetrics: () => ipcRenderer.invoke('diagnostics:process-metrics'),
  getSystemIdleState: () => ipcRenderer.invoke('presence:system-idle-state'),
  getCurrentActivity: () => ipcRenderer.invoke('activity:current'),
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

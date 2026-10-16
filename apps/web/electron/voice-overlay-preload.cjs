const { contextBridge, ipcRenderer } = require('electron');

// 覆盖页仅能接收展示状态和确认就绪，不能操作房间、设备或业务接口。
contextBridge.exposeInMainWorld('lycanOverlayView', {
  ready: () => ipcRenderer.invoke('voice-overlay:ready'),
  onView: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('voice-overlay:view', listener);
    return () => ipcRenderer.removeListener('voice-overlay:view', listener);
  },
});

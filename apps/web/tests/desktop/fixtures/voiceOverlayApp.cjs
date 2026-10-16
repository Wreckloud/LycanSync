const { app, BrowserWindow, ipcMain, net, protocol, screen, session } = require('electron');
const { resolve } = require('node:path');
const { createVoiceOverlay } = require('../../../electron/voice-overlay.cjs');

// 此入口仅启动静态覆盖页与空白测试主窗，不加载登录、RTC、采集或真实业务服务器。
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);
app.whenReady().then(async () => {
  const main = new BrowserWindow({ width: 400, height: 300, show: false });
  await main.loadURL('about:blank');
  const failures = [];
  const manager = createVoiceOverlay({ BrowserWindow, screen, session, net,
    rendererRoot: resolve(__dirname, '../../../dist'), defaultDisplay: () => screen.getPrimaryDisplay().id,
    devRendererUrl: process.env.LYCANSYNC_DEV_RENDERER_URL ? new URL(process.env.LYCANSYNC_DEV_RENDERER_URL) : undefined,
    onError: (message) => failures.push(message), onPlacement: () => {},
    onEditingChange: () => {}, onDiagnostic: () => {},
  });
  manager.initialize();
  ipcMain.handle('voice-overlay:ready', (event) => manager.ready(event));
  const owner = manager.begin();
  global.voiceOverlayTest = { manager, owner, failures, mainId: main.id };
});

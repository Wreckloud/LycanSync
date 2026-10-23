const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { transpileModule, ModuleKind, ScriptTarget } = require('typescript');
const { createScreenShareWindows } = require('../../../electron/screen-share-windows.cjs');

// 仅加载色块与真实 SDK／观看函数，不加载业务主进程、设备或网络房间。
app.setPath('userData', resolve(process.argv[2]));
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
const policy = readFileSync(resolve('electron/main.cjs'), 'utf8')
  .match(/headers\.set\('Content-Security-Policy', "([^"]+)"\)/)?.[1];
if (!policy) throw new Error('未找到正式页面安全策略');
const routes = new Map([
  ['/', ['text/html', '<!doctype html><title>观看窗口验证</title><button id="red">打开红色</button><button id="green">打开绿色</button><script type="module" src="/scenario.js"></script>']],
  ['/scenario.js', ['text/javascript', readFileSync(resolve(__dirname, 'screenShareWindowsRenderer.js'), 'utf8')]],
  ['/sdk.js', ['text/javascript', readFileSync(resolve('node_modules/livekit-client/dist/livekit-client.esm.mjs'), 'utf8')]],
]);
for (const name of ['screenShareViewing', 'localScreenPreview', 'remoteControl']) {
  const source = readFileSync(resolve(`src/rtc/${name}.ts`), 'utf8');
  const script = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } })
    .outputText.replace(/(['"])livekit-client\1/g, "'/sdk.js'");
  routes.set(`/${name}.js`, ['text/javascript', script]);
}
// 直接使用生产构建的观看页、CSS 和入口，不再保留演示页／演示 preload。
routes.set('/viewer.html', ['text/html', readFileSync(resolve('dist/viewer.html'), 'utf8')]);
const viewerAssets = readFileSync(resolve('dist/viewer.html'), 'utf8').matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g);
for (const [, path] of viewerAssets) {
  routes.set(path, [path.endsWith('.css') ? 'text/css' : 'text/javascript', readFileSync(resolve('dist' + path), 'utf8')]);
}

app.whenReady().then(async () => {
  const permissionRequests = [];
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    permissionRequests.push(permission); callback(false);
  });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !request.url.startsWith('lycan://app/') });
  });
  protocol.handle('lycan', (request) => {
    const url = new URL(request.url);
    const route = url.protocol === 'lycan:' && url.host === 'app' && !url.username && !url.password
      && !url.search && routes.get(url.pathname);
    return route ? new Response(route[1], { headers: { 'Content-Type': `${route[0]}; charset=utf-8`, 'Content-Security-Policy': policy } })
      : new Response(null, { status: 404 });
  });
  const main = new BrowserWindow({ width: 480, height: 380, show: true, webPreferences: {
    preload: resolve('electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const children = new Map();
  const manager = createScreenShareWindows();
  manager.attach(main);
  ipcMain.handle('viewer:ready', (event) => manager.ready(event));
  ipcMain.handle('viewer:pin', (event, enabled) => manager.pin(event, enabled));
  ipcMain.handle('viewer:fullscreen', (event, enabled) => manager.fullscreen(event, enabled));
  ipcMain.handle('window:visibility', (event) => {
    if (event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error('来源无效');
    return manager.mainVisible();
  });
  main.setMenu(null);
  main.webContents.on('did-create-window', (child, details) => {
    const key = details.url.endsWith('11111111-1111-4111-8111-111111111111') ? 'viewer-red' : 'viewer-green';
    children.set(key, child);
    child.on('closed', () => children.delete(key));
  });
  main.webContents.on('will-navigate', (event) => event.preventDefault());
  main.webContents.on('will-attach-webview', (event) => event.preventDefault());
  global.screenShareWindowsTest = { main, children, permissionRequests };
  await main.loadURL('lycan://app/');
}).catch((error) => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());

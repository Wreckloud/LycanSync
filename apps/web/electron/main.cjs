const { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, screen, session, safeStorage } = require('electron');
const { resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const APP_ORIGIN = 'lycan://app';
const rendererRoot = resolve(__dirname, '../dist');
const serverConfig = require('./server-config.json');
// 安装版固定使用打包配置；开发模式才允许环境变量临时覆盖。
const backend = new URL(app.isPackaged ? serverConfig.apiUrl
  : process.env.LYCANSYNC_API_URL || serverConfig.apiUrl);
const sessionAuthPaths = new Set(['/api/auth/local/register', '/api/auth/local/login']);
const publicApiPaths = new Set(['/api/system/initialization', ...sessionAuthPaths]);
if (backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash
    || !['http:', 'https:'].includes(backend.protocol)
    || (backend.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname))) {
  throw new Error('LYCANSYNC_API_URL 必须是 HTTPS 服务地址，本机开发可使用 HTTP；不能包含路径或凭据。');
}

app.setName('LycanSync');
// 遵循 Chromium 的独立用户目录参数，便于测试与日常账号数据隔离。
if (app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', resolve(app.commandLine.getSwitchValue('user-data-dir')));
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

let mainWindow;
let pendingCapture;
let closing = false;
let canClose = false;
let closeTimer;
let sessionToken;
let sessionLoaded = false;

async function loadSession() {
  if (sessionLoaded) return sessionToken;
  try {
    const encrypted = await readFile(resolve(app.getPath('userData'), 'session.bin'));
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用。');
    const saved = JSON.parse(safeStorage.decryptString(encrypted));
    // 会话绑定服务地址，不能向另一个部署实例发送旧凭据。
    if (saved.server === backend.origin && /^[A-Za-z0-9_-]{43}$/.test(saved.token)) sessionToken = saved.token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取本机登录凭据，请清理登录状态后重试。');
  }
  sessionLoaded = true;
  return sessionToken;
}

async function saveSession(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，不能保存自动登录凭据。');
  const encrypted = safeStorage.encryptString(JSON.stringify({ server: backend.origin, token }));
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(resolve(app.getPath('userData'), 'session.bin'), encrypted);
  sessionToken = token;
  sessionLoaded = true;
}

async function clearSession() {
  sessionToken = undefined;
  sessionLoaded = true;
  try { await unlink(resolve(app.getPath('userData'), 'session.bin')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function trustedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'lycan:' && url.host === 'app';
  } catch { return false; }
}

function trustedSender(event) {
  return mainWindow && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame && trustedUrl(event.senderFrame.url);
}

function cancelCapture() {
  if (!pendingCapture) return;
  const capture = pendingCapture;
  pendingCapture = undefined;
  denyCapture(capture.callback);
}

function denyCapture(callback) {
  try { callback({}); }
  catch (error) {
    // Electron 已拒绝采集后仍抛出此 TypeError；只兼容取消场景，不吞掉其他异常。
    // TODO: 上游修复后移除此兼容：https://github.com/electron/electron/issues/47980
    if (!(error instanceof TypeError) || error.message !== 'Video was requested, but no video stream was provided') throw error;
  }
}

function finishClose() {
  canClose = true;
  clearTimeout(closeTimer);
  mainWindow?.destroy();
}

// 打包页面与业务接口同源；媒体连接仍由 LiveKit SDK 直接建立，不经此代理。
async function serveApplication(request) {
  const url = new URL(request.url);
  if (!trustedUrl(request.url)) return new Response(null, { status: 403 });
  if (url.pathname.startsWith('/api/')) {
    const allowed = (url.pathname === '/api/rtc/token' && request.method === 'POST')
      || (url.pathname === '/api/rtc/room-summary' && request.method === 'GET')
      || (['/api/system/initialization', '/api/auth/me', '/api/auth/session'].includes(url.pathname)
        && request.method === 'GET')
      || ((sessionAuthPaths.has(url.pathname) || url.pathname === '/api/auth/logout') && request.method === 'POST')
      || (url.pathname === '/api/auth/me' && request.method === 'PUT');
    if (!allowed) return new Response(null, { status: 404 });
    try {
      const body = ['POST', 'PUT'].includes(request.method) ? await request.text() : undefined;
      if (body && body.length > (url.pathname === '/api/auth/me' ? 750000 : 4096)) return new Response(null, { status: 413 });
      const token = await loadSession();
      const publicRequest = publicApiPaths.has(url.pathname);
      const response = await net.fetch(new URL(url.pathname + url.search, backend).href, {
        method: request.method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(!publicRequest && token ? { Authorization: 'Bearer ' + token } : {}) },
        body, redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      });
      if (!publicRequest && token === sessionToken
          && (response.status === 401 || (url.pathname === '/api/auth/logout' && response.ok))) await clearSession();
      if (sessionAuthPaths.has(url.pathname) && response.ok) {
        const result = await response.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.sessionToken ?? '')) throw new Error('登录响应无效');
        await saveSession(result.sessionToken);
        // 会话原文只进入主进程的系统加密存储，不暴露给渲染页面。
        delete result.sessionToken;
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      }
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      } });
    } catch {
      return Response.json({ message: '无法连接业务服务，请检查后端是否已启动。' }, { status: 502 });
    }
  }
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  let file;
  try { file = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { return new Response(null, { status: 400 }); }
  if (!file.startsWith(rendererRoot + sep)) return new Response(null, { status: 403 });
  try {
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; frame-src 'none'; base-uri 'none'");
    return new Response(response.body, { status: response.status, headers });
  } catch { return new Response(null, { status: 404 }); }
}

function configurePermissions() {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (contents !== mainWindow?.webContents || !trustedUrl(origin)) return false;
    if (permission === 'media') return details.mediaType === 'audio';
    return ['display-capture', 'fullscreen'].includes(permission);
  });
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = contents === mainWindow?.webContents && trustedUrl(details.requestingUrl);
    // Electron 的桌面采集使用空 mediaTypes，最终仍须经过下面的共享源选择。
    // 摄像头请求包含 video，明确拒绝；undefined 不视为已知的采集类型。
    const allowedMedia = permission === 'media' && Array.isArray(details.mediaTypes)
      && details.mediaTypes.every((type) => type === 'audio');
    callback(Boolean(trusted && (allowedMedia || ['display-capture', 'fullscreen'].includes(permission))));
  });
  desktopSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (closing || pendingCapture || request.frame !== mainWindow?.webContents.mainFrame
        || !trustedUrl(request.securityOrigin) || !request.videoRequested || request.audioRequested) {
      denyCapture(callback);
      return;
    }
    const capture = { requestId: randomUUID(), callback, sources: [] };
    pendingCapture = capture;
    try {
      capture.sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
      if (pendingCapture !== capture) return;
      mainWindow.webContents.send('capture:sources', { requestId: capture.requestId, sources: capture.sources.map((source) => ({
        id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(),
      })) });
    } catch { if (pendingCapture === capture) cancelCapture(); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    protocol.handle('lycan', serveApplication);
    configurePermissions();
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // 默认保留桌面操作空间；使用逻辑像素并按工作区裁剪，适配系统缩放和小屏幕。
    const width = Math.min(1280, workArea.width - 32);
    const height = Math.min(820, workArea.height - 32);
    mainWindow = new BrowserWindow({
      x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2),
      width, height, minWidth: Math.min(920, width), minHeight: Math.min(640, height),
      title: 'LycanSync', frame: false, show: false, backgroundColor: '#10151a',
      webPreferences: { preload: resolve(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWindow.setMenu(null);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.webContents.on('render-process-gone', () => { cancelCapture(); finishClose(); });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (event) => {
      if (canClose) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      cancelCapture();
      // 先停止采集再退出；页面异常时由主进程兜底销毁窗口，避免后台残留。
      closeTimer = setTimeout(finishClose, 2000);
      mainWindow.webContents.send('window:release-media');
    });
    mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
    mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));
    mainWindow.on('closed', () => { clearTimeout(closeTimer); mainWindow = undefined; });
    mainWindow.loadURL(APP_ORIGIN + '/');
  });
}

ipcMain.on('window:minimize', (event) => { if (trustedSender(event)) mainWindow.minimize(); });
ipcMain.handle('window:is-maximized', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return mainWindow.isMaximized();
});
ipcMain.on('window:maximize', (event) => {
  if (!trustedSender(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window:close', (event) => { if (trustedSender(event)) mainWindow.close(); });
ipcMain.on('window:closed-media', (event) => { if (trustedSender(event) && closing) finishClose(); });
ipcMain.on('capture:select', (event, requestId, sourceId) => {
  if (!trustedSender(event) || !pendingCapture || requestId !== pendingCapture.requestId) return;
  const source = pendingCapture.sources.find((candidate) => candidate.id === sourceId);
  const capture = pendingCapture;
  pendingCapture = undefined;
  if (source) capture.callback({ video: source }); else denyCapture(capture.callback);
});
app.on('window-all-closed', () => app.quit());
ipcMain.handle('auth:clear', async (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  await clearSession();
});

const { app, BrowserWindow, desktopCapturer, ipcMain, net, powerMonitor, protocol, screen, session, safeStorage, shell, sharedTexture } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { Module } = require('node:module');
const { isAbsolute, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { MediaHelperManager } = require('./media-helper.cjs');
const { matchNativeVideoSourceThumbnails } = require('./native-video-thumbnails.cjs');

const APP_ORIGIN = 'lycan://app';
const rendererRoot = resolve(__dirname, '../dist');
const serverConfig = require('./server-config.json');
// 安装版固定使用打包配置；开发模式才允许环境变量临时覆盖。
const backend = new URL(app.isPackaged ? serverConfig.apiUrl
  : process.env.LYCANSYNC_API_URL || serverConfig.apiUrl);
const apiRoutePolicies = new Map([
  ['GET /api/system/initialization', { public: true }],
  ['POST /api/auth/local/register', { public: true, savesSession: true }],
  ['POST /api/auth/local/login', { public: true, savesSession: true }],
  ['GET /api/auth/me', {}],
  ['GET /api/auth/session', {}],
  ['PUT /api/auth/me', { maxBodyBytes: 160 * 1024 }],
  ['POST /api/auth/logout', { clearsSession: true }],
  ['POST /api/rtc/token', {}],
  ['GET /api/rtc/room-summary', {}],
  ['POST /api/presence/heartbeat', {}],
  ['GET /api/groups', {}],
  ['POST /api/groups', {}],
]);
const groupPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupPresencePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presences$/i;
const groupPresenceChangesPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presence-changes$/i;
const groupMessagePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages$/i;
const groupAttachmentPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupFilePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files(?:\/(?:requests\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const groupFileDownloadPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash
    || !['http:', 'https:'].includes(backend.protocol)
    || (backend.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname))) {
  throw new Error('LYCANSYNC_API_URL 必须是 HTTPS 服务地址，本机开发可使用 HTTP；不能包含路径或凭据。');
}

app.setName('LycanSync');
// Windows Graphics Capture 在部分 Win10 窗口源上会持续拖慢系统壳层；保持 Chromium 的 DXGI/GDI 兼容采集链路。
// 这只影响共享的采集后端，不关闭 GPU 合成、硬件解码或 WebRTC 编码。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer');
}
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
let activityHelper;
let activityRestartTimer;
let currentActivity = null;
let allowQuitAfterMediaHelper = false;
let mediaHelperShutdownPromise;
let nativeMediaBridge;
let nativeVideoSession;
let lastStoppedNativeVideoSession;
let nativeScreenAudioSession;
let lastScreenAudioDroppedChunks = 0;
const helperProcessBridges = new WeakMap();

const mediaHelper = new MediaHelperManager({
  platform: process.platform,
  executablePath: mediaHelperPath,
  onSharedTextureFrame: handleNativeSharedTextureFrame,
  onHelperFailure: handleMediaHelperFailure,
  onHelperClosed: releaseHelperProcessBridge,
});

function activityHelperPath() {
  if (app.isPackaged) return resolve(process.resourcesPath, 'activity-helper', 'lycansync-activity.exe');
  const override = process.env.LYCANSYNC_ACTIVITY_HELPER;
  if (override && isAbsolute(override)) return override;
  return resolve(__dirname, '../../../native/activity-helper/target/release/lycansync-activity.exe');
}

function mediaHelperPath() {
  if (app.isPackaged) return resolve(process.resourcesPath, 'media-helper', 'lycansync-media.exe');
  return resolve(__dirname, '../../../native/media-helper/target/release/lycansync-media.exe');
}

function mediaBridgePath() {
  if (app.isPackaged) return resolve(process.resourcesPath, 'media-bridge', 'lycansync_shared_texture_bridge.dll');
  return resolve(__dirname, '../../../native/media-bridge/target/x86_64-pc-windows-msvc/release/lycansync_shared_texture_bridge.dll');
}

function loadNativeMediaBridge() {
  if (process.platform !== 'win32' || !sharedTexture?.importSharedTexture || !sharedTexture?.sendSharedTexture) {
    throw new Error('nativeVideoBridgeUnavailable');
  }
  const path = mediaBridgePath();
  if (!existsSync(path)) throw new Error('nativeVideoBridgeUnavailable');
  const nativeModule = new Module(path);
  process.dlopen(nativeModule, path);
  return nativeModule.exports;
}

function releaseHelperProcessBridge(state) {
  const bridge = helperProcessBridges.get(state);
  if (!bridge) return;
  bridge.release();
  helperProcessBridges.delete(state);
}

function releaseNativeVideoImports(video) {
  for (const imported of video.imported.values()) {
    try { imported.release(); } catch { /* Electron may already have released this import. */ }
  }
  video.imported.clear();
}

function notifyNativeVideoError(video, code) {
  if (!video || video.failureNotified) return;
  video.failureNotified = true;
  video.stopping = true;
  video.lastError = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'nativeVideoFailed';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-video-error', video.lastError);
  }
  releaseNativeVideoImports(video);
  void mediaHelper.stopVideo(video.sessionId).catch(() => {}).finally(() => {
    if (nativeVideoSession === video && !video.helperState?.alive) {
      lastStoppedNativeVideoSession = video.sessionId;
      nativeVideoSession = undefined;
    }
  });
}

function finishNativeScreenAudioPipe(audio, { destroy = false } = {}) {
  if (!audio) return;
  audio.stopping = true;
  audio.queue.length = 0;
  audio.inFlight = undefined;
  audio.buffer = Buffer.alloc(0);
  if (audio.socket && !audio.socket.destroyed) {
    if (destroy) audio.socket.destroy(); else audio.socket.end();
  }
  if (audio.server.listening) audio.server.close();
}

function handleNativeScreenAudioPipeData(audio, incoming) {
  if (nativeScreenAudioSession !== audio || audio.stopping) return;
  audio.buffer = audio.buffer.length ? Buffer.concat([audio.buffer, incoming]) : incoming;
  while (audio.buffer.length >= 4) {
    const frames = audio.buffer.readUInt32LE(0);
    if (!frames || frames > 4096) {
      notifyNativeScreenAudioError(audio, 'screenShareAudioInvalidPacket');
      return;
    }
    const packetBytes = 4 + frames * 2 * 4;
    if (audio.buffer.length < packetBytes) break;
    const pcm = Uint8Array.from(audio.buffer.subarray(4, packetBytes));
    audio.buffer = audio.buffer.subarray(packetBytes);
    if (audio.queue.length === 2) {
      audio.queue.shift();
      audio.droppedChunks++;
    }
    audio.queue.push({ frames, pcm });
  }
  if (audio.buffer.length > 65_536) {
    notifyNativeScreenAudioError(audio, 'screenShareAudioBufferOverflow');
    return;
  }
  sendNextNativeScreenAudioChunk(audio);
}

function sendNextNativeScreenAudioChunk(audio) {
  if (nativeScreenAudioSession !== audio || audio.stopping || audio.inFlight || !audio.queue.length
      || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const sequence = ++audio.sequence;
  const packet = audio.queue.shift();
  audio.inFlight = sequence;
  mainWindow.webContents.send('media:native-screen-audio-frame', {
    sequence,
    frames: packet.frames,
    sampleRate: audio.sampleRate,
    channels: 2,
    pcm: packet.pcm,
  });
}

function notifyNativeScreenAudioError(audio, code) {
  if (!audio || audio.failureNotified || audio.stopping) return;
  audio.failureNotified = true;
  const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
  finishNativeScreenAudioPipe(audio, { destroy: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-screen-audio-error', safeCode);
  }
  void mediaHelper.stopScreenShareAudio(audio.sessionId).catch(() => {}).finally(() => {
    lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
    if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
  });
}

async function startNativeScreenAudio(sourceId, sessionId) {
  const video = nativeVideoSession;
  if (closing || process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!video || video.sessionId !== sessionId || video.sourceId !== sourceId) throw new Error('videoSourceExpired');
  if (nativeScreenAudioSession) {
    if (nativeScreenAudioSession.sessionId === sessionId) return nativeScreenAudioSession.format;
    throw new Error('screenShareAudioAlreadyRunning');
  }
  lastScreenAudioDroppedChunks = 0;
  const pipeId = randomUUID();
  const server = net.createServer();
  const audio = {
    sessionId, pipeId, server, socket: undefined, buffer: Buffer.alloc(0), queue: [],
    inFlight: undefined, sequence: 0, sampleRate: undefined, droppedChunks: 0,
    rendererDroppedChunks: 0, stopping: false, failureNotified: false,
  };
  nativeScreenAudioSession = audio;
  server.on('connection', (socket) => {
    if (nativeScreenAudioSession !== audio || audio.socket) {
      socket.destroy();
      return;
    }
    audio.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => handleNativeScreenAudioPipeData(audio, chunk));
    socket.once('error', () => notifyNativeScreenAudioError(audio, 'screenShareAudioPipeFailed'));
    socket.once('close', () => {
      if (nativeScreenAudioSession === audio && !audio.stopping) {
        notifyNativeScreenAudioError(audio, 'screenShareAudioPipeClosed');
      }
    });
  });
  server.on('error', () => notifyNativeScreenAudioError(audio, 'screenShareAudioPipeFailed'));
  let helperStarted = false;
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
      const onListening = () => { server.removeListener('error', onError); resolveListen(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(`\\\\.\\pipe\\lycansync-screen-audio-${pipeId}`);
    });
    const format = await mediaHelper.startScreenShareAudio(sourceId, pipeId, sessionId);
    helperStarted = true;
    if (nativeScreenAudioSession !== audio || video.stopping) throw new Error('screenShareAudioSessionStopped');
    audio.sampleRate = format.sampleRate;
    audio.format = format;
    return format;
  } catch (error) {
    finishNativeScreenAudioPipe(audio, { destroy: true });
    if (helperStarted) await mediaHelper.stopScreenShareAudio(sessionId).catch(() => {});
    if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
    throw error;
  }
}

async function stopNativeScreenAudio(sessionId) {
  const audio = nativeScreenAudioSession;
  if (!audio) return { changed: false };
  if (audio.sessionId !== sessionId) throw new Error('screenShareAudioSessionMismatch');
  if (audio.stopPromise) return audio.stopPromise;
  audio.stopPromise = (async () => {
    const helperStop = mediaHelper.stopScreenShareAudio(sessionId);
    // Deliver the stop command before breaking the pipe so the helper can mark the writer closure as intentional.
    finishNativeScreenAudioPipe(audio, { destroy: true });
    try {
      return await helperStop;
    } finally {
      lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
      if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
    }
  })();
  return audio.stopPromise;
}

function handleMediaHelperFailure(state, code) {
  const video = nativeVideoSession;
  if (video && (video.helperState === state || (!video.helperState && state.videoSessionId === video.sessionId))) {
    notifyNativeVideoError(video, code);
  }
  const audio = nativeScreenAudioSession;
  if (audio && (state.videoSessionId === audio.sessionId || state === video?.helperState)) {
    notifyNativeScreenAudioError(audio, code);
  }
}

function handleNativeSharedTextureFrame(state, frame) {
  const video = nativeVideoSession;
  if (!video || video.sessionId !== frame.sessionId || video.stopping) {
    if (video && video.sessionId === frame.sessionId) {
      void mediaHelper.releaseSharedTextureSlot(frame.sessionId, frame.slotIndex).catch(() => {});
    }
    return;
  }
  video.helperState = state;
  let helperBridge = helperProcessBridges.get(state);
  let owned;
  let imported;
  let importRegistered = false;
  let releaseBeforeRegistration = false;
  let slotReleaseStarted = false;
  const releaseSlot = () => {
    if (slotReleaseStarted) return;
    if (!importRegistered) {
      releaseBeforeRegistration = true;
      return;
    }
    slotReleaseStarted = true;
    video.imported.delete(frame.slotIndex);
    if (state.alive && !state.closed) {
      video.pendingSlotReleases.add(frame.slotIndex);
      void mediaHelper.releaseSharedTextureSlot(video.sessionId, frame.slotIndex).catch(() => {
        notifyNativeVideoError(video, 'sharedTextureSlotReleaseFailed');
      }).finally(() => video.pendingSlotReleases.delete(frame.slotIndex));
    }
  };
  try {
    if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
    if (!helperBridge) {
      helperBridge = nativeMediaBridge.openSpawnedMediaHelper(state.child.pid, mediaHelperPath());
      helperProcessBridges.set(state, helperBridge);
    }
    if (video.imported.has(frame.slotIndex) || video.imported.size >= 3) {
      throw new Error('sharedTexturePoolInvariantFailed');
    }
    owned = helperBridge.duplicateSharedTexture(frame.sourceHandleHex);
    imported = owned.withImportHandle((ntHandle) => sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: frame.pixelFormat,
        codedSize: frame.codedSize,
        visibleRect: { x: 0, y: 0, width: frame.contentSize.width, height: frame.contentSize.height },
        timestamp: frame.timestampMicros,
        handle: { ntHandle },
      },
      allReferencesReleased: releaseSlot,
    }));
    owned.release();
    if (releaseBeforeRegistration) {
      importRegistered = true;
      releaseSlot();
      imported.release();
      return;
    }
    video.imported.set(frame.slotIndex, imported);
    importRegistered = true;
    void sharedTexture.sendSharedTexture({
      frame: mainWindow.webContents.mainFrame,
      importedSharedTexture: imported,
    }, 'native-screen-frame').then(() => {
      imported.release();
    }).catch(() => {
      imported.release();
      notifyNativeVideoError(video, 'sharedTextureTransferFailed');
    });
  } catch {
    owned?.release();
    if (imported) imported.release();
    else void mediaHelper.releaseSharedTextureSlot(video.sessionId, frame.slotIndex).catch(() => {});
    notifyNativeVideoError(video, 'sharedTextureImportFailed');
  }
}

async function startNativeVideo(sourceId, maxFps) {
  if (closing) throw new Error('mediaHelperShuttingDown');
  if (process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!Number.isInteger(maxFps) || maxFps < 1 || maxFps > 60
      || typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidVideoStart');
  if (nativeVideoSession) throw new Error('videoCaptureAlreadyRunning');
  if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
  const sessionId = randomUUID();
  const video = { sessionId, sourceId, maxFps, imported: new Map(), pendingSlotReleases: new Set(), stopping: false, failureNotified: false };
  nativeVideoSession = video;
  try {
    const started = await mediaHelper.startVideo(sourceId, maxFps, sessionId);
    if (started.sessionId !== sessionId || !started.changed || nativeVideoSession !== video) {
      throw new Error('mediaHelperInvalidVideoStart');
    }
    return { sessionId, changed: true };
  } catch (error) {
    if (nativeVideoSession === video) nativeVideoSession = undefined;
    releaseNativeVideoImports(video);
    throw error;
  }
}

async function stopNativeVideo(sessionId) {
  const video = nativeVideoSession;
  if (!video) {
    return lastStoppedNativeVideoSession === sessionId
      ? { changed: false }
      : Promise.reject(new Error('videoSessionMismatch'));
  }
  if (video.sessionId !== sessionId) throw new Error('videoSessionMismatch');
  if (video.stopPromise) return video.stopPromise;
  video.stopping = true;
  video.stopPromise = (async () => {
    if (nativeScreenAudioSession?.sessionId === sessionId) {
      await stopNativeScreenAudio(sessionId).catch(() => {});
    }
    const deadline = Date.now() + 1_200;
    while ((video.imported.size || video.pendingSlotReleases.size) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (video.imported.size || video.pendingSlotReleases.size) {
      releaseNativeVideoImports(video);
      try {
        await mediaHelper.abortVideo(sessionId);
      } finally {
        video.lastError ??= 'sharedTextureReleaseTimedOut';
        if (nativeVideoSession === video) nativeVideoSession = undefined;
        lastStoppedNativeVideoSession = sessionId;
      }
      throw new Error('sharedTextureReleaseTimedOut');
    }
    try {
      const result = await mediaHelper.stopVideo(sessionId);
      return result;
    } finally {
      if (nativeVideoSession === video) nativeVideoSession = undefined;
      lastStoppedNativeVideoSession = sessionId;
      if (video.helperState?.closed) releaseHelperProcessBridge(video.helperState);
    }
  })();
  return video.stopPromise;
}

function normalizeActivity(value) {
  if (value?.activityType == null) return null;
  if (value.activityType !== 'GAME' || typeof value.activityName !== 'string'
      || !Number.isSafeInteger(value.startedAtEpochSeconds)) return undefined;
  const name = value.activityName.replace(/\s+/g, ' ').trim().slice(0, 80);
  const startedAt = value.startedAtEpochSeconds * 1000;
  if (!name || /[\u0000-\u001f\u007f]/.test(name)
      || startedAt <= 0 || startedAt > Date.now() + 60_000) return undefined;
  return { type: 'GAME', name, startedAt: new Date(startedAt).toISOString() };
}

function publishActivity(activity) {
  if (JSON.stringify(activity) === JSON.stringify(currentActivity)) return;
  currentActivity = activity;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('activity:changed', activity);
}

function stopActivityHelper() {
  clearTimeout(activityRestartTimer);
  activityRestartTimer = undefined;
  activityHelper?.kill();
  activityHelper = undefined;
}

function startActivityHelper() {
  if (process.platform !== 'win32' || closing || activityHelper) return;
  const executable = activityHelperPath();
  if (!existsSync(executable)) return;
  const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  activityHelper = child;
  let finished = false;
  const finish = () => {
    if (finished || activityHelper !== child) return;
    finished = true;
    activityHelper = undefined;
    publishActivity(null);
    if (!closing) activityRestartTimer = setTimeout(startActivityHelper, 5000);
  };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.length > 1024) return;
    try {
      const activity = normalizeActivity(JSON.parse(line));
      if (activity !== undefined) publishActivity(activity);
    } catch {
      // 忽略单条不完整输出，下一轮扫描会再次上报。
    }
  });
  child.once('error', finish);
  child.once('exit', finish);
}

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

function autoStartSettings() {
  const supported = process.platform === 'win32' && app.isPackaged;
  return {
    supported,
    enabled: supported && app.getLoginItemSettings().openAtLogin,
  };
}

function externalHttpUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function captureSourceType(source) {
  return source.id.startsWith('screen:') ? 'screen' : 'window';
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
    const routePolicy = apiRoutePolicies.get(`${request.method} ${url.pathname}`)
      ?? (request.method === 'GET' && (groupPath.test(url.pathname) || groupPresencePath.test(url.pathname) || groupMessagePath.test(url.pathname)
        || groupAttachmentPath.test(url.pathname) || groupFilePath.test(url.pathname)) ? {} : undefined)
      ?? (request.method === 'GET' && groupPresenceChangesPath.test(url.pathname) ? { longPolling: true } : undefined)
      // 图片 multipart 保持原有限制，普通文件只按流转发到固定的上传路径。
      ?? (request.method === 'POST' && groupMessagePath.test(url.pathname) ? { maxBodyBytes: 6 * 1024 * 1024 } : undefined)
      ?? (request.method === 'POST' && groupFilePath.test(url.pathname) && url.pathname.endsWith('/files')
        ? { streamBody: true } : undefined);
    if (!routePolicy) return new Response(null, { status: 404 });
    try {
      const streamingUpload = routePolicy.streamBody === true;
      const body = streamingUpload ? request.body
        : ['POST', 'PUT'].includes(request.method) ? Buffer.from(await request.arrayBuffer()) : undefined;
      if (body instanceof Buffer && body.byteLength > (routePolicy.maxBodyBytes ?? 4096)) return new Response(null, { status: 413 });
      const token = await loadSession();
      const response = await net.fetch(new URL(url.pathname + url.search, backend).href, {
        method: request.method,
        headers: { ...(body ? { 'Content-Type': request.headers.get('Content-Type') || 'application/json' } : {}),
          ...(streamingUpload ? {
            'X-File-Name': request.headers.get('X-File-Name') || '',
            'X-File-Size': request.headers.get('X-File-Size') || '',
            'X-Upload-Id': request.headers.get('X-Upload-Id') || '',
            'X-Message-Content': request.headers.get('X-Message-Content') || '',
          } : {}),
          ...(!routePolicy.public && token ? { Authorization: 'Bearer ' + token } : {}) },
        body, redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([request.signal,
          AbortSignal.timeout(streamingUpload || groupFileDownloadPath.test(url.pathname) ? 30 * 60_000
            : routePolicy.longPolling ? 52_000 : 15000)]),
      });
      const currentSessionUnauthorized = !routePolicy.public && Boolean(token)
        && response.status === 401 && token === sessionToken;
      if (!routePolicy.public && token === sessionToken
          && (response.status === 401 || (routePolicy.clearsSession && response.ok))) await clearSession();
      if (routePolicy.savesSession && response.ok) {
        const result = await response.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.sessionToken ?? '')) throw new Error('登录响应无效');
        await saveSession(result.sessionToken);
        // 会话原文只进入主进程的系统加密存储，不暴露给渲染页面。
        delete result.sessionToken;
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      }
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        ...(response.headers.has('Content-Length') ? { 'Content-Length': response.headers.get('Content-Length') } : {}),
        ...(response.headers.has('Content-Disposition') ? { 'Content-Disposition': response.headers.get('Content-Disposition') } : {}),
        ...(response.headers.has('X-Content-Type-Options') ? { 'X-Content-Type-Options': response.headers.get('X-Content-Type-Options') } : {}),
        ...(response.status === 401 && !routePolicy.public
          ? { 'X-Lycan-Session-Expired': currentSessionUnauthorized ? 'true' : 'false' } : {}),
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
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; frame-src 'none'; base-uri 'none'");
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
      // 只保证“不能直接选中自身窗口”：按 source id 精确排除当前主窗口，不按标题模糊匹配。
      const ownSourceId = mainWindow.getMediaSourceId();
      capture.sources = (await desktopCapturer.getSources({
        types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 },
      })).filter((source) => source.id !== ownSourceId).sort((left, right) =>
        captureSourceType(left).localeCompare(captureSourceType(right)));
      if (pendingCapture !== capture) return;
      // 没有可选源时按既有取消逻辑结束，不替用户默认选择整个屏幕。
      if (!capture.sources.length) { cancelCapture(); return; }
      mainWindow.webContents.send('capture:sources', { requestId: capture.requestId, sources: capture.sources.map((source) => ({
        id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), type: captureSourceType(source),
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
    startActivityHelper();
  });
}

ipcMain.on('window:minimize', (event) => { if (trustedSender(event)) mainWindow.minimize(); });
ipcMain.handle('window:is-maximized', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return mainWindow.isMaximized();
});
ipcMain.handle('diagnostics:process-metrics', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  const metrics = app.getAppMetrics();
  return {
    cpuPercent: Math.round(metrics.reduce((sum, process) => sum + (process.cpu?.percentCPUUsage ?? 0), 0) * 10) / 10,
    memoryMb: Math.round(metrics.reduce((sum, process) => sum + (process.memory?.workingSetSize ?? 0), 0) / 1024),
  };
});
ipcMain.handle('presence:system-idle-state', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return {
    state: powerMonitor.getSystemIdleState(300),
    idleSeconds: powerMonitor.getSystemIdleTime(),
  };
});
ipcMain.handle('settings:auto-start:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return autoStartSettings();
});
ipcMain.handle('settings:auto-start:set', (event, enabled) => {
  if (!trustedSender(event) || typeof enabled !== 'boolean') throw new Error('请求参数无效');
  const settings = autoStartSettings();
  if (!settings.supported) return settings;
  // 使用 Windows 登录项启动现有程序，不创建额外服务或常驻辅助进程。
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  return autoStartSettings();
});
ipcMain.handle('activity:current', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return currentActivity;
});
ipcMain.handle('media:capabilities', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return mediaHelper.getCapabilities().then((capabilities) => {
    let bridgeAvailable = false;
    try {
      if (process.platform === 'win32') {
        nativeMediaBridge ??= loadNativeMediaBridge();
        bridgeAvailable = true;
      }
    } catch { /* Keep output capability unavailable if the native importer cannot load. */ }
    if (!bridgeAvailable) capabilities.videoCapture = { available: false, reason: 'nativeVideoBridgeUnavailable' };
    return capabilities;
  });
});
ipcMain.handle('media:video-sources', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return mediaHelper.listVideoSources();
});
ipcMain.handle('media:video-source-thumbnails', async (event, sources) => {
  if (!trustedSender(event) || closing || !Array.isArray(sources) || sources.length > 128
      || sources.some((source) => !source || !/^(?:monitor|window):[1-9]\d*:\d+$/.test(source.sourceId)
        || !['monitor', 'window'].includes(source.kind) || typeof source.title !== 'string'
        || source.title.length > 256 || /[\u0000-\u001f\u007f]/.test(source.title))) {
    throw new Error('请求参数无效');
  }
  if (!sources.length) return [];
  try {
    const desktopSources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 160, height: 90 },
    });
    return matchNativeVideoSourceThumbnails(sources, desktopSources.map((source) => ({
      type: captureSourceType(source),
      name: source.name,
      thumbnail: source.thumbnail,
    })));
  } catch {
    // Preview is optional; source selection continues with the existing placeholder.
    return [];
  }
});
ipcMain.handle('media:capture-probe:start', (event, sourceId) => {
  if (!trustedSender(event) || closing || typeof sourceId !== 'string' || sourceId.length > 128) {
    throw new Error('请求参数无效');
  }
  return mediaHelper.startCaptureProbe(sourceId);
});
ipcMain.handle('media:capture-probe:stop', (event, sessionId) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return mediaHelper.stopCaptureProbe(sessionId);
});
ipcMain.handle('media:native-video:start', (event, sourceId, maxFps) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return startNativeVideo(sourceId, maxFps);
});
ipcMain.handle('media:native-video:stop', (event, sessionId) => {
  if (!trustedSender(event) || closing
      || (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128))) {
    throw new Error('请求参数无效');
  }
  const targetSessionId = sessionId ?? nativeVideoSession?.sessionId;
  if (!targetSessionId) return { changed: false };
  return stopNativeVideo(targetSessionId);
});
ipcMain.handle('media:native-screen-audio:start', (event, sourceId, sessionId) => {
  if (!trustedSender(event) || closing || typeof sourceId !== 'string' || sourceId.length > 128
      || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return startNativeScreenAudio(sourceId, sessionId);
});
ipcMain.handle('media:native-screen-audio:stop', (event, sessionId) => {
  if (!trustedSender(event) || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return stopNativeScreenAudio(sessionId);
});
ipcMain.on('media:native-screen-audio:consumed', (event, sequence, droppedChunks) => {
  if (!trustedSender(event) || !Number.isSafeInteger(sequence)
      || !Number.isSafeInteger(droppedChunks) || droppedChunks < 0) return;
  const audio = nativeScreenAudioSession;
  if (!audio || audio.inFlight !== sequence) return;
  audio.rendererDroppedChunks = Math.max(audio.rendererDroppedChunks, droppedChunks);
  audio.inFlight = undefined;
  sendNextNativeScreenAudioChunk(audio);
});
ipcMain.on('media:native-video:receiver-error', (event) => {
  if (!trustedSender(event)) return;
  notifyNativeVideoError(nativeVideoSession, 'sharedTextureReceiverFailed');
});
ipcMain.handle('media:diagnostics', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const diagnostics = await mediaHelper.getDiagnostics();
  if (diagnostics.screenShareAudio) {
    const audioDrops = nativeScreenAudioSession
      ? nativeScreenAudioSession.droppedChunks + nativeScreenAudioSession.rendererDroppedChunks
      : lastScreenAudioDroppedChunks;
    diagnostics.screenShareAudio.droppedAudioChunks = (diagnostics.screenShareAudio.droppedAudioChunks ?? 0) + audioDrops;
  }
  return diagnostics;
});
ipcMain.on('window:maximize', (event) => {
  if (!trustedSender(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window:close', (event) => { if (trustedSender(event)) mainWindow.close(); });
ipcMain.on('window:closed-media', (event) => { if (trustedSender(event) && closing) finishClose(); });
ipcMain.handle('external:open', async (event, value) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  const url = externalHttpUrl(value);
  if (!url) throw new Error('只允许打开 HTTP 或 HTTPS 链接。');
  await shell.openExternal(url);
});
ipcMain.on('capture:select', (event, requestId, sourceId) => {
  if (!trustedSender(event) || !pendingCapture || requestId !== pendingCapture.requestId) return;
  const source = pendingCapture.sources.find((candidate) => candidate.id === sourceId);
  const capture = pendingCapture;
  pendingCapture = undefined;
  if (source) capture.callback({ video: source }); else denyCapture(capture.callback);
});
app.on('before-quit', (event) => {
  stopActivityHelper();
  if (allowQuitAfterMediaHelper) return;
  event.preventDefault();
  if (mediaHelperShutdownPromise) return;
  mediaHelperShutdownPromise = (nativeScreenAudioSession
    ? stopNativeScreenAudio(nativeScreenAudioSession.sessionId).catch((error) => {
      console.error(`native screen audio shutdown failed: ${error.message}`);
    })
    : Promise.resolve())
    .then(() => nativeVideoSession
    ? stopNativeVideo(nativeVideoSession.sessionId).catch((error) => {
      console.error(`native video shutdown failed: ${error.message}`);
    })
    : Promise.resolve())
    .then(() => mediaHelper.shutdown())
    .catch((error) => console.error(`media-helper shutdown failed: ${error.message}`))
    .finally(() => {
      allowQuitAfterMediaHelper = true;
      app.quit();
    });
});
app.on('window-all-closed', () => app.quit());
ipcMain.handle('auth:clear', async (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  await clearSession();
});

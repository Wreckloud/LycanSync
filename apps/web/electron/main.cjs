const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, net, powerMonitor, protocol, screen, session, safeStorage, shell, sharedTexture } = require('electron');
const { release: osRelease } = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { Module } = require('node:module');
const { isAbsolute, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { MediaHelperManager } = require('./media-helper.cjs');
const { createMediaDiagnostics } = require('./media-diagnostics.cjs');
const { loadServerSettings, saveServerSettings } = require('./server-settings.cjs');
const { matchNativeVideoSourceThumbnails, monitorDisplayId } = require('./native-video-thumbnails.cjs');
const { parseAccessLink, accessLinkFromArguments, parseManualAccessLink } = require('./access-links.cjs');
const { createStartupUpdate } = require('./startup-update.cjs');

const APP_ORIGIN = 'lycan://app';
const rendererRoot = resolve(__dirname, '../dist');
const devRendererUrl = !app.isPackaged && process.env.LYCANSYNC_DEV_RENDERER_URL
  ? new URL(process.env.LYCANSYNC_DEV_RENDERER_URL) : undefined;
if (devRendererUrl && (devRendererUrl.protocol !== 'http:' || devRendererUrl.hostname !== '127.0.0.1'
    || devRendererUrl.username || devRendererUrl.password || devRendererUrl.pathname !== '/'
    || devRendererUrl.search || devRendererUrl.hash)) {
  throw new Error('开发前端必须使用本机 http://127.0.0.1 地址。');
}
const apiRoutePolicies = new Map([
  ['GET /api/auth/options', { public: true }],
  ['POST /api/auth/access/preview', { public: true }],
  ['POST /api/auth/access/redeem', { public: true, savesSession: true }],
  ['GET /api/auth/access/links', {}],
  ['POST /api/auth/access/links', {}],
  ['GET /api/auth/access/members', {}],
  ['GET /api/system/initialization', { public: true }],
  ['GET /api/auth/me', {}],
  ['GET /api/auth/session', {}],
  ['PUT /api/auth/me', { maxBodyBytes: 3 * 1024 * 1024 }],
  ['POST /api/auth/logout', { clearsSession: true }],
  ['POST /api/rtc/token', {}],
  ['GET /api/rtc/room-summary', {}],
  ['POST /api/presence/heartbeat', {}],
  ['GET /api/groups', {}],
  // 后端接受最多 2 MiB 的裁剪图片，另留 Base64 膨胀、文本与 JSON 的空间。
  ['POST /api/groups', { maxBodyBytes: 3 * 1024 * 1024 }],
]);
const groupPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupPresencePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presences$/i;
const groupPresenceChangesPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presence-changes$/i;
const groupMessagePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages$/i;
const groupAttachmentPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupFilePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files(?:\/(?:requests\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const groupFileDownloadPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.setName('LycanSync');
// 来源缩略图仍由 Chromium 截取；避免部分 Win10 窗口的 WGC 缩略图采集拖慢系统壳层。
// 正式视频流由 Rust 采集，此开关不改变其后端，也不关闭 GPU 合成或 WebRTC 编码。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer');
}
// 遵循 Chromium 的独立用户目录参数，便于测试与日常账号数据隔离。
if (app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', resolve(app.commandLine.getSwitchValue('user-data-dir')));
const backend = new URL(loadServerSettings({
  packaged: app.isPackaged,
  userDirectory: app.getPath('userData'),
  resourcesDirectory: app.isPackaged ? process.resourcesPath : __dirname,
  developmentUrl: process.env.LYCANSYNC_API_URL,
}));
let pendingAccessLink = accessLinkFromArguments(process.argv);
let pendingAccessError = false;
const accessLinkFile = resolve(app.getPath('userData'), 'pending-access.bin');
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

let mainWindow;
let closing = false;
let canClose = false;
let closeTimer;
let sessionToken;
let sessionLoaded = false;
let activityHelper;
let activityRestartTimer;
let currentActivity = null;
let startupReady = false;
let allowQuitAfterMediaHelper = false;
let mediaHelperShutdownPromise;
let nativeMediaBridge;
let nativeVideoSession;
let lastStoppedNativeVideoSession;
let nativeScreenAudioSession;
let lastScreenAudioDroppedChunks = 0;
let nativeMicrophoneSession;
let lastMicrophoneDroppedChunks = 0;
const helperProcessBridges = new WeakMap();
const writeMediaDiagnostic = createMediaDiagnostics(resolve(app.getPath('userData'), 'screen-share-error.log'));
const sourceTimingRecordedAt = new Map();
const startupUpdate = createStartupUpdate({
  enabled: app.isPackaged && process.platform === 'win32',
  version: app.getVersion(),
  // app-update.yml 来自安装包，不能跟随用户选择的业务服务器改变。
  createUpdater: () => require('electron-updater').autoUpdater,
  onChange: (state) => { if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('update:state', state); },
  beforeInstall: async () => {
    if (pendingAccessLink) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('无法保存待确认邀请');
      const link = `lycansync://access?server=${encodeURIComponent(pendingAccessLink.server)}#token=${pendingAccessLink.token}`;
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(accessLinkFile, safeStorage.encryptString(link));
    }
    if (closing || startupReady) throw new Error('启动更新已结束');
    // 更新发生在认证和 helper 启动之前，不进入普通的媒体退出等待。
    canClose = true;
    allowQuitAfterMediaHelper = true;
  },
  onInstallFailure: () => { canClose = false; allowQuitAfterMediaHelper = false; },
});

function recordSourceTiming(stage, startedAt, sourceCount) {
  const now = Date.now();
  if (now - (sourceTimingRecordedAt.get(stage) ?? 0) < 30_000) return;
  sourceTimingRecordedAt.set(stage, now);
  void writeMediaDiagnostic({ stage, durationMs: Math.round(performance.now() - startedAt), sourceCount });
}

function recordVideoFailure(stage, error, frame) {
  void writeMediaDiagnostic({
    stage, message: String(error?.message ?? error).slice(0, 2000),
    appVersion: app.getVersion(), electronVersion: process.versions.electron,
    windowsVersion: osRelease(), gpu: app.getGPUFeatureStatus(),
    pixelFormat: frame?.pixelFormat, codedSize: frame?.codedSize,
  });
  // 只在故障时查询 GPU，不记录窗口、纹理句柄或账号信息。
  void app.getGPUInfo('basic').then((gpu) => writeMediaDiagnostic({
    stage: 'gpuAdapters', devices: gpu.gpuDevice?.slice(0, 8).map((device) => ({
      vendorId: device.vendorId, deviceId: device.deviceId, active: device.active,
      driverVersion: device.driverVersion,
    })),
  })).catch((failure) => writeMediaDiagnostic({ stage: 'gpuDiagnostics', message: String(failure.message).slice(0, 500) }));
}

const mediaHelper = new MediaHelperManager({
  platform: process.platform,
  executablePath: mediaHelperPath,
  onDiagnostic: (message) => { void writeMediaDiagnostic({ stage: 'helperStderr', message }); },
  onSharedTextureFrame: handleNativeSharedTextureFrame,
  onVideoCaptureEnded: handleVideoCaptureEnded,
  onVideoCaptureSuspended: handleVideoCaptureSuspended,
  onMicrophoneCaptureEnded: handleMicrophoneCaptureEnded,
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
    mainWindow.webContents.send('media:native-video-error', {
      sessionId: video.sessionId,
      code: video.lastError,
    });
  }
  releaseNativeVideoImports(video);
  void stopNativeVideo(video.sessionId).catch((error) => {
    recordVideoFailure('stopAfterFailure', error);
    console.error(`native video stop after capture failure failed: ${error.message}`);
  });
}

function handleVideoCaptureEnded(state, event) {
  const video = nativeVideoSession;
  if (!video || video.sessionId !== event.sessionId || video.stopping
      || (video.helperState && video.helperState !== state)
      || state.videoSessionId !== event.sessionId) return;
  video.helperState = state;
  notifyNativeVideoError(video, event.code);
}

function handleVideoCaptureSuspended(state, event) {
  const video = nativeVideoSession;
  if (!video || video.sessionId !== event.sessionId || video.stopping
      || (video.helperState && video.helperState !== state)
      || state.videoSessionId !== event.sessionId) return;
  video.helperState = state;
  video.suspended = event.suspended;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-video-suspended', event);
  }
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

function finishNativeMicrophonePipe(audio, { destroy = false } = {}) {
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

function validNativeAudioSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && Buffer.byteLength(sessionId, 'utf8') <= 128
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId);
}

function handleNativeMicrophonePipeData(audio, incoming) {
  if (nativeMicrophoneSession !== audio || audio.stopping) return;
  audio.buffer = audio.buffer.length ? Buffer.concat([audio.buffer, incoming]) : incoming;
  while (audio.buffer.length >= 4) {
    const frames = audio.buffer.readUInt32LE(0);
    if (frames !== 480) {
      notifyNativeMicrophoneError(audio, 'microphoneCaptureInvalidPacket');
      return;
    }
    const packetBytes = 4 + frames * 4;
    if (audio.buffer.length < packetBytes) break;
    const pcm = Uint8Array.from(audio.buffer.subarray(4, packetBytes));
    audio.buffer = audio.buffer.subarray(packetBytes);
    if (audio.queue.length === 12) {
      audio.queue.shift();
      audio.droppedChunks++;
    }
    audio.queue.push({ frames, pcm });
  }
  if (audio.buffer.length > 65_536) {
    notifyNativeMicrophoneError(audio, 'microphoneCaptureBufferOverflow');
    return;
  }
  sendNextNativeMicrophoneChunk(audio);
}

function sendNextNativeMicrophoneChunk(audio) {
  if (nativeMicrophoneSession !== audio || audio.stopping || audio.inFlight || !audio.queue.length
      || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const sequence = ++audio.sequence;
  const packet = audio.queue.shift();
  audio.inFlight = sequence;
  mainWindow.webContents.send('media:native-microphone-frame', {
    sessionId: audio.sessionId, sequence, frames: packet.frames, sampleRate: 48_000, channels: 1, pcm: packet.pcm,
  });
}

function acknowledgeNativeMicrophoneChunk(sessionId, sequence, droppedChunks) {
  if (!validNativeAudioSessionId(sessionId) || !Number.isSafeInteger(sequence)
      || !Number.isSafeInteger(droppedChunks) || droppedChunks < 0) return;
  const audio = nativeMicrophoneSession;
  if (!audio || audio.sessionId !== sessionId || audio.inFlight !== sequence) return;
  audio.rendererDroppedChunks = Math.max(audio.rendererDroppedChunks, droppedChunks);
  audio.inFlight = undefined;
  sendNextNativeMicrophoneChunk(audio);
}

function notifyNativeMicrophoneError(audio, code) {
  if (!audio || audio.failureNotified || audio.stopping) return;
  audio.failureNotified = true;
  const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'microphoneCaptureFailed';
  finishNativeMicrophonePipe(audio, { destroy: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-microphone-error', { sessionId: audio.sessionId, code: safeCode });
  }
  void mediaHelper.stopMicrophoneCapture(audio.sessionId).catch(() => {}).finally(() => {
    lastMicrophoneDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
    if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
  });
}

function handleMicrophoneCaptureEnded(_state, event) {
  const audio = nativeMicrophoneSession;
  if (!audio || audio.sessionId !== event.sessionId || audio.stopping) return;
  notifyNativeMicrophoneError(audio, event.code);
}

async function startNativeMicrophoneCapture(sessionId, settings) {
  if (closing || process.platform !== 'win32') throw new Error('platformUnsupported');
  if (typeof sessionId !== 'string' || sessionId.length > 128 || !validMicrophoneSettings(settings)) {
    throw new Error('invalidMicrophoneCaptureStart');
  }
  if (nativeMicrophoneSession) {
    if (nativeMicrophoneSession.sessionId === sessionId) return nativeMicrophoneSession.format;
    throw new Error('microphoneCaptureAlreadyRunning');
  }
  lastMicrophoneDroppedChunks = 0;
  const pipeId = randomUUID();
  const server = createServer();
  const audio = {
    sessionId, pipeId, server, socket: undefined, buffer: Buffer.alloc(0), queue: [],
    inFlight: undefined, sequence: 0, droppedChunks: 0, rendererDroppedChunks: 0,
    stopping: false, failureNotified: false,
  };
  nativeMicrophoneSession = audio;
  server.on('connection', (socket) => {
    if (nativeMicrophoneSession !== audio || audio.socket) { socket.destroy(); return; }
    audio.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => handleNativeMicrophonePipeData(audio, chunk));
    socket.once('error', () => notifyNativeMicrophoneError(audio, 'microphoneCapturePipeFailed'));
    socket.once('close', () => {
      if (nativeMicrophoneSession === audio && !audio.stopping) {
        notifyNativeMicrophoneError(audio, 'microphoneCapturePipeClosed');
      }
    });
  });
  server.on('error', () => notifyNativeMicrophoneError(audio, 'microphoneCapturePipeFailed'));
  let helperStarted = false;
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
      const onListening = () => { server.removeListener('error', onError); resolveListen(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(`\\\\.\\pipe\\lycansync-microphone-audio-${pipeId}`);
    });
    const format = await mediaHelper.startMicrophoneCapture(pipeId, sessionId, settings);
    helperStarted = true;
    if (nativeMicrophoneSession !== audio || audio.stopping) throw new Error('microphoneCaptureSessionStopped');
    audio.format = format;
    return format;
  } catch (error) {
    finishNativeMicrophonePipe(audio, { destroy: true });
    if (helperStarted) await mediaHelper.stopMicrophoneCapture(sessionId).catch(() => {});
    if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
    throw error;
  }
}

async function stopNativeMicrophoneCapture(sessionId) {
  const audio = nativeMicrophoneSession;
  if (!audio) return { changed: false };
  if (audio.sessionId !== sessionId) throw new Error('microphoneCaptureSessionMismatch');
  if (audio.stopPromise) return audio.stopPromise;
  audio.stopPromise = (async () => {
    const helperStop = mediaHelper.stopMicrophoneCapture(sessionId);
    finishNativeMicrophonePipe(audio, { destroy: true });
    try { return await helperStop; }
    finally {
      lastMicrophoneDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
      if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
    }
  })();
  return audio.stopPromise;
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
    if (audio.queue.length === 12) {
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
    sessionId: audio.sessionId,
    sequence,
    frames: packet.frames,
    sampleRate: audio.sampleRate,
    channels: 2,
    pcm: packet.pcm,
  });
}

function acknowledgeNativeScreenAudioChunk(sessionId, sequence, droppedChunks) {
  if (!validNativeAudioSessionId(sessionId) || !Number.isSafeInteger(sequence)
      || !Number.isSafeInteger(droppedChunks) || droppedChunks < 0) return;
  const audio = nativeScreenAudioSession;
  if (!audio || audio.sessionId !== sessionId || audio.inFlight !== sequence) return;
  audio.rendererDroppedChunks = Math.max(audio.rendererDroppedChunks, droppedChunks);
  audio.inFlight = undefined;
  sendNextNativeScreenAudioChunk(audio);
}

function notifyNativeScreenAudioError(audio, code) {
  if (!audio || audio.failureNotified || audio.stopping) return;
  audio.failureNotified = true;
  const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
  finishNativeScreenAudioPipe(audio, { destroy: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-screen-audio-error', { sessionId: audio.sessionId, code: safeCode });
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
  const server = createServer();
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
  const microphone = nativeMicrophoneSession;
  if (microphone && state.microphoneCaptureSessionId === microphone.sessionId) {
    notifyNativeMicrophoneError(microphone, code);
  }
}

function handleNativeSharedTextureFrame(state, frame) {
  const video = nativeVideoSession;
  if (!video || video.sessionId !== frame.sessionId || video.stopping || video.suspended) {
    if (video && video.sessionId === frame.sessionId) {
      void mediaHelper.releaseSharedTextureSlot(frame.sessionId, frame.slotIndex).catch(() => {});
    }
    return;
  }
  video.helperState = state;
  let helperBridge = helperProcessBridges.get(state);
  let owned;
  let imported;
  let importStage = 'loadBridge';
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
      void mediaHelper.releaseSharedTextureSlot(video.sessionId, frame.slotIndex).catch((error) => {
        if (!video.failureNotified) recordVideoFailure('releaseTextureSlot', error, frame);
        notifyNativeVideoError(video, 'sharedTextureSlotReleaseFailed');
      }).finally(() => video.pendingSlotReleases.delete(frame.slotIndex));
    }
  };
  try {
    if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
    if (!helperBridge) {
      importStage = 'openHelper';
      helperBridge = nativeMediaBridge.openSpawnedMediaHelper(state.child.pid, mediaHelperPath());
      helperProcessBridges.set(state, helperBridge);
    }
    importStage = 'validateTexturePool';
    if (video.imported.has(frame.slotIndex) || video.imported.size >= 3) {
      throw new Error('sharedTexturePoolInvariantFailed');
    }
    importStage = 'duplicateHandle';
    owned = helperBridge.duplicateSharedTexture(frame.sourceHandleHex);
    importStage = 'importTexture';
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
    importStage = 'sendTexture';
    void sharedTexture.sendSharedTexture({
      frame: mainWindow.webContents.mainFrame,
      importedSharedTexture: imported,
    }, 'native-screen-frame', video.sessionId).then(() => {
      imported.release();
    }).catch((error) => {
      if (!video.failureNotified) recordVideoFailure('sendTexture', error, frame);
      imported.release();
      notifyNativeVideoError(video, 'sharedTextureTransferFailed');
    });
  } catch (error) {
    // 每次采集只保存首次失败；不记录纹理句柄、窗口标题或账号凭据。
    if (!video.failureNotified) recordVideoFailure(importStage, error, frame);
    owned?.release();
    if (imported) imported.release();
    else void mediaHelper.releaseSharedTextureSlot(video.sessionId, frame.slotIndex).catch(() => {});
    notifyNativeVideoError(video, 'sharedTextureImportFailed');
  }
}

async function startNativeVideo(sourceId, maxFps, settings) {
  if (closing) throw new Error('mediaHelperShuttingDown');
  if (process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!Number.isInteger(maxFps) || maxFps < 1 || maxFps > 120
      || typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidVideoStart');
  if (nativeVideoSession) throw new Error('videoCaptureAlreadyRunning');
  if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
  const sessionId = randomUUID();
  const video = { sessionId, sourceId, maxFps, imported: new Map(), pendingSlotReleases: new Set(), stopping: false, failureNotified: false };
  nativeVideoSession = video;
  try {
    const started = await mediaHelper.startVideo(sourceId, maxFps, sessionId, settings);
    if (started.sessionId !== sessionId || !started.changed || nativeVideoSession !== video) {
      throw new Error('mediaHelperInvalidVideoStart');
    }
    return { sessionId, changed: true };
  } catch (error) {
    if (!video.failureNotified) recordVideoFailure('startCapture', error);
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
      await mediaHelper.abortVideo(sessionId);
      video.lastError ??= 'sharedTextureReleaseTimedOut';
      throw new Error('sharedTextureReleaseTimedOut');
    }
    const result = await mediaHelper.stopVideo(sessionId);
    if (nativeVideoSession === video) nativeVideoSession = undefined;
    lastStoppedNativeVideoSession = sessionId;
    if (video.helperState?.closed) releaseHelperProcessBridge(video.helperState);
    return result;
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

function validMicrophoneSettings(settings) {
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    && Object.keys(settings).length === 4
    && typeof settings.inputGain === 'number' && Number.isFinite(settings.inputGain)
    && settings.inputGain >= 0 && settings.inputGain <= 2
    && typeof settings.noiseSuppression === 'boolean'
    && typeof settings.autoGainControl === 'boolean'
    && typeof settings.voiceEnhancement === 'boolean';
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
      ?? (/^\/api\/auth\/access\/links\/[0-9a-f-]{36}(?:\/renew)?$/i.test(url.pathname)
        && ((request.method === 'POST' && url.pathname.endsWith('/renew'))
          || (request.method === 'DELETE' && !url.pathname.endsWith('/renew'))) ? {} : undefined)
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
      if (body instanceof Buffer && body.byteLength > (routePolicy.maxBodyBytes ?? 4096)) {
        return Response.json({ code: 'REQUEST_TOO_LARGE', detail: '提交内容过大，请缩小图片或减少内容后重试。' }, { status: 413 });
      }
      const token = await loadSession();
      if (url.pathname === '/api/auth/access/redeem' && token) {
        return Response.json({ detail: '请先退出当前账号，再使用邀请链接。' }, { status: 409 });
      }
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
  // 保留桌面同源 API 和权限边界，仅把开发资源交给 Vite；热更新 WebSocket 直连本机。
  if (devRendererUrl) {
    try {
      const resourceUrl = new URL(devRendererUrl);
      resourceUrl.pathname = url.pathname;
      resourceUrl.search = url.search;
      const response = await net.fetch(resourceUrl.href);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('开发前端服务不可用，请重新运行 npm run desktop:dev。', { status: 502 });
    }
  }
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
  // 桌面只允许正式原生共享；保留拒绝处理器，避免误调用 getDisplayMedia 启动另一条采集链路。
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => denyCapture(callback));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const offer = accessLinkFromArguments(argv);
    if (offer) {
      pendingAccessLink = offer;
      mainWindow?.webContents.send('auth:access:offer', offer);
    }
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    if (existsSync(accessLinkFile)) {
      try {
        if (!pendingAccessLink) pendingAccessLink = parseAccessLink(safeStorage.decryptString(require('node:fs').readFileSync(accessLinkFile)));
        require('node:fs').unlinkSync(accessLinkFile);
      } catch {
        pendingAccessError = true;
        console.error('无法读取待确认邀请，请从邀请网页重新打开。');
      }
    }
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
    mainWindow.webContents.on('render-process-gone', () => finishClose());
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (event) => {
      // app.quit 先等待 helper 清理；确认完成后的第二次退出允许关闭窗口。
      if (canClose || allowQuitAfterMediaHelper) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      startupUpdate.cancel();
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

ipcMain.handle('clipboard:write-text', async (event, text) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  if (typeof text !== 'string' || !text || text.length > 16_384) throw new Error('复制内容无效');
  await clipboard.writeText(text);
});
ipcMain.handle('update:startup', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能检查更新');
  const state = await startupUpdate.start();
  if (!closing && !startupReady) {
    startupReady = true;
    startActivityHelper();
  }
  return state;
});
ipcMain.handle('update:state:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return startupUpdate.getState();
});
ipcMain.handle('update:check', (event) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('当前不能检查更新');
  return startupUpdate.checkOnly();
});
ipcMain.handle('update:restart', (event) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('当前不能重启更新');
  const state = startupUpdate.getState();
  if (!state.supported || state.phase !== 'ready' || state.error || !state.nextVersion) {
    throw new Error('请先检查并确认有可用的新版本');
  }
  // 走普通关窗清理通话、共享和 helper；新进程再使用唯一的启动更新链路。
  app.relaunch();
  mainWindow.close();
});
ipcMain.handle('update:skip', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  if (['idle', 'checking', 'downloading'].includes(startupUpdate.getState().phase)) startupUpdate.cancel();
});

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
ipcMain.handle('media:video-sources', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const startedAt = performance.now();
  const snapshot = await mediaHelper.listVideoSources();
  recordSourceTiming('enumerateSources', startedAt, snapshot.sources.length);
  return snapshot;
});
ipcMain.handle('media:video-source-thumbnails', async (event, sources) => {
  if (!trustedSender(event) || closing || !Array.isArray(sources) || sources.length > 128
      || sources.some((source) => !source || !/^(?:monitor|window):[1-9]\d*:\d+$/.test(source.sourceId)
        || !['monitor', 'window'].includes(source.kind) || typeof source.title !== 'string'
        || source.title.length > 256 || /[\u0000-\u001f\u007f]/.test(source.title)
        || (source.windowId !== undefined && (source.kind !== 'window'
          || typeof source.windowId !== 'string' || !/^[1-9]\d{0,19}$/.test(source.windowId)))
        || (source.kind === 'monitor' && (!source.monitorOrigin
          || !Number.isInteger(source.monitorOrigin.x) || !Number.isInteger(source.monitorOrigin.y)
          || Math.abs(source.monitorOrigin.x) > 2147483647 || Math.abs(source.monitorOrigin.y) > 2147483647
          || !Number.isInteger(source.width) || source.width < 1 || source.width > 32768
          || !Number.isInteger(source.height) || source.height < 1 || source.height > 32768)))) {
    throw new Error('请求参数无效');
  }
  if (!sources.length) return [];
  const startedAt = performance.now();
  try {
    const desktopSources = await desktopCapturer.getSources({
      types: [...new Set(sources.map((source) => source.kind === 'monitor' ? 'screen' : 'window'))],
      thumbnailSize: { width: 320, height: 180 },
    });
    recordSourceTiming('sourceThumbnails', startedAt, desktopSources.length);
    return matchNativeVideoSourceThumbnails(sources.map((source) => ({ ...source, displayId: monitorDisplayId(source, screen) })), desktopSources.map((source) => ({
      id: source.id,
      type: captureSourceType(source),
      displayId: source.display_id,
      name: source.name,
      thumbnail: { isEmpty: () => source.thumbnail.isEmpty(),
        toDataURL: () => 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(80).toString('base64') },
    })));
  } catch (error) {
    void writeMediaDiagnostic({ stage: 'sourceThumbnailsFailed', message: String(error.message).slice(0, 500) });
    // 缩略图不决定来源是否可选，失败后保留图标并按间隔重试。
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
ipcMain.handle('settings:screen-share:support', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  const build = process.platform === 'win32' ? Number(osRelease().split('.')[2]) : 0;
  return { hideCursor: build >= 19041, hideBorder: build >= 20348 };
});
ipcMain.handle('media:native-video:start', (event, sourceId, maxFps, settings) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return startNativeVideo(sourceId, maxFps, settings);
});
ipcMain.handle('media:native-video:stop', (event, sessionId) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return stopNativeVideo(sessionId);
});
ipcMain.handle('media:native-video:configure', (event, sessionId, maxFps) => {
  if (!trustedSender(event) || closing || !nativeVideoSession || nativeVideoSession.stopping
      || nativeVideoSession.sessionId !== sessionId) throw new Error('请求参数无效');
  return mediaHelper.configureVideo(sessionId, maxFps);
});
ipcMain.handle('media:remote-control:authorize', (event, sessionId, controlSessionId, controllerIdentity) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string'
      || typeof controlSessionId !== 'string' || typeof controllerIdentity !== 'string'
      || nativeVideoSession?.sessionId !== sessionId || !nativeVideoSession.sourceId.startsWith('monitor:')) {
    throw new Error('remoteControlInvalidSession');
  }
  return mediaHelper.setRemoteControl(sessionId, controlSessionId, controllerIdentity);
});
ipcMain.handle('media:remote-control:input', (event, sessionId, controlSessionId, controllerIdentity, sequence, input) => {
  if (!trustedSender(event) || closing || nativeVideoSession?.sessionId !== sessionId) {
    throw new Error('remoteControlInvalidSession');
  }
  return mediaHelper.sendRemoteInput(sessionId, controlSessionId, controllerIdentity, sequence, input);
});
ipcMain.handle('media:remote-control:revoke', (event, sessionId, controlSessionId) => {
  if (!trustedSender(event) || typeof sessionId !== 'string' || typeof controlSessionId !== 'string') {
    throw new Error('remoteControlInvalidSession');
  }
  return mediaHelper.clearRemoteControl(sessionId, controlSessionId);
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
ipcMain.on('media:native-screen-audio:consumed', (event, sessionId, sequence, droppedChunks) => {
  if (!trustedSender(event)) return;
  acknowledgeNativeScreenAudioChunk(sessionId, sequence, droppedChunks);
});
ipcMain.handle('media:native-microphone:start', (event, sessionId, settings) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128
      || !validMicrophoneSettings(settings)) throw new Error('请求参数无效');
  return startNativeMicrophoneCapture(sessionId, settings);
});
ipcMain.handle('media:native-microphone:configure', (event, sessionId, settings) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128
      || !validMicrophoneSettings(settings)) throw new Error('请求参数无效');
  return mediaHelper.configureMicrophoneCapture(sessionId, settings);
});
ipcMain.handle('media:native-microphone:stop', (event, sessionId) => {
  if (!trustedSender(event) || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return stopNativeMicrophoneCapture(sessionId);
});
ipcMain.on('media:native-microphone:consumed', (event, sessionId, sequence, droppedChunks) => {
  if (!trustedSender(event)) return;
  acknowledgeNativeMicrophoneChunk(sessionId, sequence, droppedChunks);
});
ipcMain.on('media:native-video:receiver-error', (event, failure) => {
  if (!trustedSender(event) || !nativeVideoSession || nativeVideoSession.stopping
      || failure?.sessionId !== nativeVideoSession.sessionId || typeof failure.message !== 'string') return;
  recordVideoFailure('receiveTexture', failure.message.slice(0, 2000));
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
  diagnostics.microphoneCaptureDroppedChunks = (diagnostics.microphoneCaptureDroppedChunks ?? 0)
    + (nativeMicrophoneSession
      ? nativeMicrophoneSession.droppedChunks + nativeMicrophoneSession.rendererDroppedChunks
      : lastMicrophoneDroppedChunks);
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
app.on('before-quit', (event) => {
  closing = true;
  if (startupUpdate.getState().phase !== 'installing') startupUpdate.cancel();
  stopActivityHelper();
  if (allowQuitAfterMediaHelper) return;
  event.preventDefault();
  if (mediaHelperShutdownPromise) return;
  mediaHelperShutdownPromise = (nativeScreenAudioSession
    ? stopNativeScreenAudio(nativeScreenAudioSession.sessionId).catch((error) => {
      console.error(`native screen audio shutdown failed: ${error.message}`);
    })
    : Promise.resolve())
    .then(() => nativeMicrophoneSession
      ? stopNativeMicrophoneCapture(nativeMicrophoneSession.sessionId).catch((error) => {
        console.error(`native microphone shutdown failed: ${error.message}`);
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

ipcMain.handle('settings:server:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return { apiUrl: backend.origin, editable: true };
});
ipcMain.handle('auth:access:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  if (pendingAccessError) throw new Error('无法读取待确认邀请，请从网页重新打开。');
  const offer = pendingAccessLink;
  pendingAccessLink = null;
  return offer;
});
ipcMain.handle('auth:access:parse', async (event, value) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  if (await loadSession()) throw new Error('请先退出当前账号。');
  return parseManualAccessLink(value);
});
ipcMain.handle('auth:access:prepare', async (event, offer) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  if (await loadSession()) throw new Error('请先退出当前账号。');
  const link = `lycansync://access?server=${encodeURIComponent(offer?.server ?? '')}#token=${offer?.token ?? ''}`;
  const validated = parseAccessLink(link);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用。');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(accessLinkFile, safeStorage.encryptString(link));
  await saveServerSettings(app.getPath('userData'), validated.server);
  app.relaunch();
  app.quit();
});
ipcMain.handle('settings:server:set', async (event, value) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能修改服务器地址。');
  if (await loadSession()) throw new Error('请退出登录后再修改服务器地址。');
  await saveServerSettings(app.getPath('userData'), value);
  app.relaunch();
  app.quit();
});

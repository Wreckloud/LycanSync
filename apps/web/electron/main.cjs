const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, net, powerMonitor, protocol, screen, session, safeStorage, shell, sharedTexture } = require('electron');
const { release: osRelease } = require('node:os');
const { createServer } = require('node:net');
const { existsSync } = require('node:fs');
const { Module } = require('node:module');
const { isAbsolute, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { MediaHelperManager } = require('./media-helper.cjs');
const { ObsCaptureHostManager } = require('./obs-capture-host.cjs');
const { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader } = require('./media-diagnostics.cjs');
const { loadServerSettings, saveServerSettings } = require('./server-settings.cjs');
const { matchNativeVideoSourceThumbnails, monitorDisplayId } = require('./native-video-thumbnails.cjs');
const { parseAccessLink, accessLinkFromArguments, parseManualAccessLink } = require('./access-links.cjs');
const { createStartupUpdate } = require('./startup-update.cjs');
const { applyRuntimePaths } = require('./runtime-paths.cjs');
const { createActivityHelper } = require('./activity-helper.cjs');
const { createVoiceOverlay } = require('./voice-overlay.cjs');
const { initialWindowBounds, createWindowLayout } = require('./window-layout.cjs');
const { createScreenShareWindows } = require('./screen-share-windows.cjs');

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
  ['GET /api/rtc/room-occupancies', {}],
  ['POST /api/presence/heartbeat', {}],
  ['GET /api/groups', {}],
  // 后端接受最多 2 MiB 的裁剪图片，另留 Base64 膨胀、文本与 JSON 的空间。
  ['POST /api/groups', { maxBodyBytes: 3 * 1024 * 1024 }],
  ['POST /api/groups/join', {}],
]);
const groupPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupManagementPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:candidates|members|owner|invite-code(?:\/refresh)?)$/i;
const groupMemberPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/members\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupPresencePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presences$/i;
const groupPresenceChangesPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/presence-changes$/i;
const groupMessagePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages$/i;
const groupAttachmentPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupFilePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files(?:\/(?:requests\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const groupFileDownloadPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.setName('LycanSync');
// 来源缩略图仍由 Chromium 截取；避免部分 Win10 窗口的 WGC 缩略图采集拖慢系统壳层。
// 正式视频流由 OBS 采集，此开关不改变其后端，也不关闭 GPU 合成或 WebRTC 编码。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer');
}
// 运行数据、Chromium 缓存和更新包都放在安装目录；--user-data-dir 仍用于测试隔离。
const runtimeLayout = applyRuntimePaths({
  app,
  packaged: app.isPackaged,
  execPath: process.execPath,
  projectDirectory: resolve(__dirname, '../../..'),
  explicitUserDataDir: app.commandLine.hasSwitch('user-data-dir')
    ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
});
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
let windowLayout;
const screenShareWindows = createScreenShareWindows();
let closing = false;
let canClose = false;
let closeTimer;
let sessionToken;
let sessionLoaded = false;
let currentActivity = null;
let startupReady = false;
let allowQuitAfterMediaHelper = false;
let mediaHelperShutdownPromise;
let nativeMediaBridge;
let nativeVideoSession;
let nativeVideoSourcesById = new Map();
let lastStoppedNativeVideoSession;
let nativeScreenAudioSession;
let lastScreenAudioDroppedChunks = 0;
let nativeMicrophoneSession;
let lastMicrophoneDroppedChunks = 0;
const helperProcessBridges = new WeakMap();
const writeMediaDiagnostic = createMediaDiagnostics(resolve(app.getPath('userData'), 'screen-share-error.log'));
const diagnosticStartedAt = Date.now();
const diagnosticStartedMonotonicAt = performance.now();
const sourceTimingRecordedAt = new Map();
let diagnosticExportPending = false;
const readProcessMetrics = createProcessMetricsReader((pid, executablePath) => {
  nativeMediaBridge ??= loadNativeMediaBridge();
  return nativeMediaBridge.openSpawnedMediaHelper(pid, executablePath);
});
const voiceOverlay = createVoiceOverlay({
  BrowserWindow, screen, session, net, rendererRoot, devRendererUrl,
  defaultDisplay: () => mainWindow ? screen.getDisplayMatching(mainWindow.getBounds()).id : screen.getPrimaryDisplay().id,
  onError: (message) => mainWindow?.webContents.send('voice-overlay:error', message),
  onPlacement: (settings) => mainWindow?.webContents.send('voice-overlay:placement', settings),
  onEditingChange: (editing) => mainWindow?.webContents.send('voice-overlay:editing', editing),
  onDiagnostic: (entry) => { void writeMediaDiagnostic(entry); },
});
const startupUpdate = createStartupUpdate({
  enabled: app.isPackaged && process.platform === 'win32',
  version: app.getVersion(),
  // app-update.yml 来自安装包，不能跟随用户选择的业务服务器改变。
  createUpdater: () => require('electron-updater').autoUpdater,
  updaterCachePath: runtimeLayout.updaterCachePath,
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
  const code = String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1];
  void writeMediaDiagnostic({
    stage, code, message: String(error?.message ?? error).slice(0, 2000),
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
  onMicrophoneCaptureEnded: handleMicrophoneCaptureEnded,
  onHelperFailure: handleMediaHelperFailure,
});

function obsCaptureHostSettings() {
  const root = app.isPackaged ? resolve(process.resourcesPath, 'obs-capture')
    : resolve(__dirname, '../../../release/build-cache/obs-32.2.2/prepared');
  return {
    executablePath: resolve(root, 'bin/64bit/lycansync-obs-capture-host.exe'),
    modulePath: resolve(root, 'obs-plugins/64bit/win-capture.dll'),
    dataPath: resolve(root, 'data/obs-plugins/win-capture'),
  };
}

const obsHostSettings = obsCaptureHostSettings();
const obsCaptureHost = new ObsCaptureHostManager({
  ...obsHostSettings,
  configPath: resolve(app.getPath('userData'), 'obs-capture', '32.2.2'),
  onFrame: handleNativeSharedTextureFrame,
  onFailure: (state, error) => {
    const video = nativeVideoSession;
    if (video && video.sessionId === state.videoSessionId && !video.stopping) {
      if (error.message === 'captureTargetClosed') void writeMediaDiagnostic({ stage: 'screenTargetClosed', code: error.message });
      else recordVideoFailure('obsCaptureHost', error);
      const code = ['captureTargetClosed', 'captureSettingsUnsupported', 'captureBorderAccessDenied',
        'obsGameBindingUnavailable', 'obsGameTargetMismatch', 'dxgiMonitorUnavailable', 'dxgiAdapterMismatch'].includes(error.message)
        ? error.message : 'obsCaptureHostFailed';
      notifyNativeVideoError(video, code);
    }
  },
  onAudioFailure: (state, failure) => {
    const audio = nativeScreenAudioSession;
    if (audio && audio.sessionId === state.videoSessionId && audio.pipeId === failure.audioId) {
      notifyNativeScreenAudioError(audio, failure.code);
    }
  },
  onAudioStopped: handleObsScreenAudioStopped,
  onClosed: (state) => {
    handleObsScreenAudioStopped(state);
    releaseHelperProcessBridge(state);
  },
  onSuspended: handleVideoCaptureSuspended,
  onCaptureDiagnostic: (_state, entry) => { void writeMediaDiagnostic(entry); },
  onDiagnostic: (message) => { void writeMediaDiagnostic({ stage: 'obsCaptureHostStderr', message }); },
});

let obsCorePreparationRequested = false;
let obsBackgroundPreparationFailed = false;
function prepareObsCapture(graphics) {
  if (closing || obsBackgroundPreparationFailed || process.platform !== 'win32'
      || !Object.values(obsHostSettings).every(path => existsSync(path))) return;
  if (!graphics && obsCorePreparationRequested) return;
  if (graphics && obsCaptureHost.state?.preparePromise) return;
  obsCorePreparationRequested = true;
  const startedAt = performance.now();
  void obsCaptureHost.prepare(graphics).then(() => {
    void writeMediaDiagnostic({ stage: graphics ? 'obsGraphicsPrepared' : 'obsCorePrepared',
      durationMs: Math.round(performance.now() - startedAt) });
  }).catch(error => {
    // 后台失败只记录一次；下一次用户确认共享仍可显式重试，不循环启动失败的宿主。
    obsBackgroundPreparationFailed = true;
    void writeMediaDiagnostic({ stage: 'obsPrewarmFailed', message: error.message });
  });
}

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

function releaseNativeVideoSlot(state, sessionId, slotIndex) {
  return state.releaseSharedTextureSlot(sessionId, slotIndex);
}

function screenShareAudioCapability() {
  const build = process.platform === 'win32' ? Number(osRelease().split('.')[2]) : 0;
  if (build >= 19041) return { available: true, reason: 'windowsApplicationLoopbackProcessTree' };
  if (build >= 15063) return { available: true, reason: 'windowsSystemMixLoopback' };
  return { available: false, reason: process.platform === 'win32'
    ? 'windowsEventDrivenLoopbackRequiresBuild15063' : 'platformUnsupported' };
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

function handleObsScreenAudioStopped(state, event) {
  const audio = nativeScreenAudioSession;
  if (!audio || audio.sessionId !== state.videoSessionId
      || (event && event.audioId !== audio.pipeId)) return;
  notifyNativeScreenAudioError(audio, 'screenShareAudioFailed');
  finishNativeScreenAudioPipe(audio, { destroy: true });
  lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
  if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
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
  if (nativeScreenAudioSession !== audio || audio.stopping || !audio.format || audio.inFlight || !audio.queue.length
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
  void stopNativeScreenAudio(audio.sessionId).catch((error) => {
    void writeMediaDiagnostic({ stage: 'stopScreenAudioAfterFailure', message: String(error.message).slice(0, 500) });
  });
}

async function startNativeScreenAudio(sourceId, sessionId) {
  const video = nativeVideoSession;
  if (closing || process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!video || video.starting || video.stopping || video.sessionId !== sessionId || video.sourceId !== sourceId) {
    throw new Error('videoSourceExpired');
  }
  if (nativeScreenAudioSession) {
    if (nativeScreenAudioSession.sessionId === sessionId && !nativeScreenAudioSession.stopping) {
      return nativeScreenAudioSession.startPromise;
    }
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
  audio.startPromise = (async () => {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
        const onListening = () => { server.removeListener('error', onError); resolveListen(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(`\\\\.\\pipe\\lycansync-screen-audio-${pipeId}`);
      });
      if (nativeScreenAudioSession !== audio || audio.stopping || nativeVideoSession !== video || video.stopping) {
        throw new Error('screenShareAudioSessionStopped');
      }
      const capability = screenShareAudioCapability();
      const mode = capability.available && capability.reason === 'windowsApplicationLoopbackProcessTree' ? 'process'
        : capability.available && capability.reason === 'windowsSystemMixLoopback' ? 'systemMix' : undefined;
      if (!mode) throw new Error('screenShareAudioUnsupported');
      audio.captureStart = obsCaptureHost.startScreenAudio(sessionId, pipeId, mode);
      const format = await audio.captureStart;
      if (nativeScreenAudioSession !== audio || audio.stopping || nativeVideoSession !== video || video.stopping) {
        throw new Error('screenShareAudioSessionStopped');
      }
      audio.sampleRate = format.sampleRate;
      audio.format = format;
      sendNextNativeScreenAudioChunk(audio);
      return format;
    } catch (error) {
      finishNativeScreenAudioPipe(audio, { destroy: true });
      try { if (nativeScreenAudioSession === audio) await stopScreenAudioCapture(audio); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '共享声音启动失败，清理未确认。');
      }
      if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
      throw error;
    }
  })();
  return audio.startPromise;
}

async function stopScreenAudioCapture(audio) {
  if (!audio.captureStart) return { changed: false };
  return obsCaptureHost.stopScreenAudio(audio.sessionId, audio.pipeId);
}

async function stopNativeScreenAudio(sessionId) {
  const audio = nativeScreenAudioSession;
  if (!audio) return { changed: false };
  if (audio.sessionId !== sessionId) throw new Error('screenShareAudioSessionMismatch');
  if (audio.stopPromise) return audio.stopPromise;
  audio.stopPromise = (async () => {
    const helperStop = stopScreenAudioCapture(audio);
    // 先切断本机交付，再等待来源清理；失败时保留身份，不能重新启动声音。
    finishNativeScreenAudioPipe(audio, { destroy: true });
    try {
      const result = await helperStop;
      if (nativeScreenAudioSession === audio) nativeScreenAudioSession = undefined;
      return result;
    } finally {
      if (!nativeScreenAudioSession || nativeScreenAudioSession === audio) {
        lastScreenAudioDroppedChunks = audio.droppedChunks + audio.rendererDroppedChunks;
      }
    }
  })();
  return audio.stopPromise;
}

function handleMediaHelperFailure(state, code) {
  const video = nativeVideoSession;
  if (video && (video.helperState === state || video.targetState === state
      || (!video.helperState && state.videoSessionId === video.sessionId))) {
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
      void releaseNativeVideoSlot(state, frame.sessionId, frame.slotIndex).catch(() => {});
    }
    return;
  }
  video.helperState = state;
  if (!video.sourceFrameReceived) {
    video.sourceFrameReceived = true;
    void writeMediaDiagnostic({ stage: 'obsSourceFirstFrame', durationMs: Math.round(performance.now() - video.startedAt) });
  }
  video.frameWidth = frame.contentSize.width;
  video.frameHeight = frame.contentSize.height;
  let helperBridge = helperProcessBridges.get(state);
  let owned;
  let imported;
  let importStage = 'loadBridge';
  let importRegistered = false;
  let releaseBeforeRegistration = false;
  let slotReleaseStarted = false;
  let mainReferenceReleased = false;
  let transferPending = false;
  const releaseImport = () => {
    // Electron 确认交付时才登记接收方引用，提前释放会让迟到确认找不到纹理。
    if (!imported || mainReferenceReleased || transferPending) return;
    // 正常交付和停止清理可能先后到达，同一主进程引用只能归还一次。
    mainReferenceReleased = true;
    imported.release();
  };
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
      void releaseNativeVideoSlot(state, video.sessionId, frame.slotIndex).catch((error) => {
        if (!video.failureNotified) recordVideoFailure('releaseTextureSlot', error, frame);
        notifyNativeVideoError(video, 'sharedTextureSlotReleaseFailed');
      }).finally(() => video.pendingSlotReleases.delete(frame.slotIndex));
    }
  };
  try {
    if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
    if (!helperBridge) {
      importStage = 'openHelper';
      helperBridge = nativeMediaBridge.openSpawnedMediaHelper(state.child.pid, state.executablePath ?? mediaHelperPath());
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
      releaseImport();
      return;
    }
    video.imported.set(frame.slotIndex, { release: releaseImport });
    importRegistered = true;
    importStage = 'sendTexture';
    transferPending = true;
    void sharedTexture.sendSharedTexture({
      frame: mainWindow.webContents.mainFrame,
      importedSharedTexture: imported,
    }, 'native-screen-frame', video.sessionId).then(() => {
      transferPending = false;
      releaseImport();
      if (!video.textureDelivered && !video.stopping && nativeVideoSession === video) {
        video.textureDelivered = true;
        void writeMediaDiagnostic({ stage: 'screenTextureDelivered', durationMs: Math.round(performance.now() - video.startedAt) });
      }
    }).catch((error) => {
      transferPending = false;
      if (!video.failureNotified) recordVideoFailure('sendTexture', error, frame);
      releaseImport();
      notifyNativeVideoError(video, 'sharedTextureTransferFailed');
    });
  } catch (error) {
    transferPending = false;
    // 每次采集只保存首次失败；不记录纹理句柄、窗口标题或账号凭据。
    if (!video.failureNotified) recordVideoFailure(importStage, error, frame);
    owned?.release();
    if (imported) releaseImport();
    else void releaseNativeVideoSlot(state, video.sessionId, frame.slotIndex).catch(() => {});
    notifyNativeVideoError(video, 'sharedTextureImportFailed');
  }
}

async function startNativeVideo(sourceId, maxFps, settings, resolution) {
  if (closing) throw new Error('mediaHelperShuttingDown');
  if (process.platform !== 'win32') throw new Error('platformUnsupported');
  if (![30, 60, 120].includes(maxFps)
      || typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidVideoStart');
  if (nativeVideoSession) throw new Error('videoCaptureAlreadyRunning');
  if (!nativeMediaBridge) nativeMediaBridge = loadNativeMediaBridge();
  const sessionId = randomUUID();
  const source = nativeVideoSourcesById.get(sourceId);
  if (!source || !sourceId.startsWith(`${source.kind}:`)) throw new Error('videoSourceExpired');
  const video = { sessionId, sourceId, sourceKind: source.kind, starting: true,
    startedAt: performance.now(),
    imported: new Map(), pendingSlotReleases: new Set(), stopping: false, failureNotified: false };
  nativeVideoSession = video;
  void writeMediaDiagnostic({ stage: 'screenVideoStartRequested', sourceKind: source.kind,
    width: resolution?.width, height: resolution?.height, maxFps,
    hostReused: Boolean(obsCaptureHost.state && !obsCaptureHost.state.closed && !obsCaptureHost.state.failed) });
  try {
    const reservation = mediaHelper.reserveVideo(sessionId, sourceId);
    video.targetState = mediaHelper.videoCapture?.state;
    let target = await reservation;
    if (closing || video.stopping || nativeVideoSession !== video) throw new Error('nativeVideoSessionStopped');
    void writeMediaDiagnostic({ stage: 'screenSourceReserved', durationMs: Math.round(performance.now() - video.startedAt) });
    if (target.kind === 'window') {
      const game = await activityMonitor.isCaptureGame(target.executable);
      // 程序分类只决定采集方式；授权范围仍是注册表预留的精确窗口实例。
      const { windowId, propertyName, propertyValue } = target;
      target = { kind: game ? 'game' : 'window', windowId, propertyName, propertyValue };
    }
    if (closing || video.stopping || nativeVideoSession !== video) throw new Error('nativeVideoSessionStopped');
    const obsStartedAt = performance.now();
    const start = obsCaptureHost.start(sourceId, maxFps, sessionId, target, settings, resolution);
    video.helperState = obsCaptureHost.state;
    const started = await start;
    if (started.sessionId !== sessionId || !started.changed || closing || video.stopping || nativeVideoSession !== video) {
      throw new Error('mediaHelperInvalidVideoStart');
    }
    video.starting = false;
    void writeMediaDiagnostic({ stage: 'obsReady', durationMs: Math.round(performance.now() - obsStartedAt) });
    return { sessionId, changed: true };
  } catch (error) {
    if (!video.failureNotified) recordVideoFailure('startCapture', error);
    video.stopping = true;
    releaseNativeVideoImports(video);
    try { await stopObsVideo(video); }
    catch (stopError) {
      recordVideoFailure('stopObsCaptureAfterStartFailure', stopError);
      throw new Error('obsCaptureStopUnconfirmed');
    }
    if (nativeVideoSession === video) nativeVideoSession = undefined;
    throw error;
  }
}

async function stopObsVideo(video) {
  // 未确认采集清理或宿主退出时保留来源身份，不能让另一来源越过清理。
  const state = obsCaptureHost.state;
  const ownsCapture = !state || state.videoSessionId === video.sessionId;
  const stopped = ownsCapture
    ? await obsCaptureHost.stop(video.sessionId) : { changed: false };
  if (video.helperState && (video.helperState !== state || ownsCapture)) releaseHelperProcessBridge(video.helperState);
  if (video.targetState && mediaHelper.videoCapture?.sessionId === video.sessionId) {
    const released = await mediaHelper.stopVideo(video.sessionId);
    return { changed: stopped.changed || released.changed };
  }
  return stopped;
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
  const startedAt = performance.now();
  video.stopPromise = (async () => {
    // 先撤销输入和释放按住的键；画面/GPU 回收再慢也不能继续接受远控。
    const active = mediaHelper.videoCapture;
    const control = active?.sessionId === sessionId ? active.remoteControl : undefined;
    let controlFailure;
    if (control) {
      try { await mediaHelper.clearRemoteControl(sessionId, control.controlSessionId); }
      catch (error) {
        controlFailure = error;
        recordVideoFailure('revokeRemoteControlBeforeVideoStop', error);
      }
    }
    if (nativeScreenAudioSession?.sessionId === sessionId) {
      await stopNativeScreenAudio(sessionId).catch(() => {});
    }
    const deadline = Date.now() + 1_200;
    while ((video.imported.size || video.pendingSlotReleases.size) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (video.imported.size || video.pendingSlotReleases.size) {
      void writeMediaDiagnostic({ stage: 'screenTextureReleaseTimeout',
        importedCount: video.imported.size, pendingReleaseCount: video.pendingSlotReleases.size });
      releaseNativeVideoImports(video);
      // 外部纹理未归还时不复用宿主；退出确认后才释放来源并允许下一次共享。
      await obsCaptureHost.shutdown(true, 'textureTimeout');
      await stopObsVideo(video);
      void writeMediaDiagnostic({ stage: 'screenVideoStopRecovered' });
    } else {
      await stopObsVideo(video);
    }
    if (controlFailure) throw controlFailure;
    if (nativeVideoSession === video) nativeVideoSession = undefined;
    lastStoppedNativeVideoSession = sessionId;
    void writeMediaDiagnostic({ stage: 'screenVideoStopped', durationMs: Math.round(performance.now() - startedAt) });
    return { changed: true };
  })().catch(error => {
    void writeMediaDiagnostic({ stage: 'screenVideoStopFailed',
      code: String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1],
      durationMs: Math.round(performance.now() - startedAt) });
    throw error;
  });
  return video.stopPromise;
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

const activityMonitor = createActivityHelper({ enabled: process.platform === 'win32', executablePath: activityHelperPath,
  onActivity: (activity) => {
    currentActivity = activity;
    if (!closing && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('activity:changed', activity);
  } });

function startActivityHelper() { if (!closing) activityMonitor.start(); }
function stopActivityHelper() { activityMonitor.stop(); }

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
  screenShareWindows.closeAll();
  sessionToken = undefined;
  sessionLoaded = true;
  activityMonitor.clearMappings();
  voiceOverlay.clear();
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
  screenShareWindows.closeAll();
  voiceOverlay.clear();
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
      ?? (request.method === 'PUT' && groupPath.test(url.pathname) ? { maxBodyBytes: 3 * 1024 * 1024 } : undefined)
      ?? (request.method === 'DELETE' && (groupPath.test(url.pathname) || groupMemberPath.test(url.pathname)) ? {} : undefined)
      ?? (groupManagementPath.test(url.pathname) && ((request.method === 'GET' && url.pathname.endsWith('/candidates'))
        || (request.method === 'POST' && !url.pathname.endsWith('/candidates'))) ? {} : undefined)
      // 图片 multipart 保持原有限制，普通文件只按流转发到固定的上传路径。
      ?? (request.method === 'POST' && groupMessagePath.test(url.pathname) ? { maxBodyBytes: 6 * 1024 * 1024 } : undefined)
      ?? (request.method === 'POST' && groupFilePath.test(url.pathname) && url.pathname.endsWith('/files')
        ? { streamBody: true } : undefined);
    if (!routePolicy) return new Response(null, { status: 404 });
    let failureMessage = '无法读取请求内容，请重试。';
    try {
      const streamingUpload = routePolicy.streamBody === true;
      const body = streamingUpload ? request.body
        : ['POST', 'PUT'].includes(request.method) ? Buffer.from(await request.arrayBuffer()) : undefined;
      if (body instanceof Buffer && body.byteLength > (routePolicy.maxBodyBytes ?? 4096)) {
        return Response.json({ code: 'REQUEST_TOO_LARGE', detail: '提交内容过大，请缩小图片或减少内容后重试。' }, { status: 413 });
      }
      failureMessage = '无法读取本机登录凭据，请清理本机登录凭据后重试。';
      const token = await loadSession();
      if (url.pathname === '/api/auth/access/redeem' && token) {
        return Response.json({ detail: '请先退出当前账号，再使用邀请链接。' }, { status: 409 });
      }
      failureMessage = '无法连接业务服务，请检查网络和服务器状态。';
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
        body, ...(streamingUpload ? { duplex: 'half' } : {}), redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([request.signal,
          AbortSignal.timeout(streamingUpload || groupFileDownloadPath.test(url.pathname) ? 30 * 60_000
            : routePolicy.longPolling ? 52_000 : 15000)]),
      });
      const currentSessionUnauthorized = !routePolicy.public && Boolean(token)
        && response.status === 401 && token === sessionToken;
      if (!routePolicy.public && token === sessionToken
          && (response.status === 401 || (routePolicy.clearsSession && response.ok))) {
        try { await clearSession(); }
        catch {
          // 服务端已结束会话，文件清理失败也不能继续展示为已登录。
          return Response.json({ code: 'LOCAL_SESSION_CLEAR_FAILED', message: '登录已结束，但无法清理本机凭据，请检查数据目录权限。' }, {
            status: currentSessionUnauthorized ? 401 : 502,
            headers: { 'Cache-Control': 'no-store',
              ...(currentSessionUnauthorized ? { 'X-Lycan-Session-Expired': 'true' } : {}) },
          });
        }
      }
      if (routePolicy.savesSession && response.ok) {
        failureMessage = '登录响应无法确认，请重试或联系服主。';
        const result = await response.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result?.sessionToken ?? '')
            || typeof result.user?.id !== 'string' || !result.user.id
            || typeof result.user.nickname !== 'string' || typeof result.user.avatar !== 'string'
            || typeof result.user.administrator !== 'boolean') throw new Error('登录响应无效');
        failureMessage = '无法保存本机登录凭据，请检查数据目录权限和系统加密后重试。';
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
      return Response.json({ message: failureMessage }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
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
    void writeMediaDiagnostic({ stage: 'applicationReady', appVersion: app.getVersion(),
      electronVersion: process.versions.electron, platform: process.platform, arch: process.arch,
      osVersion: osRelease(), durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt) });
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
    voiceOverlay.initialize();
    screen.on('display-added', voiceOverlay.correctPlacement);
    screen.on('display-removed', voiceOverlay.correctPlacement);
    screen.on('display-metrics-changed', voiceOverlay.correctPlacement);
    powerMonitor.on('resume', voiceOverlay.correctPlacement);
    powerMonitor.on('unlock-screen', voiceOverlay.correctPlacement);
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // 首次显示即使用紧凑尺寸，避免先闪出主窗口再收缩。
    mainWindow = new BrowserWindow({
      ...initialWindowBounds(workArea), resizable: false, maximizable: false,
      title: 'LycanSync', frame: false, show: false, backgroundColor: '#10151a',
      webPreferences: { preload: resolve(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    windowLayout = createWindowLayout(mainWindow, screen);
    mainWindow.setMenu(null);
    screenShareWindows.attach(mainWindow);
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.webContents.once('did-finish-load', () => {
      void writeMediaDiagnostic({ stage: 'rendererReady', durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt) });
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      void writeMediaDiagnostic({ stage: 'rendererExited', outcome: details.reason });
      finishClose();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (event) => {
      // app.quit 先等待 helper 清理；确认完成后的第二次退出允许关闭窗口。
      if (canClose || allowQuitAfterMediaHelper) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      screenShareWindows.closeAll();
      voiceOverlay.clear();
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
ipcMain.handle('window:visibility', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return screenShareWindows.mainVisible();
});
ipcMain.handle('viewer:ready', (event) => {
  if (closing) throw new Error('应用正在关闭。');
  return screenShareWindows.ready(event);
});
ipcMain.handle('viewer:pin', (event, enabled) => {
  if (closing) throw new Error('应用正在关闭。');
  return screenShareWindows.pin(event, enabled);
});
ipcMain.handle('viewer:focus', (event, id) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  screenShareWindows.focus(id);
});
ipcMain.handle('viewer:fullscreen', (event, enabled) => {
  if (closing) throw new Error('应用正在关闭。');
  screenShareWindows.fullscreen(event, enabled);
});
ipcMain.handle('window:layout', (event, mode, height) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  windowLayout.apply(mode, height);
  if (mode === 'main') prepareObsCapture(false);
});
ipcMain.handle('window:is-maximized', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return mainWindow.isMaximized();
});
ipcMain.handle('diagnostics:process-metrics', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return readProcessMetrics(app.getAppMetrics(), [
    { role: 'obs', children: obsCaptureHost.state ? [obsCaptureHost.state.child] : [], executablePath: obsHostSettings.executablePath },
    { role: 'media', children: [...mediaHelper.children].map((state) => state.child), executablePath: mediaHelperPath() },
    { role: 'activity', children: activityMonitor.diagnosticProcesses(), executablePath: activityHelperPath() },
  ], process.platform === 'win32');
});
ipcMain.handle('diagnostics:export', async (event, text) => {
  if (!trustedSender(event) || closing || diagnosticExportPending) throw new Error('当前不能导出诊断。');
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('诊断报告过大或无效。');
  const report = JSON.parse(text);
  if (!report || report.kind !== 'lycansync-diagnostics' || report.schemaVersion !== 9 || !Array.isArray(report.samples)
      || report.samples.length > 900 || !Number.isFinite(Date.parse(report.startedAt))
      || !Number.isFinite(Date.parse(report.endedAt)) || Date.parse(report.endedAt) < Date.parse(report.startedAt)) {
    throw new Error('诊断报告无效。');
  }
  diagnosticExportPending = true;
  try {
    await writeMediaDiagnostic.flush();
    const eventStartedAt = Math.min(diagnosticStartedAt, Date.parse(report.startedAt));
    const eventEndedAt = Date.now();
    const events = await readDiagnosticEvents(resolve(app.getPath('userData'), 'screen-share-error.log'),
      eventStartedAt, eventEndedAt);
    if (!trustedSender(event) || closing) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断报告', defaultPath: `LycanSync-diagnostics-${Date.now()}.json`,
      filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath || !trustedSender(event) || closing) return { saved: false };
    report.environment = { appVersion: app.getVersion(), electronVersion: process.versions.electron,
      platform: process.platform, arch: process.arch, osVersion: osRelease(), gpuFeatures: app.getGPUFeatureStatus(),
      gpuUtilization: null };
    report.events = events;
    report.eventWindow = { startedAt: new Date(eventStartedAt).toISOString(), endedAt: new Date(eventEndedAt).toISOString() };
    report.eventLimit = '最多读取当前及上一份日志各256KiB，保留本次启动至导出最近200项；不含异常正文';
    await writeFile(result.filePath, JSON.stringify(report), 'utf8');
    return { saved: true };
  } finally { diagnosticExportPending = false; }
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
ipcMain.handle('activity:windows', (event) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('请求来源无效');
  return activityMonitor.listWindows();
});
ipcMain.handle('activity:configure', (event, mappings) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('请求来源无效');
  return activityMonitor.configure(mappings);
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
    const runtimeAvailable = Object.values(obsHostSettings).every((path) => existsSync(path));
    capabilities.videoCapture = { available: bridgeAvailable && runtimeAvailable,
      reason: !bridgeAvailable ? 'nativeVideoBridgeUnavailable' : runtimeAvailable ? 'available' : 'obsCaptureHostUnavailable' };
    capabilities.screenShareAudioCapture = screenShareAudioCapability();
    return capabilities;
  });
});
ipcMain.handle('media:video-sources', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const startedAt = performance.now();
  // 图形准备与来源枚举并行，不在选择器打开前创建真实采集来源。
  prepareObsCapture(true);
  const snapshot = await mediaHelper.listVideoSources();
  nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
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
ipcMain.handle('settings:screen-share:support', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  const build = process.platform === 'win32' ? Number(osRelease().split('.')[2]) : 0;
  return { hideCursor: build >= 19041, hideBorder: build >= 20348 };
});
ipcMain.handle('media:native-video:start', (event, sourceId, maxFps, settings, resolution) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const startedAt = performance.now();
  return startNativeVideo(sourceId, maxFps, settings, resolution).catch(error => {
    void writeMediaDiagnostic({ stage: 'screenVideoStartFailed',
      code: String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1],
      durationMs: Math.round(performance.now() - startedAt) });
    throw error;
  });
});
ipcMain.on('media:screen-share-startup', (event, sessionId, stage, durationMs, audioTiming) => {
  const video = nativeVideoSession;
  if (!trustedSender(event) || closing || !video || video.starting || video.stopping
      || video.sessionId !== sessionId
      || !['screenVideoFirstFrame', 'screenVideoStartupFailed', 'screenAudioStartup', 'screenVideoPublished'].includes(stage)
      || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 300_000) return;
  let audioDetails;
  if (stage === 'screenVideoStartupFailed') {
    if (!['nativeVideoFirstFrameTimeout', 'nativeVideoFrameAdjustmentFailed', 'nativeVideoTrackWriteFailed',
      'nativeVideoSessionStopped', 'nativeVideoFailed'].includes(audioTiming?.code)) return;
    audioDetails = { code: audioTiming.code };
  }
  if (stage === 'screenAudioStartup') {
    if (!audioTiming || !['published', 'failed'].includes(audioTiming.outcome)
        || !['capture', 'graph', 'publish'].includes(audioTiming.phase)) return;
    audioDetails = { outcome: audioTiming.outcome, phase: audioTiming.phase };
    for (const key of ['pluginLoadMs', 'captureReadyMs', 'graphReadyMs', 'publishMs']) {
      const value = audioTiming[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > 300_000) return;
      audioDetails[key] = Math.round(value);
    }
  }
  // 每个采集会话每阶段只保留一次，不记录来源名称、句柄或会话标识。
  video.startupTimings ??= new Set();
  if (video.startupTimings.has(stage)) return;
  video.startupTimings.add(stage);
  void writeMediaDiagnostic({ stage, durationMs: Math.round(durationMs), ...audioDetails });
});
ipcMain.handle('media:native-video:stop', (event, sessionId) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return stopNativeVideo(sessionId);
});
ipcMain.handle('media:native-video:configure', (event, sessionId, maxFps, resolution) => {
  if (!trustedSender(event) || closing || !nativeVideoSession || nativeVideoSession.stopping
      || nativeVideoSession.sessionId !== sessionId) throw new Error('请求参数无效');
  return obsCaptureHost.configureVideo(sessionId, maxFps, resolution);
});
ipcMain.handle('media:remote-control:authorize', (event, sessionId, controlSessionId, controllerIdentity) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string'
      || typeof controlSessionId !== 'string' || typeof controllerIdentity !== 'string'
      || nativeVideoSession?.sessionId !== sessionId || nativeVideoSession.starting || nativeVideoSession.stopping
      || !nativeVideoSession.sourceId.startsWith('monitor:')) {
    throw new Error('remoteControlInvalidSession');
  }
  return mediaHelper.setRemoteControl(sessionId, controlSessionId, controllerIdentity);
});
ipcMain.handle('media:remote-control:input', (event, sessionId, controlSessionId, controllerIdentity, sequence, input) => {
  if (!trustedSender(event) || closing || nativeVideoSession?.sessionId !== sessionId
      || nativeVideoSession.starting || nativeVideoSession.stopping || !nativeVideoSession.sourceId.startsWith('monitor:')) {
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
  const video = nativeVideoSession;
  if (video) {
    const obsDiagnostics = await obsCaptureHost.getDiagnostics(video.sessionId);
    if (nativeVideoSession !== video) throw new Error('videoSessionMismatch');
    const state = video.helperState;
    Object.assign(diagnostics, {
      helperVersion: obsDiagnostics.helperVersion, captureBackend: 'obsLibobs',
      state: video.stopping ? 'stopping' : 'running', sessionId: video.sessionId, available: Boolean(state?.alive),
      sourceKind: video.sourceKind, frameWidth: video.frameWidth ?? null, frameHeight: video.frameHeight ?? null,
      framesReceived: obsDiagnostics.renderedFrames, framesProcessed: obsDiagnostics.bridgeFrames,
      obsBridgeDroppedFrames: obsDiagnostics.bridgeDroppedFrames, captureSuspended: video.suspended ?? null,
      obsRender: obsDiagnostics.obsRender,
      screenShareAudio: { ...obsDiagnostics.screenShareAudio, sessionId: video.sessionId, sourceKind: video.sourceKind },
    });
  } else {
    diagnostics.obsBridgeDroppedFrames = null;
    diagnostics.obsRender = null;
  }
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
  if (!trustedSender(event) || !mainWindow.isMaximizable()) return;
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
  voiceOverlay.clear();
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
    .then(() => obsCaptureHost.dispose().catch(error => {
      console.error(`OBS host shutdown failed: ${error.message}`);
    }))
    .then(() => mediaHelper.shutdown())
    .catch((error) => console.error(`media-helper shutdown failed: ${error.message}`))
    .then(() => writeMediaDiagnostic.flush())
    .finally(() => {
      allowQuitAfterMediaHelper = true;
      app.quit();
    });
});
app.on('window-all-closed', () => app.quit());
ipcMain.handle('voice-overlay:begin', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return voiceOverlay.begin();
});
ipcMain.handle('voice-overlay:configure', (event, owner, settings) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return voiceOverlay.configure(owner, settings);
});
ipcMain.handle('voice-overlay:update', (event, owner, snapshot) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  voiceOverlay.update(owner, snapshot);
});
ipcMain.handle('voice-overlay:edit', (event, owner, enabled) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return voiceOverlay.edit(owner, enabled);
});
ipcMain.handle('voice-overlay:end', (event, owner) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  voiceOverlay.end(owner);
});
ipcMain.handle('voice-overlay:displays', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return voiceOverlay.displays();
});
ipcMain.handle('voice-overlay:ready', (event) => voiceOverlay.ready(event));
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
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  return parseManualAccessLink(value);
});
ipcMain.handle('auth:access:prepare', async (event, offer) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  if (await loadSession()) throw new Error('请先退出当前账号。');
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  const link = `lycansync://access?server=${encodeURIComponent(offer?.server ?? '')}#token=${offer?.token ?? ''}`;
  const validated = parseAccessLink(link);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用。');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(accessLinkFile, safeStorage.encryptString(link));
  await saveServerSettings(app.getPath('userData'), validated.server);
  if (!trustedSender(event) || closing) return;
  app.relaunch();
  app.quit();
});
ipcMain.handle('settings:server:set', async (event, value) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能修改服务器地址。');
  if (await loadSession()) throw new Error('请退出登录后再修改服务器地址。');
  if (!trustedSender(event) || closing) throw new Error('当前不能修改服务器地址。');
  await saveServerSettings(app.getPath('userData'), value);
  // 配置可能已经落盘；用户已关窗时留待下次启动，不再因迟到结果重新打开应用。
  if (!trustedSender(event) || closing) return;
  app.relaunch();
  app.quit();
});

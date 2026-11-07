const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, net, powerMonitor, protocol, screen, session, safeStorage, shell, sharedTexture, Tray } = require('electron');
const { release: osRelease } = require('node:os');
const { createServer } = require('node:net');
const { existsSync } = require('node:fs');
const { Module } = require('node:module');
const { dirname, isAbsolute, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { MediaHelperManager } = require('./media-helper.cjs');
const { ObsCaptureHostManager } = require('./obs-capture-host.cjs');
const { ObsAudioHostManager } = require('./obs-audio-host.cjs');
const { createRecording } = require('./recording.cjs');
const { createAudioShortcuts } = require('./audio-shortcuts.cjs');
const { createMediaBackgroundPolicy } = require('./media-background.cjs');
const { createDesktopTray } = require('./desktop-tray.cjs');
const { createLoginPreferences } = require('./login-preferences.cjs');
const { createRecordingVoice } = require('./recording-voice.cjs');
const { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader } = require('./media-diagnostics.cjs');
const { createDiagnosticReportStore, parseDiagnosticReport } = require('./diagnostic-reports.cjs');
const { loadServerSettings, saveServerSettings } = require('./server-settings.cjs');
const { createNativeThumbnailCache, monitorDisplayId } = require('./native-video-thumbnails.cjs');
const { parseAccessLink, accessLinkFromArguments, parseManualAccessLink } = require('./access-links.cjs');
const { qqLoginFromArguments, validateQqAuthorization } = require('./qq-login.cjs');
const { createStartupUpdate, parseInstallTiming } = require('./startup-update.cjs');
const { applyRuntimePaths } = require('./runtime-paths.cjs');
const { createActivityHelper } = require('./activity-helper.cjs');
const { leagueCaptureApplication, createLeagueCaptureFollow } = require('./league-capture.cjs');
const { createVoiceOverlay } = require('./voice-overlay.cjs');
const { initialWindowBounds } = require('./window-layout.cjs');
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
  ['GET /api/auth/account', {}],
  ['POST /api/auth/account/recover', { public: true, savesSession: true }],
  ['PUT /api/auth/account/recovery-password', {}],
  ['POST /api/auth/account/transfer', {}],
  ['DELETE /api/auth/account/transfer', {}],
  ['POST /api/auth/account/transfer/accept', {}],
  ['POST /api/auth/account/close', { clearsSession: true }],
  ['POST /api/auth/qq/start', {}],
  ['POST /api/auth/qq/exchange', { public: true, savesSession: true }],
  ['POST /api/auth/qq/binding/confirm', {}],
  ['GET /api/auth/qq/binding', {}],
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
  ['GET /api/rtc/voice-time', {}],
  ['GET /api/rtc/room-occupancies', {}],
  ['POST /api/presence/heartbeat', {}],
  ['POST /api/audio/entrance-sound/normalize', { maxBodyBytes: 512 * 1024 }],
  ['GET /api/groups', {}],
  // 后端接受最多 2 MiB 的裁剪图片，另留 Base64 膨胀、文本与 JSON 的空间。
  ['POST /api/groups', { maxBodyBytes: 3 * 1024 * 1024 }],
  ['POST /api/groups/join', {}],
]);
const groupPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupManagementPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:candidates|members|owner|invite-code(?:\/refresh)?)$/i;
const groupMemberPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/members\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupMemberProfilePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/members\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/profile$/i;
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
const runtimeLayout = (() => {
  try {
    return applyRuntimePaths({
      app,
      packaged: app.isPackaged,
      execPath: process.execPath,
      projectDirectory: resolve(__dirname, '../../..'),
      environment: process.env,
      explicitUserDataDir: app.commandLine.hasSwitch('user-data-dir')
        ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
    });
  } catch (error) {
    dialog.showErrorBox('无法准备 LycanSync 运行目录', `${error.message}\n\n请将 LycanSync 安装到当前用户可写的目录，例如 D:\\Programs\\LycanSync，避免 Program Files 或 Windows 目录。\n已有账号与设置保存在原安装目录的 data 中，请保留该文件夹，不要卸载或删除后再尝试。`);
    process.exit(1);
  }
})();
const backend = new URL(loadServerSettings({
  packaged: app.isPackaged,
  userDirectory: app.getPath('userData'),
  resourcesDirectory: app.isPackaged ? process.resourcesPath : __dirname,
  developmentUrl: process.env.LYCANSYNC_API_URL,
}));
const loginPreferences = createLoginPreferences(resolve(app.getPath('userData'), 'login-settings.json'), backend.origin);
let pendingAccessLink = accessLinkFromArguments(process.argv);
let pendingAccessError = false;
const accessLinkFile = resolve(app.getPath('userData'), 'pending-access.bin');
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

let mainWindow;
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
let mediaQuitPending = false;
let updatePreparing = false;
let resolveUpdateRelease;
const startupUiTimings = new Set();
let nativeMediaBridge;
const desktopTray = createDesktopTray({ Tray, Menu,
  iconPath: resolve(__dirname, 'app.ico'), settingsPath: resolve(app.getPath('userData'), 'desktop-settings.json'),
  getWindow: () => mainWindow,
  onQuit: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    else app.quit();
  },
});
const setMediaBackgroundActive = createMediaBackgroundPolicy();
const audioShortcuts = createAudioShortcuts({ getWindow: () => mainWindow,
  bridge: () => nativeMediaBridge ??= loadNativeMediaBridge(),
  getReplayId: () => recording.replay?.phase === 'buffering' && !recording.replay.error && !recording.replay.saving ? recording.replay.id : null,
  onActivityChanged: active => setMediaBackgroundActive(mainWindow?.webContents, 'pushToTalk', active),
  onRelease: () => { if (nativeMicrophoneSession) obsAudioHost.cancelTransmission(nativeMicrophoneSession.sessionId); } });
let nativeVideoSession;
let nativeVideoPreparation;
let nativeVideoSourcesById = new Map();
const loadNativeThumbnailBatch = createNativeThumbnailCache();
let lastStoppedNativeVideoSession;
let nativeScreenAudioSession;
let lastScreenAudioDroppedChunks = 0;
let nativeMicrophoneSession;
let lastMicrophoneDroppedChunks = 0;
const helperProcessBridges = new WeakMap();
const writeMediaDiagnostic = createMediaDiagnostics(resolve(app.getPath('userData'), 'screen-share-error.log'));
const savedDiagnosticReports = createDiagnosticReportStore(resolve(app.getPath('userData'), 'diagnostics'));
let diagnosticReportsGeneration = 0;
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
  onTiming: (stage, durationMs) => writeMediaDiagnostic({ stage, durationMs }),
  beforeInstall: async (intent) => {
    if (closing || (startupReady && intent !== 'manual')) throw new Error('当前不能安装更新');
    if (pendingAccessLink) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('无法保存待确认邀请');
      const link = `lycansync://access?server=${encodeURIComponent(pendingAccessLink.server)}#token=${pendingAccessLink.token}`;
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(accessLinkFile, safeStorage.encryptString(link));
    }
    if (intent === 'manual') {
      updatePreparing = true;
      closing = true;
      let timer;
      const released = new Promise(resolve => {
        resolveUpdateRelease = resolve;
        timer = setTimeout(resolve, 2_000);
      });
      mainWindow?.webContents.send('window:release-media');
      await released;
      clearTimeout(timer);
      resolveUpdateRelease = undefined;
      await shutdownMediaResources();
    }
    canClose = true;
    allowQuitAfterMediaHelper = true;
  },
  onInstallFailure: () => {
    // 原生宿主已永久释放，安装失败也不能把此进程交还给用户继续采集。
    if (updatePreparing && mediaHelperShutdownPromise) {
      app.quit();
      return;
    }
    canClose = false;
    allowQuitAfterMediaHelper = false;
    if (updatePreparing) { updatePreparing = false; closing = false; }
  },
});

function recordSourceTiming(stage, startedAt, sourceCount) {
  const now = Date.now();
  if (now - (sourceTimingRecordedAt.get(stage) ?? 0) < 30_000) return;
  sourceTimingRecordedAt.set(stage, now);
  void writeMediaDiagnostic({ stage, durationMs: Math.round(performance.now() - startedAt), sourceCount });
}

function recordVideoFailure(stage, error, frame, details = {}) {
  const code = String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1];
  void writeMediaDiagnostic({
    stage, code, message: String(error?.message ?? error).slice(0, 2000),
    appVersion: app.getVersion(), electronVersion: process.versions.electron,
    windowsVersion: osRelease(), gpu: app.getGPUFeatureStatus(),
    pixelFormat: frame?.pixelFormat, codedSize: frame?.codedSize,
    ...details,
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
  onRecordingEvent: (state, event) => recording.hostEvent(state, event),
  onReplayEvent: (state, event) => recording.replayHostEvent(state, event),
  configPath: resolve(app.getPath('userData'), 'obs-capture', '32.2.2'),
  onFrame: handleNativeSharedTextureFrame,
  onFailure: (state, error) => {
    const video = nativeVideoSession;
    if (video && video.sessionId === state.videoSessionId && !video.stopping) {
      if (error.message === 'captureTargetClosed') void writeMediaDiagnostic({ stage: 'screenTargetClosed', code: error.message });
      else recordVideoFailure('obsCaptureHost', error);
      const code = ['captureTargetClosed', 'captureSettingsUnsupported', 'captureBorderUnsupported', 'captureBorderAccessDenied',
        'obsGameBindingUnavailable', 'obsGameTargetMismatch', 'obsWindowBindingUnavailable', 'obsWindowTargetMismatch',
        'obsWindowCaptureStartFailed', 'obsWindowRuntimeUnavailable', 'obsWindowSourceUnavailable',
        'sharedTextureGpuWaitFailed', 'sharedTextureGpuStalled', 'sharedTextureReleaseFailed', 'sharedTextureAcquireFailed',
        'dxgiMonitorUnavailable', 'dxgiAdapterMismatch'].includes(error.message)
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

const obsAudioSettings = {
  executablePath: resolve(dirname(obsHostSettings.executablePath), 'lycansync-obs-audio-host.exe'),
  modulePath: resolve(dirname(obsHostSettings.modulePath), 'win-wasapi.dll'),
  dataPath: resolve(dirname(obsHostSettings.dataPath), 'win-wasapi'),
};
const obsAudioHost = new ObsAudioHostManager({
  ...obsAudioSettings,
  configPath: resolve(app.getPath('userData'), 'obs-audio', '32.2.2'),
  onFailure: (sessionId, code) => {
    if (nativeMicrophoneSession?.sessionId === sessionId) notifyNativeMicrophoneError(nativeMicrophoneSession, code);
  },
  onDiagnostic: (entry) => { void writeMediaDiagnostic(entry); },
});

const recordingVoice = createRecordingVoice();
const recording = createRecording({
  dataDirectory: app.getPath('userData'), host: obsCaptureHost, getVideo: () => nativeVideoSession,
  ensureVoice: id => recordingVoice.open(id),
  releaseVoice: id => recordingVoice.close(id),
  ensureAudio: async (sessionId) => {
    if (screenShareAudioCapability().reason !== 'windowsApplicationLoopbackProcessTree') {
      throw new Error('recordingApplicationAudioUnavailable');
    }
    await startNativeScreenAudio(nativeVideoSession.sourceId, sessionId, false);
  },
  releaseAudio: async (sessionId) => {
    if (nativeScreenAudioSession?.sessionId === sessionId && !nativeScreenAudioSession.publishing) {
      await stopNativeScreenAudio(sessionId, true);
    }
  },
  onChange: state => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('recording:state', state);
    }
  },
  onDiagnostic: entry => { void writeMediaDiagnostic(entry); },
});

let obsCorePreparationRequested = false;
let obsBackgroundPreparationFailed = false;
function prepareObsCapture(graphics) {
  if (closing || obsBackgroundPreparationFailed || process.platform !== 'win32'
      || !Object.values(obsHostSettings).every(path => existsSync(path))) return;
  if (!graphics && obsCorePreparationRequested) return;
  if (graphics && obsCaptureHost.state?.preparePromise) {
    // 选择器仍在读取来源时属于使用中；关闭后才开始计算空闲退出时间。
    obsCaptureHost.scheduleIdle(obsCaptureHost.state);
    return;
  }
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
  // 主进程引用释放不等于 GPU 已用完；保留槽位登记，直到 allReferencesReleased 删除。
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
  void stopNativeVideo(video.sessionId, code === 'captureTargetClosed' && Boolean(video.gameFollowId)).catch((error) => {
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
  while (audio.buffer.length >= 8) {
    const frames = audio.buffer.readUInt32LE(0);
    const transmissionEpoch = audio.buffer.readUInt32LE(4);
    if (frames !== 480) {
      notifyNativeMicrophoneError(audio, 'microphoneCaptureInvalidPacket');
      return;
    }
    const packetBytes = 8 + frames * 4;
    if (audio.buffer.length < packetBytes) break;
    const pcm = Uint8Array.from(audio.buffer.subarray(8, packetBytes));
    audio.buffer = audio.buffer.subarray(packetBytes);
    if (audio.queue.length === 12) {
      audio.queue.shift();
      audio.droppedChunks++;
    }
    audio.queue.push({ frames, pcm, transmissionEpoch });
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
    sessionId: audio.sessionId, sequence, frames: packet.frames, sampleRate: 48_000, channels: 1, pcm: packet.pcm, transmissionEpoch: packet.transmissionEpoch,
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
  void writeMediaDiagnostic({ stage: 'microphoneCaptureFailed', code: safeCode });
  finishNativeMicrophonePipe(audio, { destroy: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-microphone-error', { sessionId: audio.sessionId, code: safeCode });
  }
  // 宿主管理器统一记录停止失败；这里仅清理页面管道与会话。
  void obsAudioHost.stop(audio.sessionId).catch(() => {}).finally(() => {
    lastMicrophoneDroppedChunks = audio.hostDroppedChunks === null ? null
      : audio.hostDroppedChunks + audio.droppedChunks + audio.rendererDroppedChunks;
    if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
  });
}

async function startNativeMicrophoneCapture(sessionId, settings, deviceId, pushToTalk) {
  if (closing || process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!validNativeAudioSessionId(sessionId) || !validMicrophoneSettings(settings)) {
    throw new Error('invalidMicrophoneCaptureStart');
  }
  if (nativeMicrophoneSession) {
    if (nativeMicrophoneSession.sessionId === sessionId && !nativeMicrophoneSession.stopping) {
      return nativeMicrophoneSession.startPromise;
    }
    throw new Error('microphoneCaptureAlreadyRunning');
  }
  lastMicrophoneDroppedChunks = 0;
  const pipeId = randomUUID();
  const server = createServer();
  const audio = {
    sessionId, pipeId, server, socket: undefined, buffer: Buffer.alloc(0), queue: [],
    inFlight: undefined, sequence: 0, droppedChunks: 0, rendererDroppedChunks: 0,
    stopping: false, failureNotified: false, hostDroppedChunks: null, hostStarted: false,
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
  audio.startPromise = (async () => {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => { server.removeListener('listening', onListening); rejectListen(error); };
        const onListening = () => { server.removeListener('error', onError); resolveListen(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(`\\\\.\\pipe\\lycansync-microphone-audio-${pipeId}`);
      });
      if (nativeMicrophoneSession !== audio || audio.stopping) throw new Error('microphoneCaptureSessionStopped');
      audio.hostStarted = true;
      const format = await obsAudioHost.start(pipeId, sessionId, settings, deviceId, pushToTalk);
      if (nativeMicrophoneSession !== audio || audio.stopping) throw new Error('microphoneCaptureSessionStopped');
      return format;
    } catch (error) {
      finishNativeMicrophonePipe(audio, { destroy: true });
      if (audio.hostStarted) await obsAudioHost.stop(sessionId).catch(() => {});
      if (nativeMicrophoneSession === audio) nativeMicrophoneSession = undefined;
      if (error.message !== 'microphoneCaptureSessionStopped') {
        const code = /^[a-z][A-Za-z0-9]{0,63}$/.test(error.message) ? error.message : 'microphoneCaptureStartFailed';
        void writeMediaDiagnostic({ stage: 'microphoneStartFailed', code });
      }
      throw error;
    }
  })();
  return audio.startPromise;
}

async function stopNativeMicrophoneCapture(sessionId) {
  const audio = nativeMicrophoneSession;
  if (!audio) return { changed: false };
  if (audio.sessionId !== sessionId) throw new Error('microphoneCaptureSessionMismatch');
  if (audio.stopPromise) return audio.stopPromise;
  audio.stopPromise = (async () => {
    // 立即撤销页面交付，但保持管道排空至宿主停止，避免正常停止被误报为写管道故障。
    audio.stopping = true;
    audio.queue.length = 0;
    try { return audio.hostStarted ? await obsAudioHost.stop(sessionId) : { changed: false }; }
    finally {
      finishNativeMicrophonePipe(audio, { destroy: true });
      lastMicrophoneDroppedChunks = audio.hostDroppedChunks === null ? null
        : audio.hostDroppedChunks + audio.droppedChunks + audio.rendererDroppedChunks;
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
    if (audio.publishing) audio.queue.push({ frames, pcm });
  }
  if (audio.buffer.length > 65_536) {
    notifyNativeScreenAudioError(audio, 'screenShareAudioBufferOverflow');
    return;
  }
  sendNextNativeScreenAudioChunk(audio);
}

function sendNextNativeScreenAudioChunk(audio) {
  if (!audio.publishing || nativeScreenAudioSession !== audio || audio.stopping || !audio.format || audio.inFlight || !audio.queue.length
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
  if (recording.media?.videoSessionId === audio.sessionId && recording.media.options.applicationAudio) {
    void recording.failMedia(recording.media.id, 'recordingApplicationAudioUnavailable').catch(() => {});
  }
  const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
  finishNativeScreenAudioPipe(audio, { destroy: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:native-screen-audio-error', { sessionId: audio.sessionId, code: safeCode });
  }
  void stopNativeScreenAudio(audio.sessionId, true).catch((error) => {
    void writeMediaDiagnostic({ stage: 'stopScreenAudioAfterFailure', message: String(error.message).slice(0, 500) });
  });
}

async function startNativeScreenAudio(sourceId, sessionId, publishing = true) {
  const video = nativeVideoSession;
  if (closing || process.platform !== 'win32') throw new Error('platformUnsupported');
  if (!video || video.starting || video.stopping || video.sessionId !== sessionId || video.sourceId !== sourceId) {
    throw new Error('videoSourceExpired');
  }
  if (nativeScreenAudioSession) {
    if (nativeScreenAudioSession.sessionId === sessionId && !nativeScreenAudioSession.stopping) {
      nativeScreenAudioSession.publishing ||= publishing;
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
    rendererDroppedChunks: 0, stopping: false, failureNotified: false, publishing,
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

async function stopNativeScreenAudio(sessionId, force = false) {
  const audio = nativeScreenAudioSession;
  if (!audio) return { changed: false };
  if (audio.sessionId !== sessionId) throw new Error('screenShareAudioSessionMismatch');
  if (!force && !nativeVideoSession?.stopping && recording.media?.videoSessionId === sessionId
      && recording.media.options.applicationAudio) {
    audio.publishing = false; audio.queue.length = 0; audio.inFlight = undefined;
    return { changed: true };
  }
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
      frame: video.renderer.mainFrame,
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
      const code = /^transfer shared texture timed out after 1000ms,/.test(String(error?.message))
        ? 'sharedTextureTransferTimedOut' : 'sharedTextureTransferFailed';
      if (!video.failureNotified && !video.stopping && nativeVideoSession === video) {
        const rendererAlive = !video.renderer.isDestroyed();
        recordVideoFailure('sendTexture', error, frame, { code,
          rendererAlive,
          ...(rendererAlive ? { rendererLoading: video.renderer.isLoadingMainFrame(),
            backgroundThrottling: video.renderer.getBackgroundThrottling() } : {}),
          ...(mainWindow && !mainWindow.isDestroyed() ? { windowMinimized: mainWindow.isMinimized(),
            windowVisible: mainWindow.isVisible() } : {}),
          importedCount: video.imported.size, pendingReleaseCount: video.pendingSlotReleases.size });
      }
      releaseImport();
      // 超时后可能仍有迟到交付；由原有停止流程回收，不能直接重发或复用槽位。
      if (!video.stopping && nativeVideoSession === video) notifyNativeVideoError(video, code);
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

async function prepareNativeVideoSource(sourceId) {
  if (sourceId === null) { nativeVideoPreparation = undefined; return { prepared: false }; }
  const state = mediaHelper.videoSourceSnapshot?.state;
  if (!nativeVideoSourcesById.has(sourceId) || !state?.alive || state.closed) throw new Error('videoSourceExpired');
  if (nativeVideoPreparation?.sourceId === sourceId && nativeVideoPreparation.state === state) {
    return nativeVideoPreparation.promise;
  }
  const preparation = { sourceId, state };
  nativeVideoPreparation = preparation;
  const startedAt = performance.now();
  preparation.promise = (async () => {
    try {
      const target = await mediaHelper.inspectVideoSource(sourceId);
      const game = target.kind === 'window' && !target.requiresWindowCapture
        && await activityMonitor.isCaptureGame(target.executable);
      if (closing || nativeVideoPreparation !== preparation || mediaHelper.videoSourceSnapshot?.state !== state
          || !nativeVideoSourcesById.has(sourceId)) return { prepared: false };
      preparation.result = { target, game };
      void writeMediaDiagnostic({ stage: 'screenSourcePrepared', sourceKind: target.kind,
        durationMs: Math.round(performance.now() - startedAt) });
      return { prepared: true, ...(target.kind === 'window' && leagueCaptureApplication(target.executable)
        ? { followGame: 'league' } : {}) };
    } catch (error) {
      if (nativeVideoPreparation === preparation) nativeVideoPreparation = undefined;
      throw error;
    }
  })();
  return preparation.promise;
}

async function startNativeVideo(sourceId, maxFps, settings, resolution, gameFollowId) {
  if (closing) throw new Error('mediaHelperShuttingDown');
  if (process.platform !== 'win32') throw new Error('platformUnsupported');
  if (![30, 60, 120].includes(maxFps)
      || typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidVideoStart');
  if (settings?.followGame && (settings.followGame !== 'league' || !['auto', undefined].includes(settings.windowMethod))) {
    throw new Error('nativeGameFollowTargetInvalid');
  }
  if (nativeVideoSession) throw new Error('videoCaptureAlreadyRunning');
  const continuingGameFollow = Boolean(gameFollowId);
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
    ...(source.kind === 'window' ? { requestedMethod: settings?.windowMethod === undefined ? 'auto' : settings.windowMethod,
      ...(typeof settings?.hideBorder === 'boolean' ? { borderAllowed: !settings.hideBorder } : {}) } : {}),
    hostReused: Boolean(obsCaptureHost.state && !obsCaptureHost.state.closed && !obsCaptureHost.state.failed) });
  try {
    video.renderer = mainWindow?.webContents;
    if (!video.renderer || video.renderer.isDestroyed()) throw new Error('sharedTextureReceiverUnavailable');
    // 纹理接收与画布复制依赖主页面；共享期间切到游戏不能把该页面降为后台节流。
    setMediaBackgroundActive(video.renderer, 'video', true);
    video.backgroundActive = true;
    const reservation = mediaHelper.reserveVideo(sessionId, sourceId);
    video.targetState = mediaHelper.videoCapture?.state;
    let target = await reservation;
    if (closing || video.stopping || nativeVideoSession !== video) throw new Error('nativeVideoSessionStopped');
    if (settings?.followGame !== undefined && settings.followGame !== 'league') throw new Error('nativeGameFollowTargetInvalid');
    if (settings?.followGame === 'league') {
      if (gameFollowId) leagueCaptureFollow.bind(gameFollowId, sourceId, target);
      else gameFollowId = leagueCaptureFollow.begin(sourceId, target);
      video.gameFollowId = gameFollowId;
    } else if (gameFollowId) throw new Error('nativeGameFollowTargetInvalid');
    const preparation = nativeVideoPreparation;
    if (preparation?.sourceId === sourceId) nativeVideoPreparation = undefined;
    const prepared = preparation?.sourceId === sourceId && preparation.state === video.targetState
      && preparation.result?.target.kind === target.kind ? preparation.result : undefined;
    const preparationReused = target.kind === 'window' && prepared?.target.windowId === target.windowId
      && prepared.target.lifetimeName === target.lifetimeName
      && prepared.target.processId === target.processId
      && prepared.target.processCreationTime === target.processCreationTime
      && prepared.target.requiresWindowCapture === target.requiresWindowCapture
      && prepared.target.executable === target.executable;
    void writeMediaDiagnostic({ stage: 'screenSourceReserved', durationMs: Math.round(performance.now() - video.startedAt),
      preparationReused,
      ...(target.kind === 'window' ? { requiresWindowCapture: target.requiresWindowCapture } : {}) });
    if (target.kind === 'window') {
      const method = settings?.windowMethod ?? 'auto';
      const game = method === 'game' || (method === 'auto' && !target.requiresWindowCapture
        && (preparationReused ? prepared.game : await activityMonitor.isCaptureGame(target.executable)));
      // 程序分类只决定采集方式；授权范围仍是注册表预留的精确窗口实例。
      const { windowId, lifetimeName, processId, processCreationTime } = target;
      target = { kind: game ? 'game' : 'window', windowId, lifetimeName, processId, processCreationTime };
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
    if (gameFollowId && !continuingGameFollow) void writeMediaDiagnostic({ stage: 'gameFollowEnabled' });
    return { sessionId, changed: true, ...(gameFollowId ? { gameFollowId } : {}) };
  } catch (error) {
    if (!video.failureNotified) {
      if (['captureBorderUnsupported', 'captureBorderAccessDenied', 'captureSettingsUnsupported'].includes(error.message)) {
        void writeMediaDiagnostic({ stage: 'screenCaptureSelectionUnavailable', code: error.message });
      } else recordVideoFailure('startCapture', error);
    }
    video.stopping = true;
    try { await (video.stopPromise ?? stopNativeVideo(sessionId)); }
    catch (stopError) {
      recordVideoFailure('stopObsCaptureAfterStartFailure', stopError);
      throw new Error('obsCaptureStopUnconfirmed');
    }
    throw error;
  }
}

function restoreNativeVideoBackgroundThrottling(video) {
  if (!video.backgroundActive) return;
  setMediaBackgroundActive(video.renderer, 'video', false);
  video.backgroundActive = false;
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

async function stopNativeVideo(sessionId, preserveGameFollow = false) {
  const video = nativeVideoSession;
  if (!video) {
    return lastStoppedNativeVideoSession === sessionId
      ? { changed: false }
      : Promise.reject(new Error('videoSessionMismatch'));
  }
  if (video.sessionId !== sessionId) throw new Error('videoSessionMismatch');
  if (!preserveGameFollow && video.gameFollowId) leagueCaptureFollow.end(video.gameFollowId);
  if (video.stopPromise) return video.stopPromise;
  video.stopping = true;
  if (video.renderer && !video.renderer.isDestroyed()) {
    video.renderer.send('media:native-video-stopping', { sessionId });
  }
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
    if (recording.active?.videoSessionId === sessionId || recording.replay?.videoSessionId === sessionId) {
      if (nativeScreenAudioSession?.sessionId === sessionId) {
        nativeScreenAudioSession.publishing = false;
        nativeScreenAudioSession.queue.length = 0;
        nativeScreenAudioSession.inFlight = undefined;
      }
      await recording.stopAll().catch(error => {
        void writeMediaDiagnostic({ stage: 'recordingFailed', code: error.message });
      });
    }
    if (nativeScreenAudioSession?.sessionId === sessionId) {
      await stopNativeScreenAudio(sessionId).catch(() => {});
    }
    releaseNativeVideoImports(video);
    const deadline = Date.now() + 1_200;
    while ((video.imported.size || video.pendingSlotReleases.size) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (video.imported.size || video.pendingSlotReleases.size) {
      void writeMediaDiagnostic({ stage: 'screenTextureReleaseTimeout',
        importedCount: video.imported.size, pendingReleaseCount: video.pendingSlotReleases.size });
      // 外部纹理未归还时不复用宿主；退出确认后才释放来源并允许下一次共享。
      await obsCaptureHost.shutdown(true, 'textureTimeout');
      await stopObsVideo(video);
      void writeMediaDiagnostic({ stage: 'screenVideoStopRecovered' });
    } else {
      await stopObsVideo(video);
    }
    if (controlFailure) throw controlFailure;
    if (nativeVideoSession === video) {
      restoreNativeVideoBackgroundThrottling(video);
      nativeVideoSession = undefined;
    }
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

const leagueCaptureFollow = createLeagueCaptureFollow({
  discoveryState: () => mediaHelper.videoSourceSnapshot?.state,
  inspectSource: sourceId => mediaHelper.inspectVideoSource(sourceId),
  listSources: async () => {
    const snapshot = await mediaHelper.listVideoSources();
    nativeVideoSourcesById = new Map(snapshot.sources.map(source => [source.sourceId, source]));
    return snapshot;
  },
});

async function switchNativeGameVideo(gameFollowId, sourceId, maxFps, settings, resolution) {
  const follow = leagueCaptureFollow.require(gameFollowId);
  if (![30, 60, 120].includes(maxFps) || !settings || typeof settings.hideCursor !== 'boolean'
      || typeof settings.hideBorder !== 'boolean' || !['auto', undefined].includes(settings.windowMethod)
      || !resolution || ![720, 1080, 1440].includes(resolution.height) || resolution.width !== resolution.height * 16 / 9) {
    throw new Error('nativeGameFollowTargetInvalid');
  }
  if (follow.switching) throw new Error('nativeGameFollowBusy');
  follow.switching = true;
  const startedAt = performance.now();
  try {
    const selected = await leagueCaptureFollow.findSource(gameFollowId);
    if (selected.sourceId !== sourceId) throw new Error('nativeGameFollowTargetInvalid');
    const old = nativeVideoSession;
    if (old) {
      if (old.gameFollowId !== gameFollowId) throw new Error('nativeGameFollowUnavailable');
      await stopNativeVideo(old.sessionId, true);
    }
    if (closing || leagueCaptureFollow.require(gameFollowId) !== follow) throw new Error('nativeGameFollowUnavailable');
    void writeMediaDiagnostic({ stage: 'gameFollowSourceSwitch' });
    const started = await startNativeVideo(sourceId, maxFps, { ...settings, followGame: 'league' }, resolution, gameFollowId);
    void writeMediaDiagnostic({ stage: 'gameFollowSourceSwitched', durationMs: Math.round(performance.now() - startedAt) });
    return started;
  } catch (error) {
    if (follow.cancelled || closing) {
      void writeMediaDiagnostic({ stage: 'gameFollowSwitchCancelled' });
      throw error;
    }
    const code = ['nativeGameFollowUnavailable', 'nativeGameFollowTargetInvalid', 'nativeGameFollowTargetAmbiguous',
      'nativeGameFollowBusy', 'captureTargetClosed'].includes(error.message) ? error.message : 'nativeGameFollowFailed';
    void writeMediaDiagnostic({ stage: 'gameFollowSwitchFailed', code,
      durationMs: Math.round(performance.now() - startedAt) });
    throw error;
  } finally { follow.switching = false; }
}

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

async function saveSession(token, accountId) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，不能保存自动登录凭据。');
  // 新凭据持久化前记录首次手动确认，避免关窗重开绕过账号确认。
  await loginPreferences.set(accountId, true, true);
  const encrypted = safeStorage.encryptString(JSON.stringify({ server: backend.origin, token }));
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(resolve(app.getPath('userData'), 'session.bin'), encrypted);
  sessionToken = token;
  sessionLoaded = true;
}

async function clearSession() {
  try { audioShortcuts.clear(); } catch { console.error('audio shortcut cleanup failed'); }
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
  if (!supported) return { supported, enabled: false };
  const settings = app.getLoginItemSettings({ path: process.execPath, args: [] });
  return {
    supported,
    enabled: settings.openAtLogin && settings.executableWillLaunchAtLogin,
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
      ?? (request.method === 'GET' && groupMessagePath.test(url.pathname) && url.searchParams.get('wait') === 'true'
        ? { longPolling: true } : undefined)
      ?? (request.method === 'GET' && (groupPath.test(url.pathname) || groupMemberProfilePath.test(url.pathname) || groupPresencePath.test(url.pathname) || groupMessagePath.test(url.pathname)
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
      if (['/api/auth/access/redeem', '/api/auth/account/recover'].includes(url.pathname) && token) {
        return Response.json({ detail: '请先从此设备移除当前账号，再恢复账号或使用邀请链接。' }, { status: 409 });
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
        await saveSession(result.sessionToken, result.user.id);
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
    return ['display-capture', 'fullscreen', 'speaker-selection'].includes(permission);
  });
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = contents === mainWindow?.webContents && trustedUrl(details.requestingUrl);
    // Electron 的桌面采集使用空 mediaTypes，最终仍须经过下面的共享源选择。
    // 摄像头请求包含 video，明确拒绝；undefined 不视为已知的采集类型。
    const allowedMedia = permission === 'media' && Array.isArray(details.mediaTypes)
      && details.mediaTypes.every((type) => type === 'audio');
    callback(Boolean(trusted && (allowedMedia || ['display-capture', 'fullscreen', 'speaker-selection'].includes(permission))));
  });
  // 桌面只允许正式原生共享；保留拒绝处理器，避免误调用 getDisplayMedia 启动另一条采集链路。
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => denyCapture(callback));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const qq = qqLoginFromArguments(argv);
    if (qq && qq.server === backend.origin) mainWindow?.webContents.send('auth:qq:complete', qq.request);
    const offer = accessLinkFromArguments(argv);
    if (offer) {
      pendingAccessLink = offer;
      mainWindow?.webContents.send('auth:access:offer', offer);
    }
    desktopTray.show();
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.lycansync.desktop');
    void writeMediaDiagnostic({ stage: 'applicationReady', appVersion: app.getVersion(),
      electronVersion: process.versions.electron, platform: process.platform, arch: process.arch,
      osVersion: osRelease(), durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt) });
    const installTimingFile = resolve(runtimeLayout.updaterCachePath, 'last-install.ini');
    void readFile(installTimingFile, 'utf8').then(async text => {
      const timing = parseInstallTiming(text, app.getVersion());
      if (timing) await writeMediaDiagnostic(timing);
      await unlink(installTimingFile);
    }).catch(error => { if (error.code !== 'ENOENT') console.error('无法读取更新安装计时'); });
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
    powerMonitor.on('lock-screen', () => audioShortcuts.block('lock', true));
    powerMonitor.on('unlock-screen', () => audioShortcuts.block('lock', false));
    powerMonitor.on('suspend', () => audioShortcuts.block('sleep', true));
    powerMonitor.on('resume', () => audioShortcuts.block('sleep', false));
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // 所有入口和主界面共用一个可调整的窗体，页面切换不改变用户的窗口状态。
    mainWindow = new BrowserWindow({
      ...initialWindowBounds(workArea), resizable: true, maximizable: true,
      minWidth: Math.min(920, workArea.width - 32), minHeight: Math.min(640, workArea.height - 32),
      title: 'LycanSync', icon: resolve(__dirname, 'app.ico'), frame: false, show: false, backgroundColor: '#10151a',
      webPreferences: { preload: resolve(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWindow.setMenu(null);
    desktopTray.initialize();
    screenShareWindows.attach(mainWindow);
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.webContents.once('did-finish-load', () => {
      void writeMediaDiagnostic({ stage: 'rendererReady', durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt) });
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      try { audioShortcuts.clear(); } catch { console.error('audio shortcut cleanup failed'); }
      void writeMediaDiagnostic({ stage: 'rendererExited', outcome: details.reason });
      finishClose();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (event) => {
      // app.quit 先等待 helper 清理；确认完成后的第二次退出允许关闭窗口。
      if (canClose || allowQuitAfterMediaHelper) return;
      if (!closing && desktopTray.handleClose(event)) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      desktopTray.prepareToQuit();
      try { audioShortcuts.clear(); } catch { console.error('audio shortcut cleanup failed'); }
      screenShareWindows.closeAll();
      voiceOverlay.clear();
      startupUpdate.cancel();
      // 先停止采集再退出；页面异常时由主进程兜底销毁窗口，避免后台残留。
      closeTimer = setTimeout(finishClose, 2000);
      mainWindow.webContents.send('window:release-media');
    });
    mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
    mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));
    mainWindow.on('query-session-end', () => desktopTray.prepareToQuit());
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
ipcMain.handle('update:restart', async (event) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('当前不能重启更新');
  const state = startupUpdate.getState();
  if (!state.supported || state.phase !== 'ready' || state.error || !state.nextVersion) {
    throw new Error('请先检查并确认有可用的新版本');
  }
  const result = await startupUpdate.install();
  if (result.error) throw new Error('更新未完成，请重试或重新打开应用。');
});
ipcMain.on('app:startup-timing', (event, stage, durationMs) => {
  if (!trustedSender(event) || !['loginDataReady', 'loginReady'].includes(stage) || startupUiTimings.has(stage)
      || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 300_000) return;
  startupUiTimings.add(stage);
  void writeMediaDiagnostic({ stage, durationMs: Math.round(durationMs) });
});
ipcMain.handle('update:skip', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  if (['idle', 'checking', 'downloading'].includes(startupUpdate.getState().phase)) startupUpdate.cancel();
});

ipcMain.on('media:voice-join-timing', (event, timing) => {
  if (!trustedSender(event) || closing || !timing || typeof timing.microphoneEnabled !== 'boolean') return;
  const entry = { stage: 'voiceJoinReady', microphoneEnabled: timing.microphoneEnabled };
  for (const key of ['durationMs', 'preflightMs', 'tokenMs', 'connectMs', 'microphoneMs', 'listeningMs']) {
    const duration = timing[key];
    if (!Number.isFinite(duration) || duration < 0 || duration > 300_000) return;
    entry[key] = Math.round(duration);
  }
  void writeMediaDiagnostic(entry);
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
ipcMain.handle('capture:prepare', (event, graphics = false) => {
  if (!trustedSender(event) || closing || typeof graphics !== 'boolean') throw new Error('请求来源无效');
  prepareObsCapture(graphics);
});
ipcMain.handle('window:is-maximized', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return mainWindow.isMaximized();
});
ipcMain.handle('diagnostics:process-metrics', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return readProcessMetrics(app.getAppMetrics(), [
    { role: 'obs', children: obsCaptureHost.state ? [obsCaptureHost.state.child] : [], executablePath: obsHostSettings.executablePath },
    { role: 'obs-audio', children: obsAudioHost.state ? [obsAudioHost.state.child] : [], executablePath: obsAudioSettings.executablePath },
    { role: 'media', children: [...mediaHelper.children].map((state) => state.child), executablePath: mediaHelperPath() },
    { role: 'activity', children: activityMonitor.diagnosticProcesses(), executablePath: activityHelperPath() },
  ], process.platform === 'win32');
});
ipcMain.handle('diagnostics:checkpoint', async (event, text) => {
  if (!trustedSender(event) || allowQuitAfterMediaHelper) throw new Error('当前不能保存诊断。');
  const generation = diagnosticReportsGeneration;
  const report = parseDiagnosticReport(text);
  // 自动落盘不保存手填说明；事件沿用导出的固定字段与错误码过滤。
  report.notes = '';
  await writeMediaDiagnostic.flush();
  const eventStartedAt = Math.min(diagnosticStartedAt, Date.parse(report.startedAt));
  const eventEndedAt = Date.now();
  report.events = await readDiagnosticEvents(resolve(app.getPath('userData'), 'screen-share-error.log'), eventStartedAt, eventEndedAt);
  report.eventWindow = { startedAt: new Date(eventStartedAt).toISOString(), endedAt: new Date(eventEndedAt).toISOString() };
  report.eventLimit = '最多读取当前及上一份日志各256KiB，保留本次启动至快照最近200项；不含异常正文';
  report.environment = { appVersion: app.getVersion(), electronVersion: process.versions.electron,
    platform: process.platform, arch: process.arch, osVersion: osRelease(), gpuFeatures: app.getGPUFeatureStatus(), gpuUtilization: null };
  report.persistence = { savedAt: new Date().toISOString(), checkpointIntervalMs: 15_000,
    storage: 'installation-data-directory', unexpectedExitMayLoseLastInterval: true };
  if (generation !== diagnosticReportsGeneration) return null;
  try { return await savedDiagnosticReports.save(JSON.stringify(report)); }
  catch (error) {
    void writeMediaDiagnostic({ stage: 'diagnosticSnapshotFailed',
      storageError: ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY'].includes(error.code) ? error.code : 'unknown' });
    throw error;
  }
});
ipcMain.handle('diagnostics:saved', (event) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能读取已保存报告。');
  return savedDiagnosticReports.info();
});
ipcMain.handle('diagnostics:clear-saved', (event) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能清除已保存报告。');
  diagnosticReportsGeneration++;
  return savedDiagnosticReports.clear();
});
ipcMain.handle('diagnostics:export-saved', async (event, notes) => {
  if (!trustedSender(event) || closing || diagnosticExportPending) throw new Error('当前不能导出诊断。');
  if (typeof notes !== 'string' || notes.length > 2000) throw new Error('体验说明无效。');
  diagnosticExportPending = true;
  try {
    const report = await savedDiagnosticReports.previous();
    if (!report) throw new Error('尚无上次使用的诊断报告。');
    if (!trustedSender(event) || closing) return { saved: false };
    const exportDirectory = resolve(app.getPath('userData'), 'exports');
    await mkdir(exportDirectory, { recursive: true });
    if (!trustedSender(event) || closing) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: report.persistence?.retainedScreenUsage ? '导出最近画面使用报告' : '导出上次使用报告', defaultPath: resolve(exportDirectory, `LycanSync-diagnostics-${Date.parse(report.endedAt)}.json`),
      filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath || !trustedSender(event) || closing) return { saved: false };
    // 保留上次版本和事件时间，不把本次环境或启动事件混入历史报告。
    await writeFile(result.filePath, JSON.stringify({ ...report, notes }), 'utf8');
    return { saved: true };
  } finally { diagnosticExportPending = false; }
});
ipcMain.handle('diagnostics:export', async (event, text) => {
  if (!trustedSender(event) || closing || diagnosticExportPending) throw new Error('当前不能导出诊断。');
  const report = parseDiagnosticReport(text);
  diagnosticExportPending = true;
  try {
    await writeMediaDiagnostic.flush();
    const eventStartedAt = Math.min(diagnosticStartedAt, Date.parse(report.startedAt));
    const eventEndedAt = Date.now();
    const events = await readDiagnosticEvents(resolve(app.getPath('userData'), 'screen-share-error.log'),
      eventStartedAt, eventEndedAt);
    if (!trustedSender(event) || closing) return { saved: false };
    const exportDirectory = resolve(app.getPath('userData'), 'exports');
    await mkdir(exportDirectory, { recursive: true });
    if (!trustedSender(event) || closing) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断报告', defaultPath: resolve(exportDirectory, `LycanSync-diagnostics-${Date.now()}.json`),
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
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: process.execPath, args: [] });
  const updated = autoStartSettings();
  if (updated.enabled !== enabled) throw new Error('无法确认开机自启设置已生效，请检查 Windows 启动应用设置。');
  return updated;
});
ipcMain.handle('settings:tray:get', (event) => {
  if (!trustedSender(event) || closing) throw new Error('当前无法读取托盘设置');
  return desktopTray.settings();
});
ipcMain.handle('settings:tray:set', (event, enabled) => {
  if (!trustedSender(event) || closing || typeof enabled !== 'boolean') throw new Error('请求参数无效');
  return desktopTray.setEnabled(enabled);
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
  nativeVideoPreparation = undefined;
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
    const microphoneAvailable = Object.values(obsAudioSettings).every(path => existsSync(path));
    capabilities.microphoneCapture = { available: microphoneAvailable,
      reason: microphoneAvailable ? 'obsWasapiSonora' : 'obsAudioHostUnavailable' };
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
ipcMain.handle('media:video-source:prepare', (event, sourceId) => {
  if (!trustedSender(event) || closing || (sourceId !== null && (typeof sourceId !== 'string'
      || !/^(?:monitor|window):[1-9]\d*:\d+$/.test(sourceId)))) throw new Error('请求来源无效');
  return prepareNativeVideoSource(sourceId);
});
ipcMain.on('media:screen-picker-timing', (event, stage, durationMs) => {
  if (!trustedSender(event) || closing || !['screenPickerSourcesReady', 'screenPickerPreviewReady'].includes(stage)
      || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 300_000) return;
  recordSourceTiming(stage, performance.now() - durationMs);
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
    const state = mediaHelper.videoSourceSnapshot?.state;
    if (!state?.alive || state.closed) return [];
    const batches = await Promise.all([...new Set(sources.map(source => source.kind))].map(kind => {
      const currentSources = [...nativeVideoSourcesById.values()].filter(source => source.kind === kind)
        .map(source => ({ ...source, displayId: monitorDisplayId(source, screen) }));
      if (!currentSources.length) return [];
      return loadNativeThumbnailBatch(state, kind, currentSources, async () => {
        const desktopSources = await desktopCapturer.getSources({
          types: [kind === 'monitor' ? 'screen' : 'window'], thumbnailSize: { width: 256, height: 144 },
        });
        recordSourceTiming('sourceThumbnails', startedAt, desktopSources.length);
        return desktopSources.map((source) => ({
          id: source.id,
          type: captureSourceType(source),
          displayId: source.display_id,
          name: source.name,
          thumbnail: { isEmpty: () => source.thumbnail.isEmpty(),
            toDataURL: () => 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(80).toString('base64') },
        }));
      });
    }));
    if (mediaHelper.videoSourceSnapshot?.state !== state || !state.alive || state.closed) return [];
    const requested = new Set(sources.filter(source => {
      const current = nativeVideoSourcesById.get(source.sourceId);
      return current && current.title === source.title && current.windowId === source.windowId;
    }).map(source => source.sourceId));
    return batches.flat().filter(source => requested.has(source.sourceId));
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
ipcMain.handle('media:game-follow:source', (event, id) => {
  if (!trustedSender(event) || closing || typeof id !== 'string' || id.length > 128) throw new Error('请求参数无效');
  return leagueCaptureFollow.findSource(id).catch(error => {
    if (error.message === 'nativeGameFollowCancelled' || closing) throw error;
    void writeMediaDiagnostic({ stage: 'gameFollowLookupFailed', code:
      ['nativeGameFollowUnavailable', 'nativeGameFollowTargetAmbiguous'].includes(error.message)
        ? error.message : 'nativeGameFollowFailed' });
    throw error;
  });
});
ipcMain.handle('media:game-follow:switch', (event, id, sourceId, maxFps, settings, resolution) => {
  if (!trustedSender(event) || closing || typeof id !== 'string' || id.length > 128
      || typeof sourceId !== 'string' || !/^window:[1-9]\d*:\d+$/.test(sourceId)) throw new Error('请求参数无效');
  return recording.withVideoChange(() => switchNativeGameVideo(id, sourceId, maxFps, settings, resolution));
});
ipcMain.handle('media:game-follow:end', (event, id) => {
  if (!trustedSender(event) || typeof id !== 'string' || id.length > 128) throw new Error('请求参数无效');
  leagueCaptureFollow.end(id);
});
ipcMain.handle('media:native-video:configure', (event, sessionId, maxFps, resolution, deliveryOnly = false) => {
  if (!trustedSender(event) || closing || !nativeVideoSession || nativeVideoSession.stopping
      || nativeVideoSession.sessionId !== sessionId || typeof deliveryOnly !== 'boolean') throw new Error('请求参数无效');
  if (deliveryOnly) return obsCaptureHost.configureVideo(sessionId, maxFps, resolution, true);
  return recording.withVideoChange(() => obsCaptureHost.configureVideo(sessionId, maxFps, resolution));
});
ipcMain.handle('recording:settings', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.load();
});
ipcMain.handle('recording:configure', (event, settings) => {
  if (!trustedSender(event) || closing || !settings || Object.keys(settings).length !== 5
      || !['applicationAudio', 'microphone', 'friends'].every(key => typeof settings[key] === 'boolean')
      || ![720, 1080, 1440].includes(settings.videoHeight) || ![30, 60, 120].includes(settings.videoFps)) throw new Error('请求参数无效');
  return recording.configure(settings);
});
ipcMain.handle('recording:directory', async (event) => {
  if (!trustedSender(event) || closing || recording.active || recording.replay) throw new Error('当前不能修改录像目录');
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择录像保存目录', properties: ['openDirectory', 'createDirectory'],
    defaultPath: (await recording.load()).directory });
  return result.canceled ? recording.load() : recording.configure({ directory: result.filePaths[0] });
});
ipcMain.handle('recording:start', (event, previousId) => {
  if (!trustedSender(event) || closing || (previousId !== undefined && typeof previousId !== 'string')) throw new Error('请求来源无效');
  return recording.start(previousId);
});
ipcMain.handle('recording:stop', (event, id) => {
  if (!trustedSender(event) || typeof id !== 'string' || recording.snapshot().recordingId !== id) throw new Error('recordingSessionMismatch');
  return recording.stop();
});
ipcMain.handle('recording:voice-failed', (event, id) => {
  if (!trustedSender(event) || recording.media?.id !== id) throw new Error('recordingSessionMismatch');
  return recording.failMedia(id, 'recordingVoiceUnavailable');
});
ipcMain.handle('recording:voice', (event, id, position, pcm) => {
  if (!trustedSender(event) || closing || recording.media?.id !== id || recording.media.stopping
      || !(recording.media.options.microphone || recording.media.options.friends)) return false;
  return recordingVoice.write(id, position, pcm);
});
ipcMain.handle('recording:status', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.status();
});
ipcMain.handle('recording:replay-start', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.startReplay();
});
ipcMain.handle('recording:replay-save', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.saveReplay();
});
ipcMain.handle('recording:replay-stop', (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.stopReplay();
});
ipcMain.handle('recording:replay-settings', (event, seconds) => {
  if (!trustedSender(event) || closing || ![30, 60, 120].includes(seconds)) throw new Error('请求参数无效');
  return recording.configure({ replaySeconds: seconds });
});
ipcMain.handle('recording:reveal', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const path = await recording.revealPath();
  if (path.endsWith('.mkv')) shell.showItemInFolder(path);
  else { const error = await shell.openPath(path); if (error) throw new Error('无法打开录像目录'); }
});
ipcMain.handle('recording:library', (event, offset) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.library.list(offset);
});
ipcMain.handle('recording:file', async (event, id, action) => {
  if (!trustedSender(event) || closing || !['play', 'reveal', 'delete'].includes(action)) throw new Error('请求来源无效');
  if (action === 'delete') {
    const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '删除本地录像',
      message: '永久删除这个录像文件？', detail: '此操作不能撤销。已发送到群聊的副本不受影响；文件已丢失或被替换时，只移除列表记录。',
      buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1 || closing) return false;
    await recording.library.remove(id); return true;
  }
  const path = await recording.library.filePath(id);
  if (action === 'reveal') shell.showItemInFolder(path);
  else if (await shell.openPath(path)) throw new Error('recordingPlayerUnavailable');
  return true;
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
ipcMain.handle('media:microphone-devices', (event) => {
  if (!trustedSender(event) || closing || process.platform !== 'win32') throw new Error('请求参数无效');
  nativeMediaBridge ??= loadNativeMediaBridge();
  return nativeMediaBridge.listMicrophoneDevices();
});
ipcMain.handle('media:native-microphone:start', (event, sessionId, settings, deviceId, pushToTalk) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128
      || typeof deviceId !== 'string' || !deviceId || deviceId.length > 1024 || /[\u0000-\u001f\u007f]/.test(deviceId)
      || typeof pushToTalk !== 'boolean'
      || !validMicrophoneSettings(settings)) throw new Error('请求参数无效');
  return startNativeMicrophoneCapture(sessionId, settings, deviceId, pushToTalk);
});
ipcMain.on('media:native-microphone:transmission', (event, sessionId, pushToTalk, held, epoch) => {
  if (!trustedSender(event) || closing || typeof pushToTalk !== 'boolean' || typeof held !== 'boolean'
      || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff || nativeMicrophoneSession?.sessionId !== sessionId) return;
  obsAudioHost.setTransmission(sessionId, pushToTalk, held && audioShortcuts.transmissionAllowed(), epoch);
});
ipcMain.handle('media:native-microphone:configure', (event, sessionId, settings) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128
      || !validMicrophoneSettings(settings)) throw new Error('请求参数无效');
  return obsAudioHost.configure(sessionId, settings);
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
  const microphone = nativeMicrophoneSession;
  let microphoneDrops = null;
  diagnostics.microphoneCapture = null;
  if (microphone && !microphone.stopping) {
    try {
      const capture = await obsAudioHost.getDiagnostics(microphone.sessionId);
      microphoneDrops = capture.droppedChunks;
      if (nativeMicrophoneSession === microphone && !microphone.stopping) {
        diagnostics.microphoneCapture = { sourceState: capture.sourceState, sourceFrames: capture.sourceFrames,
          framesReceived: capture.framesReceived, pushToTalk: capture.pushToTalk, transmissionAllowed: capture.transmissionAllowed };
      }
      microphone.hostDroppedChunks = microphoneDrops;
    } catch { /* 可选统计缺失不终止语音；报告保留未知值。 */ }
    if (nativeMicrophoneSession !== microphone) microphoneDrops = null;
  }
  diagnostics.microphoneCaptureDroppedChunks = microphone
    ? microphoneDrops === null ? null : microphoneDrops + microphone.droppedChunks + microphone.rendererDroppedChunks
    : lastMicrophoneDroppedChunks;
  const localRecording = recording.snapshot();
  diagnostics.recording = { phase: localRecording.phase, holdingResources: localRecording.holdingResources,
    applicationAudio: Boolean(recording.media?.options.applicationAudio),
    microphone: Boolean(recording.media?.options.microphone), friends: Boolean(recording.media?.options.friends),
    replay: { phase: localRecording.replay.phase, holdingResources: localRecording.replay.holdingResources, saving: localRecording.replay.saving } };
  return diagnostics;
});
ipcMain.on('window:maximize', (event) => {
  if (!trustedSender(event) || !mainWindow.isMaximizable()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window:close', (event) => { if (trustedSender(event)) mainWindow.close(); });
ipcMain.on('window:closed-media', (event) => {
  if (!trustedSender(event) || !closing) return;
  if (updatePreparing) resolveUpdateRelease?.();
  else finishClose();
});
ipcMain.handle('external:open', async (event, value) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  const url = externalHttpUrl(value);
  if (!url) throw new Error('只允许打开 HTTP 或 HTTPS 链接。');
  await shell.openExternal(url);
});
function shutdownMediaResources() {
  if (mediaHelperShutdownPromise) return mediaHelperShutdownPromise;
  try { audioShortcuts.clear(); } catch { console.error('audio shortcut cleanup failed'); }
  voiceOverlay.clear();
  stopActivityHelper();
  mediaHelperShutdownPromise = recording.stopAll().catch(error => {
    console.error(`recording shutdown failed: ${error.message}`);
  }).then(() => (nativeScreenAudioSession
    ? stopNativeScreenAudio(nativeScreenAudioSession.sessionId).catch((error) => {
      console.error(`native screen audio shutdown failed: ${error.message}`);
    })
    : Promise.resolve()))
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
    .then(() => obsAudioHost.dispose().catch(error => {
      console.error(`OBS audio shutdown failed: ${error.message}`);
    }))
    .then(() => mediaHelper.shutdown())
    .catch((error) => console.error(`media-helper shutdown failed: ${error.message}`))
    .then(() => savedDiagnosticReports.flush())
    .then(() => writeMediaDiagnostic.flush());
  return mediaHelperShutdownPromise;
}
app.on('before-quit', (event) => {
  closing = true;
  desktopTray.dispose();
  if (startupUpdate.getState().phase !== 'installing') startupUpdate.cancel();
  if (allowQuitAfterMediaHelper) return;
  event.preventDefault();
  if (mediaQuitPending) return;
  mediaQuitPending = true;
  void shutdownMediaResources().finally(() => {
    allowQuitAfterMediaHelper = true;
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
function requireShortcutSender(event) {
  if (!trustedSender(event) || closing || !sessionToken || process.platform !== 'win32') throw new Error('当前无法使用全局快捷键');
}
ipcMain.handle('audio-shortcuts:begin', event => { requireShortcutSender(event); return audioShortcuts.begin(); });
ipcMain.handle('audio-shortcuts:configure', (event, owner, bindings, pushToTalk) => { requireShortcutSender(event); audioShortcuts.configure(owner, bindings, pushToTalk); });
ipcMain.handle('audio-shortcuts:hold', (event, owner, roomId, sequence) => { requireShortcutSender(event); return audioShortcuts.readHold(owner, roomId, sequence); });
ipcMain.handle('audio-shortcuts:activate', (event, owner, roomId) => { requireShortcutSender(event); audioShortcuts.activate(owner, roomId); });
ipcMain.handle('audio-shortcuts:capture', (event, owner, enabled) => { requireShortcutSender(event); audioShortcuts.capture(owner, enabled); });
ipcMain.handle('audio-shortcuts:end', (event, owner) => { if (!trustedSender(event)) throw new Error('请求来源无效'); audioShortcuts.end(owner); });
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
ipcMain.handle('voice-overlay:edit', (event, owner, enabled, preview = false) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return voiceOverlay.edit(owner, enabled, preview);
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
async function returnToAccountEntry() {
  let failed = false;
  // 各资源由原持有者停止，某一路失败仍继续回收其余资源。
  for (const stop of [
    () => audioShortcuts.clear(),
    () => screenShareWindows.closeAll(),
    () => activityMonitor.clearMappings(),
    () => voiceOverlay.clear(),
    () => recording.stopAll(),
    () => nativeVideoSession && stopNativeVideo(nativeVideoSession.sessionId),
    () => nativeScreenAudioSession && stopNativeScreenAudio(nativeScreenAudioSession.sessionId, true),
    () => nativeMicrophoneSession && stopNativeMicrophoneCapture(nativeMicrophoneSession.sessionId),
  ]) {
    try { await stop(); }
    catch { failed = true; }
  }
  if (failed) throw new Error('通话资源尚未完全停止，请重试；登录凭据已保留。');
}

ipcMain.handle('auth:return', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能返回登录页。');
  await returnToAccountEntry();
});
ipcMain.handle('auth:qq:open', async (event, url) => {
  if (!trustedSender(event) || closing || typeof url !== 'string' || url.length > 2048) throw new Error('当前不能打开 QQ 授权');
  await shell.openExternal(validateQqAuthorization(url, backend.href));
});
ipcMain.handle('auth:auto-login:get', (event, accountId) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return loginPreferences.get(accountId);
});
ipcMain.handle('auth:auto-login:set', (event, accountId, enabled, manualEntryRequired) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return loginPreferences.set(accountId, enabled, manualEntryRequired);
});
ipcMain.handle('auth:clear', async (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  await returnToAccountEntry();
  await clearSession();
  await loginPreferences.clear();
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
  if (await loadSession()) throw new Error('请先从此设备移除当前账号。');
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  return parseManualAccessLink(value);
});
ipcMain.handle('auth:access:prepare', async (event, offer) => {
  if (!trustedSender(event) || closing) throw new Error('当前不能打开邀请链接。');
  if (await loadSession()) throw new Error('请先从此设备移除当前账号。');
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
  if (await loadSession()) throw new Error('请先清除本机登录凭据，再修改服务器地址。');
  if (!trustedSender(event) || closing) throw new Error('当前不能修改服务器地址。');
  await saveServerSettings(app.getPath('userData'), value);
  // 配置可能已经落盘；用户已关窗时留待下次启动，不再因迟到结果重新打开应用。
  if (!trustedSender(event) || closing) return;
  app.relaunch();
  app.quit();
});

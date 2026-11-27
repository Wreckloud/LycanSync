const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, screen, session, safeStorage, shell, sharedTexture, Tray } = require('electron');
const { release: osRelease } = require('node:os');
const { existsSync } = require('node:fs');
const { Module } = require('node:module');
const { dirname, isAbsolute, resolve, sep, win32 } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, unlink, mkdir } = require('node:fs/promises');
const gzipReport = require('node:util').promisify(require('node:zlib').gzip);
const { MediaHelperManager } = require('./media-helper.cjs');
const { ObsCaptureHostManager } = require('./obs-capture-host.cjs');
const { ObsAudioHostManager } = require('./obs-audio-host.cjs');
const { createNativeMicrophone, validMicrophoneSettings } = require('./native-microphone.cjs');
const { validNativeAudioSessionId } = require('./native-audio-session.cjs');
const { createApplicationAudioSources } = require('./application-audio-sources.cjs');
const { createNativeScreenAudio } = require('./native-screen-audio.cjs');
const { createNativeVideoSession } = require('./native-video-session.cjs');
const { createDiagnosticCopies } = require('./diagnostic-copies.cjs');
const { createSaveDirectories } = require('./save-directories.cjs');
const { createRecording } = require('./recording.cjs');
const { saveChatDownload } = require('./chat-download.cjs');
const { serveRecordingMedia } = require('./recording-media.cjs');
const { createAudioShortcuts } = require('./audio-shortcuts.cjs');
const { createMediaBackgroundPolicy } = require('./media-background.cjs');
const { createDesktopTray } = require('./desktop-tray.cjs');
const { createLoginPreferences } = require('./login-preferences.cjs');
const { createRecordingEditor } = require('./recording-editor.cjs');
const { createRecordingVoice } = require('./recording-voice.cjs');
const { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader, observeVoiceSignalFailures } = require('./media-diagnostics.cjs');
const { validateReportText, compactSavedSamples, createDiagnosticReportStore, parseDiagnosticReport, reportIdPattern } = require('./diagnostic-reports.cjs');
const { loadServerSettings, saveServerSettings } = require('./server-settings.cjs');
const { createNativeThumbnailCache, monitorDisplayId } = require('./native-video-thumbnails.cjs');
const { createWindowThumbnailLoader } = require('./native-window-thumbnails.cjs');
const { parseAccessLink, accessLinkFromArguments, parseManualAccessLink } = require('./access-links.cjs');
const { qqLoginFromArguments, validateQqAuthorization } = require('./qq-login.cjs');
const { createStartupUpdate, parseInstallTiming } = require('./startup-update.cjs');
const { applyRuntimePaths } = require('./runtime-paths.cjs');
const { createActivityHelper } = require('./activity-helper.cjs');
const { createLeagueCaptureFollow } = require('./league-capture.cjs');
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
  ['GET /api/chat/upload-limits', {}],
  ['GET /api/diagnostics/reports', {}],
  ['POST /api/diagnostics/reports/request', {}],
  ['POST /api/diagnostics/reports', { maxBodyBytes: 8 * 1024 * 1024, reportTransfer: true }],
  ['PUT /api/chat/upload-limits', {}],
  ['GET /api/auth/server-settings', {}],
  ['GET /api/auth/server-settings/qq', {}],
  ['PUT /api/auth/server-settings/qq', { maxBodyBytes: 4096 }],
  ['POST /api/auth/account/recover', { public: true, savesSession: true }],
  ['PUT /api/auth/account/recovery-password', {}],
  ['POST /api/auth/account/transfer/verify', {}],
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
  ['POST /api/auth/access/links/invite', {}],
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
const groupAttachmentPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/thumbnail)?$/i;
const transferPath = /^\/api\/groups\/[0-9a-f-]{36}\/files\/transfers$/i;
const declareFilePath = /^\/api\/groups\/[0-9a-f-]{36}\/files\/transfers\/[0-9a-f-]{36}$/i;
const stopFilePath = /^\/api\/groups\/[0-9a-f-]{36}\/files\/transfers\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;
const groupFilePath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files(?:\/(?:requests\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const groupFileDownloadPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupFileMediaPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/(?:media|thumbnail|preview\/media))$/i;
const groupFilePreviewPath = /^\/api\/groups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/preview$/i;
app.setName('LycanSync');
// 整屏缩略图由 Chromium 截取；窗口预览按需在限时进程中生成，避免遍历无关窗口。
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
    dialog.showErrorBox('无法准备 lycanclaw 的运行目录。', `${error.message}\n\n请安装到你有写入权限的目录，例如 D:\\Programs\\LycanSync，避免 Program Files 或 Windows 目录。\n原目录的 data 文件夹保存着账号和设置，请保留，不要先卸载或删除。`);
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
let sessionLoadPromise;
let sessionRevision = 0;
const chatDownloads = new Map();

function cancelChatDownloads() {
  for (const controller of chatDownloads.values()) controller.abort();
}
let sessionMutationPromise = Promise.resolve();
let sessionLoginInProgress = false;
let sessionClearTask;
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
  onRelease: () => nativeMicrophone.cancelTransmission() });
let nativeVideoSourcesById = new Map();
const loadNativeThumbnailBatch = createNativeThumbnailCache();
const writeMediaDiagnostic = createMediaDiagnostics(resolve(app.getPath('userData'), 'screen-share-error.log'));
const windowThumbnails = createWindowThumbnailLoader({ executablePath: mediaHelperPath,
  inspectSource: sourceId => mediaHelper.inspectVideoSource(sourceId),
  encode: ({ bitmap, width, height }) => 'data:image/jpeg;base64,'
    + nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(80).toString('base64'),
  onTiming: entry => { void writeMediaDiagnostic(entry); } });
app.on('will-quit', () => windowThumbnails.dispose());
const savedDiagnosticReports = createDiagnosticReportStore(resolve(app.getPath('userData'), 'diagnostics'));
const diagnosticCopies = createDiagnosticCopies(app.getPath('userData'));
let diagnosticFileTask;
let diagnosticReportsGeneration = 0;
const diagnosticStartedAt = Date.now();
// 保留阶段计时；另记 Node 初始化后的运行时间，补齐更早的模块加载，不代替外部启动计时。
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
      if (!safeStorage.isEncryptionAvailable()) throw new Error('无法保存待确认的邀请链接。');
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
  onFrame: (state, frame) => nativeVideo.receiveFrame(state, frame),
  onFailure: (state, error) => {
    const video = nativeVideo.current;
    if (!video || video.sessionId !== state.videoSessionId) return;
    if (video.stopping) return video.stopPromise;
    if (error.message === 'captureTargetClosed') void writeMediaDiagnostic({ stage: 'screenTargetClosed', code: error.message });
    else recordVideoFailure('obsCaptureHost', error);
    const code = ['captureTargetClosed', 'captureSettingsUnsupported', 'captureBorderUnsupported', 'captureBorderAccessDenied',
      'obsGameBindingUnavailable', 'obsGameTargetMismatch', 'obsWindowBindingUnavailable', 'obsWindowTargetMismatch',
      'obsWindowCaptureStartFailed', 'obsWindowRuntimeUnavailable', 'obsWindowSourceUnavailable',
      'sharedTextureGpuWaitFailed', 'sharedTextureGpuStalled', 'sharedTextureReleaseFailed', 'sharedTextureAcquireFailed',
      'dxgiMonitorUnavailable', 'dxgiAdapterMismatch'].includes(error.message)
      ? error.message : 'obsCaptureHostFailed';
    return nativeVideo.notifyFailure(video, code);
  },
  onAudioFailure: (state, failure) => nativeScreenAudio.notifyFailure(state.videoSessionId, failure.code, failure.audioId),
  onAudioStopped: (state, event) => nativeScreenAudio.confirmStopped(state.videoSessionId, event?.audioId),
  onClosed: (state) => {
    nativeScreenAudio.confirmStopped(state.videoSessionId);
    nativeVideo.releaseHost(state);
  },
  onSuspended: (state, event) => nativeVideo.suspend(state, event),
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
  onFailure: (sessionId, code) => nativeMicrophone.notifyFailure(sessionId, code),
  onDiagnostic: (entry) => { void writeMediaDiagnostic(entry); },
});

const nativeMicrophone = createNativeMicrophone({ host: obsAudioHost, getWindow: () => mainWindow,
  isClosing: () => closing, writeDiagnostic: writeMediaDiagnostic });

const applicationSources = createApplicationAudioSources(executables => {
  const bridge = nativeMediaBridge ??= loadNativeMediaBridge();
  return bridge.listApplicationAudioProcesses(executables);
});
const applicationHost = new ObsCaptureHostManager({
  ...obsAudioSettings, executablePath: obsHostSettings.executablePath,
  configPath: resolve(app.getPath('userData'), 'obs-application-audio', '32.2.2'),
  onAudioFailure: (state, event) => applicationAudio.notifyFailure(state.videoSessionId, event.code, event.audioId),
  onClosed: state => applicationAudio.confirmStopped(state.videoSessionId),
});
const applicationAudio = createNativeScreenAudio({ applicationHost, getVideo: () => undefined,
  getRecording: () => recording, getWindow: () => mainWindow, isClosing: () => closing,
  capability: screenShareAudioCapability, writeDiagnostic: writeMediaDiagnostic });
const nativeScreenAudio = createNativeScreenAudio({ host: obsCaptureHost, getVideo: () => nativeVideo.current,
  getRecording: () => recording, getWindow: () => mainWindow, isClosing: () => closing,
  capability: screenShareAudioCapability, writeDiagnostic: writeMediaDiagnostic });

const nativeVideo = createNativeVideoSession({ host: obsCaptureHost, mediaHelper,
  getSources: () => nativeVideoSourcesById, isCaptureGame: executable => activityMonitor.isCaptureGame(executable),
  getBridge: () => nativeMediaBridge ??= loadNativeMediaBridge(), getWindow: () => mainWindow, sharedTexture,
  getRecording: () => recording, screenAudio: nativeScreenAudio, getGameFollow: () => leagueCaptureFollow,
  isClosing: () => closing, setMediaBackgroundActive, writeDiagnostic: writeMediaDiagnostic, recordFailure: recordVideoFailure });

const recordingVoice = createRecordingVoice();
const recording = createRecording({
  dataDirectory: app.getPath('userData'), host: obsCaptureHost, getVideo: () => nativeVideo.current,
  getApplicationName: video => video.sourceKind === 'monitor' ? '屏幕' : activityMonitor.recordingName(video.executable, video.sourceId),
  ensureVoice: id => recordingVoice.open(id),
  releaseVoice: id => recordingVoice.close(id),
  ensureAudio: async (sessionId) => {
    if (screenShareAudioCapability().reason !== 'windowsApplicationLoopbackProcessTree') {
      throw new Error('recordingApplicationAudioUnavailable');
    }
    await nativeScreenAudio.start(nativeVideo.current.sourceId, sessionId);
  },
  releaseAudio: async (sessionId) => {
    if (nativeScreenAudio.sessionId === sessionId && !nativeScreenAudio.publishing) {
      await nativeScreenAudio.stop(sessionId, true);
    }
  },
  onChange: state => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('recording:state', state);
    }
  },
  onDiagnostic: entry => { void writeMediaDiagnostic(entry); },
});

const saveDirectories = createSaveDirectories(app.getPath('userData'), recording);

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

function screenShareAudioCapability() {
  const build = process.platform === 'win32' ? Number(osRelease().split('.')[2]) : 0;
  if (build >= 19041) return { available: true, reason: 'windowsApplicationLoopbackProcessTree' };
  if (build >= 15063) return { available: true, reason: 'windowsSystemMixLoopback' };
  return { available: false, reason: process.platform === 'win32'
    ? 'windowsEventDrivenLoopbackRequiresBuild15063' : 'platformUnsupported' };
}

function handleMediaHelperFailure(state, code) {
  const video = nativeVideo.current;
  if (video && (video.helperState === state || video.targetState === state
      || (!video.helperState && state.videoSessionId === video.sessionId))) {
    nativeVideo.notifyFailure(video, code);
  }
  const audioSessionId = nativeScreenAudio.sessionId;
  if (audioSessionId && (state.videoSessionId === audioSessionId || state === video?.helperState)) {
    nativeScreenAudio.notifyFailure(audioSessionId, code);
  }
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

function stopActivityHelper() { activityMonitor.stop(); }

async function loadSession() {
  if (sessionLoaded) return sessionToken;
  sessionLoadPromise ??= (async () => {
    try {
      const encrypted = await readFile(resolve(app.getPath('userData'), 'session.bin'));
      // 清除或新保存已确认后，旧磁盘读取不能恢复或覆盖当前会话。
      if (sessionLoaded) return sessionToken;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用。');
      const saved = JSON.parse(safeStorage.decryptString(encrypted));
      // 会话绑定服务地址，不能向另一个部署实例发送旧凭据。
      if (saved.server === backend.origin && /^[A-Za-z0-9_-]{43}$/.test(saved.token)) sessionToken = saved.token;
    } catch (error) {
      if (!sessionLoaded && error.code !== 'ENOENT') throw new Error('无法读取本机登录信息，请清除本机登录信息后重新登录。');
    }
    sessionLoaded = true;
    return sessionToken;
  })().finally(() => { sessionLoadPromise = undefined; });
  return sessionLoadPromise;
}

function queueSessionMutation(operation) {
  const task = sessionMutationPromise.then(operation);
  // 调用方仍收到原错误，后续清除或重试不能被前一次失败阻断。
  sessionMutationPromise = task.catch(() => undefined);
  return task;
}

async function saveSession(token, accountId) {
  const revision = sessionRevision;
  const ensureCurrent = () => { if (revision !== sessionRevision) throw new Error('登录流程已取消。'); };
  return queueSessionMutation(async () => {
    ensureCurrent();
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密功能不可用，无法安全保存自动登录信息。');
    // 新凭据持久化前记录首次手动确认，避免关窗重开绕过账号确认。
    await loginPreferences.set(accountId, true, true);
    ensureCurrent();
    const encrypted = safeStorage.encryptString(JSON.stringify({ server: backend.origin, token }));
    await mkdir(app.getPath('userData'), { recursive: true });
    ensureCurrent();
    await writeFile(resolve(app.getPath('userData'), 'session.bin'), encrypted);
    ensureCurrent();
    sessionToken = token;
    sessionLoaded = true;
  });
}

async function clearSession() {
  cancelChatDownloads();
  sessionRevision++;
  diagnosticFileTask?.abort();
  sessionToken = undefined;
  sessionLoaded = true;
  try { audioShortcuts.clear(); } catch { console.error('audio shortcut cleanup failed'); }
  screenShareWindows.closeAll();
  activityMonitor.stop();
  activityMonitor.clearMappings();
  voiceOverlay.clear();
  // 写入已开始时先等它结束再移除，不能让迟到的旧写入重新生成凭据文件。
  return queueSessionMutation(async () => {
    try { await unlink(resolve(app.getPath('userData'), 'session.bin')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
}

function clearAccountSession() {
  if (sessionClearTask) return sessionClearTask;
  sessionRevision++;
  diagnosticFileTask?.abort();
  sessionClearTask = (async () => {
    await returnToAccountEntry();
    await clearSession();
    await loginPreferences.clear();
  })().finally(() => { sessionClearTask = undefined; });
  return sessionClearTask;
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

async function finishClose() {
  clearTimeout(closeTimer);
  // 渲染端超时或崩溃时仍由主进程收尾录像，不能先销毁仍在提供录制人声的页面。
  try { await shutdownMediaResources(); }
  catch (error) { console.error(`media shutdown failed: ${error.message}`); }
  finally {
    canClose = true;
    screenShareWindows.closeAll();
    voiceOverlay.clear();
    mainWindow?.destroy();
  }
}

// 打包页面与业务接口同源；媒体连接仍由 LiveKit SDK 直接建立，不经此代理。
async function serveApplication(request) {
  const url = new URL(request.url);
  if (!trustedUrl(request.url)) return new Response(null, { status: 403 });
  if (url.pathname.startsWith('/recordings/')) {
    if (closing) return new Response(null, { status: 503 });
    return serveRecordingMedia(request, recording.library);
  }
  if (url.pathname.startsWith('/api/')) {
    const routePolicy = apiRoutePolicies.get(`${request.method} ${url.pathname}`)
      ?? (/^\/api\/auth\/access\/links\/[0-9a-f-]{36}(?:\/renew|\/url|\/note)?$/i.test(url.pathname)
        && ((request.method === 'POST' && url.pathname.endsWith('/renew'))
          || (request.method === 'GET' && url.pathname.endsWith('/url'))
          || (request.method === 'PUT' && url.pathname.endsWith('/note'))
          || (request.method === 'DELETE' && !/\/(renew|url|note)$/.test(url.pathname))) ? {} : undefined)
      ?? (request.method === 'GET' && transferPath.test(url.pathname) ? {} : undefined)
      ?? (request.method === 'GET' && url.pathname.startsWith('/api/diagnostics/reports/')
        && reportIdPattern.test(url.pathname.slice('/api/diagnostics/reports/'.length)) ? { reportTransfer: true } : undefined)
      ?? (request.method === 'POST' && declareFilePath.test(url.pathname) ? { maxBodyBytes: 48 * 1024 } : undefined)
      ?? (request.method === 'DELETE' && stopFilePath.test(url.pathname) ? {} : undefined)
      ?? (request.method === 'GET' && groupMessagePath.test(url.pathname) && url.searchParams.get('wait') === 'true'
        ? { longPolling: true } : undefined)
      ?? (request.method === 'GET' && (groupPath.test(url.pathname) || groupMemberProfilePath.test(url.pathname) || groupPresencePath.test(url.pathname) || groupMessagePath.test(url.pathname)
        || groupAttachmentPath.test(url.pathname) || groupFilePath.test(url.pathname)) ? {} : undefined)
      ?? (['GET', 'HEAD'].includes(request.method) && groupFileMediaPath.test(url.pathname) ? {} : undefined)
      ?? (['GET', 'POST'].includes(request.method) && groupFilePreviewPath.test(url.pathname) ? {} : undefined)
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
    const tokenRequest = request.method === 'POST' && url.pathname === '/api/rtc/token'
      ? { startedAt: performance.now() } : null;
    let failureMessage = '无法读取请求内容，请重试。';
    let ownsLogin = false;
    let loginRevision;
    try {
      const streamingUpload = routePolicy.streamBody === true;
      const body = streamingUpload ? request.body
        : ['POST', 'PUT'].includes(request.method) ? Buffer.from(await request.arrayBuffer()) : undefined;
      if (body instanceof Buffer && body.byteLength > (routePolicy.maxBodyBytes ?? 4096)) {
        return Response.json({ code: 'REQUEST_TOO_LARGE', detail: '提交的内容过大，请缩小图片或减少内容后重试。' }, { status: 413 });
      }
      failureMessage = '无法读取本机登录信息，请清除后重新登录。';
      const token = await loadSession();
      if (routePolicy.savesSession) {
        if (token) return Response.json({ detail: '请先清除当前设备的登录信息，再使用其他登录方式。' }, { status: 409 });
        if (sessionLoginInProgress || sessionClearTask) return Response.json({ detail: '当前登录或清理尚未完成，请稍后重试。' }, { status: 409 });
        sessionLoginInProgress = true;
        ownsLogin = true;
        loginRevision = sessionRevision;
      }
      failureMessage = '无法连接服务器，请检查网络和服务器状态。';
      if (tokenRequest) tokenRequest.sentAt = performance.now();
      const response = await net.fetch(new URL(url.pathname + url.search, backend).href, {
        method: request.method,
        headers: { ...(body ? { 'Content-Type': request.headers.get('Content-Type') || 'application/json' } : {}),
          ...(groupFileMediaPath.test(url.pathname) && request.headers.has('Range') ? { Range: request.headers.get('Range') } : {}),
          ...(streamingUpload ? {
            ...(request.headers.has('X-File-Message') ? { 'X-File-Message': request.headers.get('X-File-Message') } : {}),
            'X-File-Name': request.headers.get('X-File-Name') || '',
            'X-File-Size': request.headers.get('X-File-Size') || '',
            'X-Upload-Id': request.headers.get('X-Upload-Id') || '',
            'X-Message-Content': request.headers.get('X-Message-Content') || '',
          } : {}),
          ...(!routePolicy.public && token ? { Authorization: 'Bearer ' + token } : {}) },
        body, ...(streamingUpload ? { duplex: 'half' } : {}), redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([request.signal,
          AbortSignal.timeout(streamingUpload || routePolicy.reportTransfer || groupFileDownloadPath.test(url.pathname) || groupFileMediaPath.test(url.pathname) ? 30 * 60_000
            : routePolicy.longPolling ? 52_000 : 15000)]),
      });
      if (tokenRequest) {
        tokenRequest.headersAt = performance.now();
        tokenRequest.httpStatus = response.status;
        const timing = /(?:^|,)\s*rtc;dur=(\d{1,6})(?=\s*(?:,|$))/.exec(response.headers.get('Server-Timing') ?? '');
        if (timing) tokenRequest.serverIssueMs = Number(timing[1]);
      }
      const currentSessionUnauthorized = !routePolicy.public && Boolean(token)
        && response.status === 401 && token === sessionToken;
      if (!routePolicy.public && token === sessionToken
          && (response.status === 401 || (routePolicy.clearsSession && response.ok))) {
        try { await clearSession(); }
        catch {
          const accountClosed = response.ok && url.pathname === '/api/auth/account/close';
          const message = accountClosed ? '账号已注销。本机登录信息未能清除，请检查数据目录的读写权限。'
            : '已退出登录，但本机登录信息未能清除。请检查数据目录的读写权限。';
          return Response.json({ code: 'LOCAL_SESSION_CLEAR_FAILED', message }, {
            status: currentSessionUnauthorized ? 401 : 502,
            headers: { 'Cache-Control': 'no-store',
              ...(currentSessionUnauthorized || accountClosed ? { 'X-Lycan-Session-Expired': 'true' } : {}) },
          });
        }
      }
      if (routePolicy.savesSession && response.ok) {
        failureMessage = '无法确认登录结果。';
        const result = await response.json();
        if (loginRevision !== sessionRevision) return Response.json({ detail: '登录流程已变化，请重新确认。' }, { status: 409 });
        if (!/^[A-Za-z0-9_-]{43}$/.test(result?.sessionToken ?? '')
            || typeof result.user?.id !== 'string' || !result.user.id
            || typeof result.user.nickname !== 'string' || typeof result.user.avatar !== 'string'
            || typeof result.user.administrator !== 'boolean') throw new Error('登录响应无效');
        failureMessage = '无法保存本机登录信息，请检查数据目录的读写权限和系统加密功能后重试。';
        await saveSession(result.sessionToken, result.user.id);
        if (loginRevision !== sessionRevision) return Response.json({ detail: '登录流程已变化，请重新确认。' }, { status: 409 });
        // 会话原文只进入主进程的系统加密存储，不暴露给渲染页面。
        delete result.sessionToken;
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/diagnostics/reports' && response.ok) {
        failureMessage = '无法核对已接收的日志，请检查日志目录。';
        const entries = await response.json();
        const listed = await Promise.all(entries.map(async entry => ({ ...entry, savedPath: await diagnosticCopies.locate(entry) })));
        if (!token || token !== sessionToken) return Response.json({ detail: '登录状态已变化。' }, { status: 403 });
        return Response.json(listed, { headers: { 'Cache-Control': 'no-store' } });
      }
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        // net.fetch 已解压响应体，压缩后的长度不能用于页面收到的内容。
        ...((!response.headers.has('Content-Encoding') || response.headers.get('Content-Encoding') === 'identity')
          && response.headers.has('Content-Length') ? { 'Content-Length': response.headers.get('Content-Length') } : {}),
        ...(response.headers.has('Content-Range') ? { 'Content-Range': response.headers.get('Content-Range') } : {}),
        ...(response.headers.has('Accept-Ranges') ? { 'Accept-Ranges': response.headers.get('Accept-Ranges') } : {}),
        ...(response.headers.has('Content-Disposition') ? { 'Content-Disposition': response.headers.get('Content-Disposition') } : {}),
        ...(response.headers.has('X-Content-Type-Options') ? { 'X-Content-Type-Options': response.headers.get('X-Content-Type-Options') } : {}),
        ...(response.status === 401 && !routePolicy.public
          ? { 'X-Lycan-Session-Expired': currentSessionUnauthorized ? 'true' : 'false' } : {}),
        'Cache-Control': 'no-store',
      } });
    } catch {
      if (ownsLogin && loginRevision !== sessionRevision) return Response.json({ detail: '登录流程已变化，请重新确认。' }, { status: 409 });
      return Response.json({ message: failureMessage }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    } finally {
      if (ownsLogin) sessionLoginInProgress = false;
      if (tokenRequest) {
        const { startedAt, sentAt, headersAt, httpStatus, serverIssueMs } = tokenRequest;
        const end = headersAt ?? performance.now();
        void writeMediaDiagnostic({ stage: 'voiceTokenRequest', durationMs: Math.round(end - startedAt),
          prepareMs: Math.round((sentAt ?? end) - startedAt),
          ...(sentAt === undefined ? {} : { upstreamHeadersMs: Math.round(end - sentAt) }),
          ...(serverIssueMs === undefined ? {} : { serverIssueMs }),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          outcome: headersAt !== undefined ? 'response' : request.signal.aborted ? 'cancelled'
            : sentAt !== undefined ? 'networkError' : 'localError' });
      }
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
      osVersion: osRelease(), durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt),
      processUptimeMs: Math.round(process.uptime() * 1000) });
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
      title: 'lycanclaw', icon: resolve(__dirname, 'app.ico'), frame: false, show: false, backgroundColor: '#10151a',
      webPreferences: { preload: resolve(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWindow.setMenu(null);
    observeVoiceSignalFailures(mainWindow.webContents, writeMediaDiagnostic);
    desktopTray.initialize();
    screenShareWindows.attach(mainWindow);
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('did-navigate', cancelChatDownloads);
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.webContents.once('did-finish-load', () => {
      void writeMediaDiagnostic({ stage: 'rendererReady', durationMs: Math.round(performance.now() - diagnosticStartedMonotonicAt),
        processUptimeMs: Math.round(process.uptime() * 1000) });
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      cancelChatDownloads();
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
    mainWindow.on('closed', () => { cancelChatDownloads(); clearTimeout(closeTimer); mainWindow = undefined; });
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
  // 更新完成只开放入口；活动检测由账号内的动态配置按需启动。
  if (!closing && !startupReady) startupReady = true;
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
  void writeMediaDiagnostic({ stage, durationMs: Math.round(durationMs), processUptimeMs: Math.round(process.uptime() * 1000) });
});
ipcMain.handle('update:skip', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  if (['idle', 'checking', 'downloading'].includes(startupUpdate.getState().phase)) startupUpdate.cancel();
});

ipcMain.on('media:voice-join-timing', (event, timing) => {
  if (!trustedSender(event) || closing || !timing || typeof timing.microphoneEnabled !== 'boolean') return;
  const entry = { stage: 'voiceJoinReady', microphoneEnabled: timing.microphoneEnabled };
  for (const key of ['durationMs', 'preflightMs', 'tokenMs', 'connectMs', 'roomReadyMs', 'microphoneMs', 'listeningMs']) {
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
ipcMain.on('chat:cancel-download', (event, id) => {
  if (trustedSender(event)) chatDownloads.get(id)?.abort();
});
ipcMain.handle('chat:download', async (event, id, path, name, size) => {
  if (!trustedSender(event) || closing || !sessionToken || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)
      || chatDownloads.has(id) || typeof path !== 'string' || !groupFileDownloadPath.test(path)
      || typeof name !== 'string' || !Number.isSafeInteger(size) || size < 0) throw new Error('文件下载请求无效。');
  const controller = new AbortController();
  const { signal } = controller;
  chatDownloads.set(id, controller);
  try {
    const leaf = win32.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存文件', defaultPath: resolve(app.getPath('downloads'), leaf || 'download') });
    if (result.canceled || signal.aborted) return 'cancelled';
    const response = await serveApplication(new Request(APP_ORIGIN + path, { signal }));
    if (response.status === 401 && response.headers.get('X-Lycan-Session-Expired') === 'true') return 'expired';
    if (!response.ok) return { error: '文件下载失败，请检查连接和群聊访问权限后重试。' };
    let lastUpdate = 0;
    await saveChatDownload(result.filePath, response, size, signal, bytes => {
      const now = Date.now();
      if (!signal.aborted && (now - lastUpdate >= 100 || bytes === size)) {
        event.sender.send('chat:download-progress', id, bytes);
        lastUpdate = now;
      }
    });
    return 'saved';
  } catch (error) {
    if (signal.aborted) return 'cancelled';
    if (error.code && /^(?:EACCES|EPERM|EBUSY|ENOSPC|ENOENT|EROFS)$/.test(error.code)) {
      return { error: '无法保存文件，请检查磁盘空间或选择其他位置。' };
    }
    return { error: '文件未能完整保存，请重试。' };
  } finally {
    controller.abort();
    chatDownloads.delete(id);
  }
});
ipcMain.handle('diagnostics:process-metrics', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return readProcessMetrics(app.getAppMetrics(), [
    { role: 'obs', children: [obsCaptureHost.state, applicationHost.state].filter(Boolean).map(state => state.child), executablePath: obsHostSettings.executablePath },
    { role: 'obs-audio', children: obsAudioHost.state ? [obsAudioHost.state.child] : [], executablePath: obsAudioSettings.executablePath },
    { role: 'media', children: [...mediaHelper.children].map((state) => state.child), executablePath: mediaHelperPath() },
    { role: 'activity', children: activityMonitor.diagnosticProcesses(), executablePath: activityHelperPath() },
  ], process.platform === 'win32');
});
ipcMain.handle('diagnostics:checkpoint', async (event, text) => {
  if (!trustedSender(event) || allowQuitAfterMediaHelper) throw new Error('当前不能保存诊断。');
  const generation = diagnosticReportsGeneration;
  validateReportText(text);
  await writeMediaDiagnostic.flush();
  const endedAt = Date.now();
  if (generation !== diagnosticReportsGeneration) return null;
  try {
    const bytes = await savedDiagnosticReports.checkpoint(text, { startedAt: diagnosticStartedAt, endedAt,
      logPath: resolve(app.getPath('userData'), 'screen-share-error.log'),
      environment: { appVersion: app.getVersion(), electronVersion: process.versions.electron,
        platform: process.platform, arch: process.arch, osVersion: osRelease(), gpuFeatures: app.getGPUFeatureStatus(), gpuUtilization: null },
      persistence: { savedAt: new Date().toISOString(), checkpointIntervalMs: 15_000,
        storage: 'installation-data-directory', unexpectedExitMayLoseLastInterval: true } });
    return generation === diagnosticReportsGeneration ? bytes : null;
  } catch (error) {
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
async function prepareDiagnosticReport(event, text, upload) {
  if (!trustedSender(event) || closing || diagnosticExportPending) throw new Error('当前不能导出诊断。');
  const report = parseDiagnosticReport(text);
  diagnosticExportPending = true;
  const revision = sessionRevision;
  try {
    await writeMediaDiagnostic.flush();
    const eventStartedAt = Math.min(diagnosticStartedAt, Date.parse(report.startedAt));
    const eventEndedAt = Date.now();
    const events = await readDiagnosticEvents(resolve(app.getPath('userData'), 'screen-share-error.log'),
      eventStartedAt, eventEndedAt);
    if (!trustedSender(event) || closing) return { saved: false };
    const retained = await savedDiagnosticReports.all();
    if (!trustedSender(event) || closing) return { saved: false };
    report.environment = { appVersion: app.getVersion(), electronVersion: process.versions.electron,
      platform: process.platform, arch: process.arch, osVersion: osRelease(), gpuFeatures: app.getGPUFeatureStatus(),
      gpuUtilization: null };
    report.events = events;
    report.eventWindow = { startedAt: new Date(eventStartedAt).toISOString(), endedAt: new Date(eventEndedAt).toISOString() };
    report.eventLimit = '最多读取当前及上一份日志各256KiB，保留本次启动至导出最近200项；不含异常正文';
    report.savedReports = report.schemaVersion >= 15 ? await compactSavedSamples(report, retained.reports) : retained.reports;
    if (report.schemaVersion >= 15) report.savedSampleReferences = '历史 samples 中的 $ref 是本文件内的 JSON Pointer，指向完整采样。';
    report.unavailableReports = retained.unavailable;
    const json = JSON.stringify(report);
    let filePath;
    try {
      if (upload) {
        filePath = await diagnosticCopies.submit(json, () => {
          if (closing || !trustedSender(event) || revision !== sessionRevision) throw new Error('登录状态已变化。');
        });
      } else {
        const directory = await saveDirectories.exportDirectory();
        filePath = resolve(directory, `LycanSync-diagnostics-${Date.now()}.json`);
        await mkdir(directory, { recursive: true });
        if (!trustedSender(event) || closing) return { saved: false };
        await writeFile(filePath, json, { encoding: 'utf8', flag: 'wx' });
      }
    } catch (error) {
      if (!upload) throw error;
      // 本机目录不可写时仍可交给服主，调用方分别提示两个结果。
      filePath = null;
    }
    if (upload) return { gzip: await gzipReport(json), filePath, unavailableCount: retained.unavailable.length };
    return { saved: true, filePath, unavailableCount: retained.unavailable.length };
  } finally { diagnosticExportPending = false; }
}
ipcMain.handle('diagnostics:export', (event, text) => prepareDiagnosticReport(event, text, false));
ipcMain.handle('diagnostics:prepare-upload', (event, text) => prepareDiagnosticReport(event, text, true));
ipcMain.handle('diagnostics:clean-copies', event => {
  if (!trustedSender(event) || closing) throw new Error('无法清理日志副本。');
  return diagnosticCopies.clean();
});
ipcMain.on('diagnostics:cancel-file', event => {
  if (trustedSender(event)) diagnosticFileTask?.abort();
});
ipcMain.handle('diagnostics:file', async (event, id, action) => {
  if (!trustedSender(event) || closing || typeof id !== 'string' || !reportIdPattern.test(id) || !['open', 'delete'].includes(action)) throw new Error('日志操作无效。');
  if (diagnosticFileTask) throw new Error('请等待当前日志操作完成。');
  const revision = sessionRevision;
  const controller = diagnosticFileTask = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
  const ensureCurrent = () => {
    signal.throwIfAborted();
    if (closing || revision !== sessionRevision || !trustedSender(event)) throw new Error('登录状态已变化。');
  };
  try {
    const url = APP_ORIGIN + '/api/diagnostics/reports';
    const response = await serveApplication(new Request(url, { signal }));
    if (!response.ok) throw new Error('无法读取报告，请确认仍拥有服主权限。');
    const entry = (await response.json()).find(item => item.id === id);
    ensureCurrent();
    if (!entry || !Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0 || entry.byteSize > 40 * 1024 * 1024) throw new Error('报告已移除或信息无效。');
    if (action === 'delete') return await diagnosticCopies.remove(entry, ensureCurrent);
    const path = await diagnosticCopies.open(entry, () => serveApplication(new Request(url + '/' + id, { signal })), signal, ensureCurrent);
    ensureCurrent();
    shell.showItemInFolder(path);
  } finally { diagnosticFileTask = undefined; }
});
ipcMain.handle('presence:system-idle-state', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return activityMonitor.systemIdleState({
    state: powerMonitor.getSystemIdleState(300),
    idleSeconds: powerMonitor.getSystemIdleTime(),
  });
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
ipcMain.handle('activity:configure', (event, mappings, selectedExecutable) => {
  if (!trustedSender(event) || closing || !startupReady) throw new Error('请求来源无效');
  void nativeVideo.prepare(null);
  return activityMonitor.configure(mappings, selectedExecutable);
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
  const gameWindows = currentActivity?.type === 'GAME' ? currentActivity.windowIds : undefined;
  return { ...snapshot, sources: snapshot.sources.filter(source => !source.minimized || gameWindows?.includes(source.windowId)) };
});
ipcMain.handle('media:video-source:prepare', (event, sourceId) => {
  if (!trustedSender(event) || closing || (sourceId !== null && (typeof sourceId !== 'string'
      || !/^(?:monitor|window):[1-9]\d*:\d+$/.test(sourceId)))) throw new Error('请求来源无效');
  return nativeVideo.prepare(sourceId);
});
ipcMain.on('media:screen-picker-timing', (event, stage, durationMs, details) => {
  if (!trustedSender(event) || closing || !['screenPickerSourcesReady', 'screenPickerPreviewReady', 'screenPickerVisibleReady', 'screenPickerSelectionReady', 'screenPickerClosed'].includes(stage)
      || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 300_000) return;
  const counts = {};
  if (details !== undefined) {
    if (!details || !Number.isSafeInteger(details.pickerId) || details.pickerId < 1
        || !Number.isInteger(details.sourceCount) || details.sourceCount < 0 || details.sourceCount > 128
        || !Number.isInteger(details.readyCount) || details.readyCount < 0 || details.readyCount > details.sourceCount) return;
    Object.assign(counts, { pickerId: details.pickerId, sourceCount: details.sourceCount, readyCount: details.readyCount });
    if (typeof details.confirmed === 'boolean') counts.confirmed = details.confirmed;
  }
  void writeMediaDiagnostic({ stage, durationMs: Math.round(durationMs), ...counts });
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
      if (kind === 'window' && process.platform === 'win32') {
        return Promise.all(sources.filter(source => source.kind === kind).map(source => {
          const current = nativeVideoSourcesById.get(source.sourceId);
          return current && current.title === source.title && current.windowId === source.windowId
            ? windowThumbnails.load(state, current) : [];
        })).then(results => results.flat());
      }
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
      }, new Set(sources.filter(source => source.kind === kind).map(source => source.sourceId)));
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
ipcMain.handle('media:native-video:start', (event, sourceId, maxFps, settings, resolution, discoveryId) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const startedAt = performance.now();
  if (discoveryId !== undefined && discoveryId !== mediaHelper.videoSourceSnapshot?.state.discoveryId) throw new Error('videoSourceExpired');
  return nativeVideo.start(sourceId, maxFps, settings, resolution).catch(error => {
    void writeMediaDiagnostic({ stage: 'screenVideoStartFailed',
      code: String(error?.message ?? error).match(/(?:^|: )([a-z][A-Za-z0-9]{0,63})$/)?.[1],
      durationMs: Math.round(performance.now() - startedAt) });
    throw error;
  });
});
ipcMain.on('media:screen-share-startup', (event, sessionId, stage, durationMs, audioTiming) => {
  const video = nativeVideo.current;
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
  return nativeVideo.stop(sessionId);
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
  return recording.withVideoChange(() => nativeVideo.switchGame(id, sourceId, maxFps, settings, resolution));
});
ipcMain.handle('media:game-follow:end', (event, id) => {
  if (!trustedSender(event) || typeof id !== 'string' || id.length > 128) throw new Error('请求参数无效');
  leagueCaptureFollow.end(id);
});
ipcMain.handle('media:native-video:configure', (event, sessionId, maxFps, resolution, deliveryOnly = false) => {
  if (!trustedSender(event) || closing || !nativeVideo.current || nativeVideo.current.stopping
      || nativeVideo.current.sessionId !== sessionId || typeof deliveryOnly !== 'boolean') throw new Error('请求参数无效');
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
ipcMain.handle('settings:save-directory', (event, kind, action) => saveDirectories.operate(kind, action, {
  allowed: () => trustedSender(event) && !closing,
  choose: async defaultPath => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择保存位置', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  open: directory => shell.openPath(directory),
}));
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
  if (!trustedSender(event) || recording.media?.id !== id || recording.media.stopping
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
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return recording.stopReplay();
});
ipcMain.handle('recording:replay-settings', (event, settings) => {
  if (!trustedSender(event) || closing || !settings || typeof settings !== 'object' || Array.isArray(settings)
      || Object.keys(settings).length !== 1
      || !((Object.hasOwn(settings, 'seconds') && [30, 60, 120].includes(settings.seconds))
        || (Object.hasOwn(settings, 'enabled') && typeof settings.enabled === 'boolean'))) throw new Error('请求参数无效');
  return recording.configure(Object.hasOwn(settings, 'enabled') ? { replayEnabled: settings.enabled } : { replaySeconds: settings.seconds });
});
const recordingEditor = createRecordingEditor({ library: recording.library,
  executablePath: resolve(dirname(obsHostSettings.executablePath), 'lycansync-recording-clip.exe'),
  onProgress: progress => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording:clip-progress', progress); },
  onDiagnostic: message => { void writeMediaDiagnostic(message); },
});
ipcMain.handle('recording:frame-rate', (event, id) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recordingEditor.frameRate(id);
});
ipcMain.handle('recording:clip', (event, requestId, id, startMs, endMs) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recordingEditor.exportClip(requestId, id, startMs, endMs);
});
ipcMain.handle('recording:clip-cancel', (event, requestId) => {
  if (!trustedSender(event) || typeof requestId !== 'string') throw new Error('请求来源无效');
  return recordingEditor.cancel(requestId);
});
ipcMain.handle('recording:library', (event, offset, kind) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.library.list(offset, kind);
});
ipcMain.handle('recording:duration', (event, id, durationMs) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  return recording.library.updateDuration(id, durationMs);
});
ipcMain.handle('recording:file', async (event, id, action) => {
  if (!trustedSender(event) || closing || !['play', 'reveal', 'delete', 'relink', 'clearUnavailable'].includes(action)) throw new Error('请求来源无效');
  if (action === 'relink' || action === 'clearUnavailable') {
    const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: '整理录像记录',
      message: action === 'relink' ? '将原位置的文件重新关联到这条录像记录？' : '移除找不到原片或文件身份已变化的记录？',
      detail: action === 'relink' ? '旧版录制可能误判文件已被替换。确认后可重新预览，请核对录像内容。' : '只清理列表记录，不删除任何录像文件。',
      buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1 || closing) return false;
    if (action === 'relink') await recording.library.relink(id); else await recording.library.clearUnavailable();
    return true;
  }
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
      || nativeVideo.current?.sessionId !== sessionId || nativeVideo.current.starting || nativeVideo.current.stopping
      || !nativeVideo.current.sourceId.startsWith('monitor:')) {
    throw new Error('remoteControlInvalidSession');
  }
  return mediaHelper.setRemoteControl(sessionId, controlSessionId, controllerIdentity);
});
ipcMain.handle('media:remote-control:input', (event, sessionId, controlSessionId, controllerIdentity, sequence, input) => {
  if (!trustedSender(event) || closing || nativeVideo.current?.sessionId !== sessionId
      || nativeVideo.current.starting || nativeVideo.current.stopping || !nativeVideo.current.sourceId.startsWith('monitor:')) {
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
ipcMain.handle('media:application-audio:sources', event => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  if (screenShareAudioCapability().reason !== 'windowsApplicationLoopbackProcessTree') throw new Error('screenShareAudioUnsupported');
  return applicationSources.list();
});
ipcMain.handle('media:application-audio:start', (event, sourceId, publicationId) => {
  if (!trustedSender(event) || closing || !validNativeAudioSessionId(publicationId)) throw new Error('请求参数无效');
  return applicationAudio.start(sourceId, publicationId, publicationId, applicationSources.resolve(sourceId));
});
ipcMain.handle('media:native-screen-audio:start', (event, sourceId, sessionId, publicationId) => {
  if (!trustedSender(event) || closing || typeof sourceId !== 'string' || sourceId.length > 128
      || !validNativeAudioSessionId(sessionId) || !validNativeAudioSessionId(publicationId)) {
    throw new Error('请求参数无效');
  }
  return nativeScreenAudio.start(sourceId, sessionId, publicationId);
});
ipcMain.handle('media:native-screen-audio:stop', (event, publicationId) => {
  if (!trustedSender(event) || !validNativeAudioSessionId(publicationId)) {
    throw new Error('请求参数无效');
  }
  return (applicationAudio.sessionId === publicationId ? applicationAudio : nativeScreenAudio).stopPublishing(publicationId);
});
ipcMain.on('media:native-screen-audio:consumed', (event, sessionId, sequence, droppedChunks) => {
  if (!trustedSender(event)) return;
  const audio = applicationAudio.sessionId === sessionId ? applicationAudio : nativeScreenAudio;
  audio.acknowledge(sessionId, sequence, droppedChunks);
});
ipcMain.handle('media:microphone-echo-output', (event, selector) => {
  if (!trustedSender(event)) throw new Error('请求参数无效');
  return obsAudioHost.setReference(selector);
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
  return nativeMicrophone.start(sessionId, settings, deviceId, pushToTalk);
});
ipcMain.on('media:native-microphone:transmission', (event, sessionId, pushToTalk, held, epoch) => {
  if (!trustedSender(event) || closing || typeof pushToTalk !== 'boolean' || typeof held !== 'boolean'
      || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff || nativeMicrophone.sessionId !== sessionId) return;
  nativeMicrophone.setTransmission(sessionId, pushToTalk, held && audioShortcuts.transmissionAllowed(), epoch);
});
ipcMain.handle('media:native-microphone:configure', (event, sessionId, settings) => {
  if (!trustedSender(event) || closing || typeof sessionId !== 'string' || sessionId.length > 128
      || !validMicrophoneSettings(settings)) throw new Error('请求参数无效');
  return nativeMicrophone.configure(sessionId, settings);
});
ipcMain.handle('media:native-microphone:stop', (event, sessionId) => {
  if (!trustedSender(event) || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error('请求参数无效');
  }
  return nativeMicrophone.stop(sessionId);
});
ipcMain.on('media:native-microphone:consumed', (event, sessionId, sequence, droppedChunks, workletDropped) => {
  if (!trustedSender(event)) return;
  nativeMicrophone.acknowledge(sessionId, sequence, droppedChunks, workletDropped);
});
ipcMain.on('media:native-video:receiver-error', (event, failure) => {
  if (!trustedSender(event) || !nativeVideo.current || nativeVideo.current.stopping
      || failure?.sessionId !== nativeVideo.current.sessionId || typeof failure.message !== 'string') return;
  recordVideoFailure('receiveTexture', failure.message.slice(0, 2000));
  nativeVideo.notifyFailure(nativeVideo.current, 'sharedTextureReceiverFailed');
});
ipcMain.handle('media:diagnostics', async (event) => {
  if (!trustedSender(event) || closing) throw new Error('请求来源无效');
  const diagnostics = await mediaHelper.getDiagnostics();
  const video = nativeVideo.current;
  if (video) {
    const obsDiagnostics = await obsCaptureHost.getDiagnostics(video.sessionId);
    if (nativeVideo.current !== video) throw new Error('videoSessionMismatch');
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
    const audioDrops = nativeScreenAudio.droppedChunks;
    diagnostics.screenShareAudio.droppedAudioChunks = (diagnostics.screenShareAudio.droppedAudioChunks ?? 0) + audioDrops;
  }
  Object.assign(diagnostics, await nativeMicrophone.diagnostics());
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
  mediaHelperShutdownPromise = recordingEditor.cancel().then(() => recording.stopAll()).catch(error => {
    console.error(`recording shutdown failed: ${error.message}`);
  }).then(() => (nativeScreenAudio.sessionId
    ? nativeScreenAudio.stop(nativeScreenAudio.sessionId).catch((error) => {
      console.error(`native screen audio shutdown failed: ${error.message}`);
    })
    : Promise.resolve()))
    .then(() => nativeMicrophone.sessionId
      ? nativeMicrophone.stop(nativeMicrophone.sessionId).catch((error) => {
        console.error(`native microphone shutdown failed: ${error.message}`);
      })
      : Promise.resolve())
    .then(() => nativeVideo.current
    ? nativeVideo.stop(nativeVideo.current.sessionId).catch((error) => {
      console.error(`native video shutdown failed: ${error.message}`);
    })
    : Promise.resolve())
    .then(async () => {
      try { if (applicationAudio.sessionId) await applicationAudio.stop(applicationAudio.sessionId, true); }
      finally { await applicationHost.dispose(); }
    }).catch(error => console.error('application audio shutdown failed', error))
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
async function returnToAccountEntry() {
  let failed = false;
  // 各资源由原持有者停止，某一路失败仍继续回收其余资源。
  for (const stop of [
    () => audioShortcuts.clear(),
    () => screenShareWindows.closeAll(),
    () => activityMonitor.stop(),
    () => activityMonitor.clearMappings(),
    () => voiceOverlay.clear(),
    () => recordingEditor.cancel(),
    () => recording.stopAll(),
    () => nativeVideo.current && nativeVideo.stop(nativeVideo.current.sessionId),
    () => applicationAudio.sessionId && applicationAudio.stop(applicationAudio.sessionId, true),
    () => nativeScreenAudio.sessionId && nativeScreenAudio.stop(nativeScreenAudio.sessionId, true),
    () => nativeMicrophone.sessionId && nativeMicrophone.stop(nativeMicrophone.sessionId),
    () => savedDiagnosticReports.flush(),
    () => writeMediaDiagnostic.flush(),
  ]) {
    try { await stop(); }
    catch {
      failed = true;
      void writeMediaDiagnostic({ stage: 'accountExitCleanupFailed' });
    }
  }
  if (failed) throw new Error('退出时发生问题，请关闭并重新打开应用。');
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
ipcMain.handle('auth:clear', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return clearAccountSession();
});

ipcMain.handle('settings:server:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  return { apiUrl: backend.origin, editable: true };
});
ipcMain.handle('auth:access:get', (event) => {
  if (!trustedSender(event)) throw new Error('请求来源无效');
  if (pendingAccessError) throw new Error('无法读取邀请链接，请从网页重新打开。');
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
  if (await loadSession()) throw new Error('请先清除本机登录信息，再修改服务器地址。');
  if (!trustedSender(event) || closing) throw new Error('当前不能修改服务器地址。');
  await saveServerSettings(app.getPath('userData'), value);
  // 配置可能已经落盘；用户已关窗时留待下次启动，不再因迟到结果重新打开应用。
  if (!trustedSender(event) || closing) return;
  app.relaunch();
  app.quit();
});

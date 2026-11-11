const { app, BrowserWindow, ipcMain, sharedTexture, screen, session } = require('electron');
const { readFileSync, existsSync } = require('node:fs');
const { Module } = require('node:module');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { runInNewContext } = require('node:vm');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { cpus } = require('node:os');
const { ObsCaptureHostManager } = require('../obs-capture-host.cjs');
const { MediaHelperManager } = require('../media-helper.cjs');
const { createMediaBackgroundPolicy } = require('../media-background.cjs');

if (process.env.LYCANSYNC_RUN_OBS_CAPTURE_TEST !== '1') throw new Error('captureDeviceTestNotEnabled');

const projectRoot = resolve(__dirname, '../../../..');
const prepared = resolve(projectRoot, 'release/build-cache/obs-32.2.2/prepared');
const helperPath = resolve(prepared, 'bin/64bit/lycansync-obs-capture-host.exe');
const monitorName = process.argv.at(-1);
const resourceCheck = process.env.LYCANSYNC_CAPTURE_RESOURCE_CHECK === '1';
const qualityCheck = process.env.LYCANSYNC_CAPTURE_QUALITY_CHECK === '1';
const windowCheck = process.env.LYCANSYNC_CAPTURE_WINDOW_CHECK === '1';
const gameCheck = process.env.LYCANSYNC_CAPTURE_GAME_CHECK === '1';
const repeatCheck = process.env.LYCANSYNC_CAPTURE_REPEAT_CHECK === '1';
if (repeatCheck && !windowCheck && !gameCheck) throw new Error('repeatCheckRequiresTestWindow');
const applicationCheck = process.env.LYCANSYNC_CAPTURE_APPLICATION_CHECK === '1';
const applicationRepeats = Number(process.env.LYCANSYNC_CAPTURE_APPLICATION_REPEATS ?? 1);
if (![1, 2, 3].includes(applicationRepeats)) throw new Error('invalidApplicationTestRepeats');
const startupCheck = process.env.LYCANSYNC_CAPTURE_STARTUP_CHECK === '1';
if ([resourceCheck, qualityCheck, windowCheck, applicationCheck, gameCheck, startupCheck].filter(Boolean).length > 1) throw new Error('captureTestModesConflict');
const rustPath = resolve(projectRoot, 'native/media-helper/target/release/lycansync-media.exe');
const cases = [];
const failures = [];
const diagnostics = [];
const captureEvidence = [];
let window;
let production;
let manager;
let targetHelper;
let targetFixture;
let finishing = false;
let testPhase = 'initialization';
let windowSample;
let gpuDiagnostics;

async function readResources(state) {
  // 只读取本测试持有的子进程；工作集分开记录，不能当作整机物理内存。
  const readProcess = async (owned) => {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
      `$captureProcess = Get-Process -Id ${owned.child.pid} -ErrorAction Stop; `
      + '[pscustomobject]@{cpuSeconds=$captureProcess.TotalProcessorTime.TotalSeconds; '
      + 'workingSetMiB=$captureProcess.WorkingSet64/1MB; privateMiB=$captureProcess.PrivateMemorySize64/1MB} | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 5000 });
    return JSON.parse(stdout);
  };
  const identityState = targetHelper?.videoCapture?.state;
  const [helper, identityHelper] = await Promise.all([readProcess(state), identityState ? readProcess(identityState) : null]);
  return { at: performance.now(), helper, identityHelper, electron: app.getAppMetrics() };
}

function resourceSummary(before, after) {
  const seconds = (after.at - before.at) / 1000;
  assert(seconds > 0 && Number.isFinite(before.helper.cpuSeconds)
    && Number.isFinite(after.helper.cpuSeconds) && after.helper.cpuSeconds >= before.helper.cpuSeconds, 'invalidResourceInterval');
  assert(Boolean(before.identityHelper) === Boolean(after.identityHelper), 'identityHelperChangedDuringSample');
  const identityHelper = before.identityHelper ? {
    cpuPercentOfMachine: +((after.identityHelper.cpuSeconds - before.identityHelper.cpuSeconds) / seconds / cpus().length * 100).toFixed(2),
    workingSetMiB: [before.identityHelper.workingSetMiB, after.identityHelper.workingSetMiB].map(Math.round),
    privateMiB: [before.identityHelper.privateMiB, after.identityHelper.privateMiB].map(Math.round),
  } : null;
  if (identityHelper) assert(Number.isFinite(identityHelper.cpuPercentOfMachine)
    && identityHelper.cpuPercentOfMachine >= 0, 'invalidIdentityResourceInterval');
  const previous = new Map(before.electron.map((entry) => [entry.pid, entry.cpu.cumulativeCPUUsage]));
  let electronCpuSeconds = 0;
  for (const entry of after.electron) {
    const start = previous.get(entry.pid), end = entry.cpu.cumulativeCPUUsage;
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'resourceProcessChanged');
    electronCpuSeconds += end - start;
  }
  const electronWorkingSet = (sample) => Math.round(sample.electron.reduce((sum, entry) => sum + entry.memory.workingSetSize, 0) / 1024);
  return { intervalMs: Math.round(seconds * 1000), logicalProcessors: cpus().length, identityHelper,
    cpuPercentOfMachine: {
      electron: +(electronCpuSeconds / seconds / cpus().length * 100).toFixed(2),
      helper: +((after.helper.cpuSeconds - before.helper.cpuSeconds) / seconds / cpus().length * 100).toFixed(2),
    }, electronWorkingSetMiB: [electronWorkingSet(before), electronWorkingSet(after)],
    helperWorkingSetMiB: [before.helper.workingSetMiB, after.helper.workingSetMiB].map(Math.round),
    helperPrivateMiB: [before.helper.privateMiB, after.helper.privateMiB].map(Math.round) };
}

function sourceRange(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  if (first < 0 || last < first) throw new Error('productionTestBoundaryChanged');
  return source.slice(first, last);
}
function sleep(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }
async function until(check, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(75);
  }
  throw new Error('testConditionTimeout');
}
function renderer(expression) {
  return Promise.race([window.webContents.executeJavaScript(`window.obsCaptureTest.${expression}`),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`rendererOperationTimeout:${expression.split('(')[0]}`)), 12000); timer.unref(); })]);
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function finish(result) {
  if (finishing) return;
  finishing = true;
  try { if (window && !window.isDestroyed()) await renderer('stop()'); }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  try { if (manager?.state) {
    await manager.dispose();
  } }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  try { if (targetHelper) await targetHelper.shutdown(); }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  if (production?.activityMonitor?.stop) {
    production.activityMonitor.stop();
    try { await until(() => production.activityMonitor.diagnosticProcesses().length === 0, 5000); }
    catch { result.cleanupError = 'testActivityHelperExitUnconfirmed'; }
  }
  if (targetFixture && targetFixture.exitCode === null && targetFixture.signalCode === null) {
    targetFixture.stdin.end('quit\n');
    try { await until(() => targetFixture.exitCode !== null || targetFixture.signalCode !== null, 5000); }
    catch { targetFixture.kill(); result.cleanupError = 'testWindowExitUnconfirmed'; }
  }
  result.helperClosed = !manager?.state;
  process.stdout.write(`${JSON.stringify({ type: 'obsCaptureSmokeResult', testPhase, windowSample, gpuDiagnostics, ...result, cases, failures, diagnostics, captureEvidence })}\n`);
  window?.destroy();
  app.exit(result.ok && result.helperClosed && !result.cleanupError ? 0 : 1);
}

app.whenReady().then(async () => {
  process.stdout.write('{"phase":"electronReady"}\n');
  const bridgePath = resolve(projectRoot, 'native/media-bridge/target/x86_64-pc-windows-msvc/release/lycansync_shared_texture_bridge.dll');
  const nativeModule = new Module(bridgePath);
  process.dlopen(nativeModule, bridgePath);
  const bridge = nativeModule.exports;
  const testSession = session.fromPartition('obs-capture-smoke');
  testSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  testSession.setPermissionCheckHandler(() => false);
  testSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const display = screen.getPrimaryDisplay();
  window = new BrowserWindow({ show: false, width: 470, height: 290,
    x: display.workArea.x + 32, y: display.workArea.y + 32,
    alwaysOnTop: true,
    webPreferences: { session: testSession, preload: resolve(__dirname, '../preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') diagnostics.push(String(event.message).slice(0, 250));
  });
  production = { closing: false, process, performance, writeMediaDiagnostic: async () => {},
    setMediaBackgroundActive: createMediaBackgroundPolicy(),
    nativeVideoPreparation: undefined,
    // 此用例不启动录像；保留生产入口对空闲录像状态的查询和变更包裹。
    recording: { active: undefined, snapshot: () => ({ phase: 'idle', holdingResources: false,
      replay: { phase: 'idle', holdingResources: false, saving: false } }),
      withVideoChange: operation => operation() },
    console: { error: (...args) => diagnostics.push(args.map(String).join(' ').slice(0, 250)) },
    setTimeout, clearTimeout, randomUUID, sharedTexture, ipcMain, mainWindow: window,
    nativeMediaBridge: bridge, nativeVideoSession: undefined, lastStoppedNativeVideoSession: undefined,
    nativeScreenAudioSession: undefined, helperProcessBridges: new Map(),
    nativeMicrophone: { diagnostics: async () => ({ microphoneCapture: null, microphoneCaptureDroppedChunks: 0 }) }, lastScreenAudioDroppedChunks: 0,
    nativeVideoSourcesById: new Map([['monitor:1:0', { kind: 'monitor', title: monitorName }]]),
    loadNativeMediaBridge: () => bridge, mediaHelperPath: () => rustPath,
    trustedSender: (event) => event.sender === window.webContents,
    recordVideoFailure: (stage, error, _frame, details = {}) => {
      const failure = { stage, code: String(error.message ?? error).slice(0, 160), ...details };
      failures.push(failure);
      process.stdout.write(`${JSON.stringify({ phase: 'captureFailure', ...failure })}\n`);
    },
  };
  const main = readFileSync(resolve(__dirname, '../main.cjs'), 'utf8');
  // 运行生产入口本身，不复制另一套纹理交付和清理逻辑；不执行应用启动代码。
  runInNewContext([
    sourceRange(main, 'function releaseHelperProcessBridge(', 'function handleVideoCaptureSuspended('),
    sourceRange(main, 'function handleVideoCaptureSuspended(', 'function finishNativeScreenAudioPipe('),
    sourceRange(main, 'function handleMediaHelperFailure(', 'function handleNativeSharedTextureFrame('),
    sourceRange(main, 'function handleNativeSharedTextureFrame(', 'const activityMonitor ='),
    sourceRange(main, "ipcMain.handle('media:native-video:start',", "ipcMain.handle('media:remote-control:authorize',"),
    sourceRange(main, "ipcMain.on('media:native-video:receiver-error',", "ipcMain.handle('media:diagnostics',"),
    sourceRange(main, "ipcMain.handle('media:diagnostics',", "ipcMain.on('window:maximize',"),
  ].join('\n'), production);
  manager = new ObsCaptureHostManager({ executablePath: helperPath,
    modulePath: resolve(prepared, 'obs-plugins/64bit/win-capture.dll'),
    dataPath: resolve(prepared, 'data/obs-plugins/win-capture'),
    configPath: resolve(app.getPath('userData'), 'obs-capture', '32.2.2'),
    onFrame: production.handleNativeSharedTextureFrame,
    onFailure: (state, error) => {
      diagnostics.push(`obsFailure:${error.message}`);
      const video = production.nativeVideoSession;
      if (video && video.sessionId === state.videoSessionId && !video.stopping) {
        production.recordVideoFailure('obsCaptureHost', error);
        production.notifyNativeVideoError(video, error.message === 'captureTargetClosed' ? error.message : 'obsCaptureHostFailed');
      }
    },
    onClosed: production.releaseHelperProcessBridge,
    onSuspended: production.handleVideoCaptureSuspended,
    onCaptureDiagnostic: (_state, entry) => captureEvidence.push({ ...entry, atMs: Math.round(performance.now()) }),
    onDiagnostic: (message) => { if (diagnostics.length < 30) diagnostics.push(message.slice(0, 250)); },
  });
  let sourceId = 'monitor:1:0';
  {
    production.obsCaptureHost = manager;
    targetHelper = new MediaHelperManager({ executablePath: rustPath,
      onHelperFailure: production.handleMediaHelperFailure,
      onDiagnostic: (message) => { if (diagnostics.length < 30) diagnostics.push(String(message).slice(0, 250)); },
    });
    production.mediaHelper = targetHelper;
    const snapshot = await targetHelper.listVideoSources();
    const monitor = snapshot.sources.find((source) => source.kind === 'monitor' && source.title === monitorName);
    assert(monitor, 'primaryMonitorMissing');
    sourceId = monitor.sourceId;
    production.nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  }
  // 不启动活动扫描；自建 D3D 测试程序并非已知游戏，游戏验证显式选择游戏采集。
  production.activityMonitor = { isCaptureGame: async () => false };
  await window.loadFile(resolve(projectRoot, 'release/build-cache/obs-32.2.2/smoke-page/renderer.html'));
  process.stdout.write('{"phase":"pageLoaded"}\n');
  window.showInactive();
  const gpuInfo = await app.getGPUInfo('complete');
  gpuDiagnostics = { devices: gpuInfo.gpuDevice?.map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId, active: device.active })),
    renderer: gpuInfo.auxAttributes?.glRenderer, features: app.getGPUFeatureStatus() };
  testPhase = 'renderer-ready';
  await until(() => window.webContents.executeJavaScript('Boolean(window.obsCaptureTest)'));
  const bounds = window.getContentBounds();
  const point = { x: Math.round((bounds.x + 48 - display.bounds.x) / display.bounds.width * 1920),
    y: Math.round((bounds.y + 48 - display.bounds.y) / display.bounds.height * 1080) };
  const probe = () => renderer(`probe(${point.x},${point.y})`);
  if (startupCheck) {
    const markerVisible = async () => {
      const windowHandle = window.getNativeWindowHandle().readBigUInt64LE().toString();
      const bounds = window.getContentBounds();
      const markerPoint = screen.dipToScreenPoint({ x: bounds.x + 48, y: bounds.y + 48 });
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MarkerVisibility {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
'@
$markerPoint = New-Object MarkerVisibility+Point
$markerPoint.X = ${markerPoint.x}; $markerPoint.Y = ${markerPoint.y}
$markerWindow = [IntPtr]::new([long]${windowHandle})
[MarkerVisibility]::GetAncestor([MarkerVisibility]::WindowFromPoint($markerPoint),2) -eq $markerWindow
`], { windowsHide: true, timeout: 5000 });
      assert(['True', 'False'].includes(stdout.trim()), 'testMarkerVisibilityUnavailable');
      return stdout.trim() === 'True';
    };
    const waitForMarker = async (color) => {
      let lastProbe;
      try {
        await until(async () => {
          const bounds = window.getContentBounds();
          const x = Math.round((bounds.x + 48 - display.bounds.x) / display.bounds.width * 1920);
          const y = Math.round((bounds.y + 48 - display.bounds.y) / display.bounds.height * 1080);
          lastProbe = await renderer(`probe(${x},${y})`);
          const pixel = lastProbe.pixel;
          return pixel && (color === 'magenta'
            ? pixel[0] > 150 && pixel[1] < 70 && pixel[2] > 100
            : pixel[0] < 80 && pixel[1] > 130 && pixel[2] > 130);
        });
      } catch (error) {
        // 只记录固定计数与测试点，区分遮挡和交付失败，不保存画面或其他窗口身份。
        const visible = await markerVisible();
        process.stdout.write(`${JSON.stringify({ phase: 'markerCheckFailed', color, visible,
          pixel: lastProbe?.pixel, presented: lastProbe?.presented, receivedFrames: lastProbe?.input?.receivedFrames,
          submittedFrames: lastProbe?.input?.submittedFrames, writeFailures: lastProbe?.input?.writeFailures })}\n`);
        if (!visible) throw new Error('testMarkerOccluded', { cause: error });
        throw new Error(`startupMarkerMissing:${color}`, { cause: error });
      }
    };
    for (const [height, fps] of [[1080, 60], [1440, 120]]) {
      for (const mode of ['cold', 'prewarmed', 'restart']) {
        assert(await markerVisible(), 'testMarkerOccluded');
        if (mode !== 'restart') await manager.shutdown();
        if (mode === 'prewarmed') { await manager.prepare(false); await manager.prepare(true); }
        const previous = manager.state;
        const evidenceStart = captureEvidence.length;
        process.stdout.write(`${JSON.stringify({ phase: 'startupCase', mode, height, fps })}\n`);
        const started = await renderer(`start(${JSON.stringify(sourceId)},${JSON.stringify({ width: height * 16 / 9, height })},${fps})`);
        const state = manager.state;
        await waitForMarker('magenta');
        await renderer('markerCyan()');
        await waitForMarker('cyan');
        const before = await manager.getDiagnostics(state.videoSessionId);
        const beforeAt = performance.now();
        await sleep(2200);
        const after = await manager.getDiagnostics(state.videoSessionId);
        assert(after.obsRender.configuration > 0 && Number.isFinite(after.obsRender.activeFps)
          && Number.isFinite(after.obsRender.averageRenderMs), 'obsRenderStatisticsMissing');
        const elapsedMs = performance.now() - beforeAt;
        const page = await probe();
        const stopAt = performance.now();
        await renderer('stop()');
        const evidence = captureEvidence.slice(evidenceStart);
        assert(manager.state === state && !state.videoSessionId && !production.nativeVideoSession, 'startupStopNotConfirmed');
        assert(mode !== 'restart' || state === previous, 'restartDidNotReuseHost');
        assert(evidence.some(entry => entry.stage === 'obsCaptureConfigured' && entry.captureMethod === 'dxgi'
          && entry.adapterMatched === true), 'dxgiAdapterMatchMissing');
        assert(evidence.some(entry => entry.stage === 'obsRenderObserved')
          && evidence.some(entry => entry.stage === 'obsSourceReady' && entry.sourceWidth > 0 && entry.sourceHeight > 0), 'sourceEvidenceMissing');
        assert(evidence.some(entry => entry.stage === 'obsCaptureStopped' && entry.stopMode === 'graceful'), 'startupStopWasForced');
        cases.push({ mode, requestedHeight: height, requestedFps: fps, outputWidth: page.width, outputHeight: page.height,
          firstFrameMs: started.firstFrameMs, stopMs: Math.round(performance.now() - stopAt),
          hostFps: Math.round((after.bridgeFrames - before.bridgeFrames) * 1000 / elapsedMs),
          freshPixelsChecked: true, evidence, obsRender: after.obsRender, encoderMeasured: false });
        process.stdout.write(`${JSON.stringify({ phase: 'caseComplete', ...cases.at(-1) })}\n`);
      }
    }
    assert(failures.length === 0, 'startupCaptureFailed');
    await finish({ ok: true });
    return;
  }
  if (applicationCheck) {
    const existingWindowId = process.env.LYCANSYNC_CAPTURE_APPLICATION_WINDOW_ID;
    if (existingWindowId && !/^[1-9]\d{0,19}$/.test(existingWindowId)) throw new Error('invalidApplicationTestWindow');
    const snapshot = await targetHelper.listVideoSources();
    // 浏览器只匹配专用测试标题；已有应用只接受本次明确给出的窗口句柄，不打印其标题。
    const sources = snapshot.sources.filter((source) => source.kind === 'window'
      && (existingWindowId ? source.windowId === existingWindowId : source.title.startsWith('LycanSync OBS Browser Fixture')));
    assert(sources.length === (existingWindowId ? 1 : 2), 'applicationTestSourcesMissing');
    production.nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
    if (existingWindowId) {
      const { createActivityHelper } = require('../activity-helper.cjs');
      const target = await targetHelper.inspectVideoSource(sources[0].sourceId);
      production.activityMonitor = createActivityHelper({ enabled: true,
        executablePath: () => resolve(projectRoot, 'native/activity-helper/target/release/lycansync-activity.exe'), onActivity: () => {} });
      await production.activityMonitor.configure([{ executable: target.executable, name: '本机采集验证' }]);
      assert(!await production.activityMonitor.isCaptureGame(target.executable), 'applicationMisclassifiedAsGame');
    }
    for (const source of Array.from({ length: existingWindowId ? applicationRepeats : 1 }, () => sources).flat()) {
      testPhase = 'application-start';
      const started = await renderer(`start(${JSON.stringify(source.sourceId)})`);
      testPhase = 'application-playback';
      const state = manager.state;
      const palette = new Set();
      const before = await renderer('probe(960,540)');
      const beforeAt = performance.now();
      for (let index = 0; index < 10; index++) {
        await sleep(400);
        const sample = await renderer('probe(960,540)');
        assert(sample.readyState === 'live' && sample.width > 0 && sample.height > 0
          && sample.input.writeFailures === 0 && sample.errors.length === 0, 'applicationPlaybackFailed');
        if (!existingWindowId && sample.pixel) {
          const [red, green, blue] = sample.pixel;
          if (red < 100 && green > 120 && blue < 120) palette.add('parent-green');
          if (red < 100 && green < 120 && blue > 150) palette.add('parent-blue');
          if (red > 150 && green < 100 && blue > 120) palette.add('child-magenta');
          if (red < 100 && green > 120 && blue > 160) palette.add('child-cyan');
        }
      }
      const after = await renderer('probe(960,540)');
      const intervalMs = performance.now() - beforeAt;
      const browserKind = palette.has('parent-green') && palette.has('parent-blue') ? 'browser-main'
        : palette.has('child-magenta') && palette.has('child-cyan') ? 'browser-popup' : undefined;
      assert(existingWindowId || (browserKind && palette.size === 2), 'browserWindowPixelsMismatch');
      assert(after.input.submittedFrames > before.input.submittedFrames + 10
        && after.presented > before.presented + 10, 'applicationFramesStalled');
      if (existingWindowId && applicationRepeats === 1) {
        // 只移动测试接收窗，让色块覆盖已授权来源中心；不激活或操作被采集应用。
        const readCenter = async () => {
          const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ApplicationCaptureCenter {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
'@
$captureWindow = [IntPtr]::new([long]${existingWindowId})
$captureRect = New-Object ApplicationCaptureCenter+Rect
if(-not [ApplicationCaptureCenter]::GetClientRect($captureWindow,[ref]$captureRect)){throw 'applicationClientRectUnavailable'}
$captureCenter = New-Object ApplicationCaptureCenter+Point
$captureCenter.X = ($captureRect.Right-$captureRect.Left)/2
$captureCenter.Y = ($captureRect.Bottom-$captureRect.Top)/2
if(-not [ApplicationCaptureCenter]::ClientToScreen($captureWindow,[ref]$captureCenter)){throw 'applicationClientCenterUnavailable'}
$coverWindow = [ApplicationCaptureCenter]::GetAncestor([ApplicationCaptureCenter]::WindowFromPoint($captureCenter),2)
[pscustomobject]@{X=$captureCenter.X;Y=$captureCenter.Y;Covered=($coverWindow -eq [IntPtr]::new([long]${window.getNativeWindowHandle().readBigUInt64LE()}))} | ConvertTo-Json -Compress
`], { windowsHide: true, timeout: 5000 });
          return JSON.parse(stdout);
        };
        const center = await readCenter();
        assert(Number.isInteger(center.X) && Number.isInteger(center.Y), 'applicationClientCenterInvalid');
        const point = screen.screenToDipPoint({ x: center.X, y: center.Y });
        const previousBounds = window.getContentBounds();
        let coveredPresented;
        try {
          window.setContentBounds({ ...previousBounds, x: point.x - 48, y: point.y - 48 });
          assert((await readCenter()).Covered, 'applicationMarkerDidNotCoverTarget');
          for (const color of ['Magenta', 'Cyan']) {
            testPhase = `application-occlusion-${color.toLowerCase()}`;
            await renderer(`marker${color}()`);
            const beforeMarker = (await renderer('probe(960,540)')).presented;
            for (let index = 0; index < 20; index++) {
              await sleep(75);
              const sample = await renderer('probe(960,540)');
              assert(sample.pixel && sample.errors.length === 0, 'applicationOcclusionSampleUnavailable');
              const [red, green, blue] = sample.pixel;
              assert(!(color === 'Magenta' ? red > 220 && green < 50 && blue > 170
                : red < 50 && green > 190 && blue > 210), 'applicationOcclusionPixelsLeaked');
              coveredPresented = sample.presented;
            }
            assert(coveredPresented > beforeMarker + 10, 'applicationOcclusionPlaybackStalled');
            const covered = await readCenter();
            assert(covered.X === center.X && covered.Y === center.Y, 'applicationTargetMovedDuringOcclusion');
            assert(covered.Covered, 'applicationMarkerOccludedDuringCheck');
          }
        } finally { window.setContentBounds(previousBounds); }
        await until(async () => (await renderer('probe(960,540)')).presented > coveredPresented + 10);
      }
      const sourceDiagnostics = await renderer('diagnostics()');
      assert(sourceDiagnostics.sourceKind === 'window' && sourceDiagnostics.captureBackend === 'obsLibobs', 'applicationDiagnosticsMismatch');
      assert(['bitblt-window', 'wgc-window'].includes(state.captureMethod), 'applicationAutomaticMethodMissing');
      const stopped = await renderer('stop()');
      await until(() => !manager.state?.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
      assert(stopped.readyState === 'ended' && manager.state === state && !state.videoSessionId && !state.closed, 'applicationStopUnconfirmed');
      cases.push({ mode: browserKind ?? 'existing-application', actualMethod: state.captureMethod, firstFrameMs: started.firstFrameMs,
        submittedFps: Math.round((after.input.submittedFrames - before.input.submittedFrames) * 1000 / intervalMs),
        presentedFps: Math.round((after.presented - before.presented) * 1000 / intervalMs),
        freshPixelsChecked: Boolean(browserKind), occlusionChecked: Boolean(existingWindowId) && applicationRepeats === 1,
        hostRetained: manager.state === state && !state.closed });
    }
    if (!existingWindowId) assert(new Set(cases.map((entry) => entry.mode)).size === 2, 'browserWindowsNotDistinct');
    assert(failures.length === 0 && !diagnostics.some((entry) => /Uncaught|Double destroy/.test(entry)), 'applicationCaptureFailure');
    await finish({ ok: true });
    return;
  }
  if (windowCheck || gameCheck) {
    // 正式选择器读取来源时会预热图形；冷启动场景仍可显式单独运行。
    if (windowCheck && !repeatCheck && process.env.LYCANSYNC_CAPTURE_WINDOW_COLD !== '1') {
      testPhase = 'window-prewarm';
      await manager.prepare(true);
    }
    testPhase = 'fixture-start';
    const fixturePath = resolve(projectRoot, 'release/build-cache/obs-32.2.2/cmake-build/test-tools',
      gameCheck ? 'lycansync-obs-test-d3d.exe' : 'lycansync-obs-test-windows.exe');
    assert(existsSync(fixturePath), 'buildWithBuildTestWindowsFirst');
    const events = [];
    let buffer = '';
    const ordinaryMethod = process.env.LYCANSYNC_CAPTURE_WINDOW_WGC === '1' ? 'wgc-window' : 'bitblt-window';
    const mixedMethods = windowCheck && process.env.LYCANSYNC_CAPTURE_WINDOW_MIXED === '1';
    assert(!mixedMethods || ordinaryMethod === 'bitblt-window', 'mixedWindowTestMustStartWithBitblt');
    targetFixture = spawn(fixturePath, mixedMethods ? ['--mixed'] : windowCheck && ordinaryMethod === 'wgc-window' ? ['--wgc'] : [],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    targetFixture.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        events.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    targetFixture.stderr.on('data', (chunk) => diagnostics.push(String(chunk).slice(0, 250)));
    targetFixture.on('error', (error) => { void finish({ ok: false, error: error.message }); });
    const ready = await until(() => {
      if (targetFixture.exitCode !== null || targetFixture.signalCode !== null) throw new Error(`testWindowExited:${targetFixture.exitCode ?? targetFixture.signalCode}`);
      return events.find((event) => event.event === 'ready');
    }, 20000);
    testPhase = 'fixture-source-list';
    const snapshot = await targetHelper.listVideoSources();
    const selected = snapshot.sources.find((source) => source.windowId === ready.windowId);
    const other = snapshot.sources.find((source) => source.windowId === ready.otherWindowId);
    assert(selected && other && selected.title === other.title && selected.sourceId !== other.sourceId, 'sameTitleTestWindowsMissing');
    production.nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
    const statuses = [];
    manager.onSuspended = (state, event) => { statuses.push(event.suspended); production.handleVideoCaptureSuspended(state, event); };
    if (repeatCheck) {
      let cyan = false;
      for (const mode of ['cold', 'prewarmed', 'restart']) {
        testPhase = `repeat-${mode}`;
        if (mode === 'prewarmed') await manager.prepare(true);
        const settings = { hideCursor: false, hideBorder: false, windowMethod: gameCheck ? 'game' : 'auto' };
        const started = await renderer(`start(${JSON.stringify(selected.sourceId)}, undefined, 60, ${JSON.stringify(settings)})`);
        const state = manager.state;
        const before = await renderer('probe(960,540)');
        for (let index = 0; index < 10; index++) {
          if (index === 4) { targetFixture.stdin.write('toggle-color\n'); cyan = !cyan; }
          await sleep(400);
          const sample = await renderer('probe(960,540)');
          assert(sample.readyState === 'live' && sample.errors.length === 0 && sample.input.writeFailures === 0,
            'repeatPlaybackFailed');
          if (index === 3 || index === 9) assert(sample.pixel && sample.pixel[0] < 100
            && sample.pixel[1] > 120 && (cyan ? sample.pixel[2] > 160 : sample.pixel[2] < 120), 'repeatPixelsMismatch');
        }
        const after = await renderer('probe(960,540)');
        assert(after.presented > before.presented + 10, 'repeatFramesStalled');
        assert(state.captureMethod === (gameCheck ? 'game' : ordinaryMethod), 'repeatMethodMismatch');
        const stopped = await renderer('stop()');
        await until(() => !state.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
        assert(stopped.readyState === 'ended' && manager.state === state && !state.closed, 'repeatStopUnconfirmed');
        cases.push({ mode, actualMethod: state.captureMethod, firstFrameMs: started.firstFrameMs,
          freshPixelsChecked: true, hostRetained: true });
        if (mode === 'cold') await manager.shutdown(false, 'idle');
      }
      assert(failures.length === 0, 'repeatCaptureFailure');
      await finish({ ok: true });
      return;
    }
    testPhase = 'window-start';
    const settings = { hideCursor: false, hideBorder: false, windowMethod: gameCheck ? 'game' : 'auto' };
    const started = await renderer(`start(${JSON.stringify(selected.sourceId)}, undefined, 60, ${JSON.stringify(settings)})`);
    testPhase = 'window-initial-color';
    const state = manager.state;
    let cyan = false;
    const selectedColorMatches = async () => { const sample = await renderer('probe(960,540)');
      windowSample = sample;
      return sample.pixel && sample.pixel[0] < 100 && sample.pixel[1] > 120
        && (cyan ? sample.pixel[2] > 160 : sample.pixel[2] < 120); };
    await until(selectedColorMatches);
    const initialWindow = await renderer('probe(960,540)');
    assert(captureEvidence.some(entry => entry.stage === 'obsSourceReady'
      && entry.captureMethod === (gameCheck ? 'game' : ordinaryMethod)), 'automaticWindowMethodMismatch');
    const reserved = await targetHelper.getDiagnostics();
    assert(reserved.state === 'running' && reserved.captureBackend === null && reserved.framesReceived === null, 'identityHelperStartedCapture');
    const command = async (text, event) => {
      const before = events.length;
      targetFixture.stdin.write(`${text}\n`);
      return until(() => events.slice(before).find((entry) => entry.event === event));
    };
    const frameRateChanges = [];
    const identityState = targetHelper.videoCapture;
    // 检查四档对应的原生节奏及回到标准；每次切换后变色，不能用旧纹理冒充恢复。
    for (const [id, custom] of [
      ['highFrameRate', { resolution: 1440, fps: 30 }],
      ['custom', { resolution: 1440, fps: 30 }],
      ['standard', { resolution: 1440, fps: 30 }],
      ['economy', { resolution: 1440, fps: 30 }],
      ['standard', { resolution: 1440, fps: 30 }],
    ]) {
      testPhase = `window-quality-${id}`;
      const configured = await renderer(`configureQuality(${JSON.stringify(id)},${JSON.stringify(custom)})`);
      const { fps } = configured.profile;
      assert(configured.changed && configured.sameTrack && configured.readyState === 'live', 'windowConfigurationReplacedTrack');
      assert(manager.state === state && state.maxFps === fps && targetHelper.videoCapture === identityState,
        'windowConfigurationReplacedIdentity');
      await command('toggle-color', 'colorChanged');
      cyan = !cyan;
      await until(selectedColorMatches);
      const before = await manager.getDiagnostics(state.videoSessionId);
      const beforeAt = performance.now();
      const pageBefore = await renderer('probe(960,540)');
      await sleep(1200);
      const after = await manager.getDiagnostics(state.videoSessionId);
      const intervalMs = performance.now() - beforeAt;
      const pageAfter = await renderer('probe(960,540)');
      const hostFps = Math.round((after.bridgeFrames - before.bridgeFrames) * 1000 / intervalMs);
      assert(hostFps >= fps * 0.75 && hostFps <= fps * 1.25, `windowFrameRateMismatch:${fps}:${hostFps}`);
      assert(pageAfter.presented > pageBefore.presented + 5 && pageAfter.input.submittedFrames > pageBefore.input.submittedFrames + 5
        && pageAfter.input.writeFailures === 0 && pageAfter.errors.length === 0, 'windowConfigurationStoppedPlayback');
      assert(pageAfter.width === initialWindow.width && pageAfter.height === initialWindow.height, 'smallWindowUpscaled');
      frameRateChanges.push({ targetFps: fps, cap: configured.profile.height,
        output: { width: pageAfter.width, height: pageAfter.height }, hostFps, freshPixelsChecked: true, encoderMeasured: false });
    }
    testPhase = 'window-rename';
    await command('rename', 'renamed');
    const refreshed = await targetHelper.listVideoSources();
    assert(refreshed.sources.some((source) => source.windowId === ready.windowId && source.sourceId === selected.sourceId), 'renamedWindowIdentityChanged');
    await until(selectedColorMatches);
    testPhase = 'window-minimize';
    if (windowCheck) {
      const covered = await command(`check-cover:${window.getNativeWindowHandle().readBigUInt64LE()}`, 'coverChecked');
      assert(covered.receiverCoversTarget, 'receiverDidNotCoverBeforeMinimize');
    }
    await command('minimize', 'minimized');
    await until(() => statuses.at(-1) === true);
    const pausedDiagnostics = await renderer('diagnostics()');
    assert(pausedDiagnostics.sourceKind === 'window' && pausedDiagnostics.captureSuspended === true
      && pausedDiagnostics.captureBackend === 'obsLibobs', 'windowPausedDiagnosticsMismatch');
    const paused = await renderer('probe(960,540)');
    await sleep(1200);
    const pauseEnd = await renderer('probe(960,540)');
    assert(pauseEnd.input.submittedFrames <= paused.input.submittedFrames + 1
      && pauseEnd.input.placeholderFrames > paused.input.placeholderFrames, 'minimizedFramesNotSeparated');
    testPhase = 'window-restore';
    await command('restore', 'restored');
    await until(() => statuses.at(-1) === false);
    if (windowCheck) {
      const covered = await command(`check-cover:${window.getNativeWindowHandle().readBigUInt64LE()}`, 'coverChecked');
      assert(covered.receiverCoversTarget, 'receiverDidNotCoverAfterRestore');
    }
    try { await until(selectedColorMatches); }
    catch (error) {
      // 失败时直接读取同一个受控来源，区分取图污染和 Electron 交付污染；不放宽原断言。
      const probePath = resolve(prepared, '../cmake-build/test-tools/lycansync-window-isolation-test.exe');
      if (windowCheck && existsSync(probePath)) {
        const probeArguments = [resolve(prepared, 'obs-plugins/64bit/win-capture.dll'),
          resolve(prepared, 'data/obs-plugins/win-capture'), resolve(app.getPath('userData'), 'native-source-check'),
          '--observe-test-window', ready.windowId];
        try {
          const { stdout } = await promisify(execFile)(probePath, probeArguments, { cwd: resolve(prepared, 'bin/64bit'), timeout: 12000, windowsHide: true });
          diagnostics.push(`native-source-check:${stdout.trim().slice(-500)}`);
        } catch (failure) { diagnostics.push(`native-source-check:${String(failure.stdout ?? failure.message).trim().slice(-500)}`); }
      }
      throw error;
    }
    const restoredDiagnostics = await renderer('diagnostics()');
    assert(restoredDiagnostics.sourceKind === 'window' && restoredDiagnostics.captureSuspended === false,
      'windowRestoredDiagnosticsMismatch');
    testPhase = 'window-stop';
    await renderer('stop()');
    await until(() => !manager.state?.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
    assert(manager.state === state && !state.videoSessionId && !state.closed, 'windowNormalStopWasForced');
    const reopenedSources = await targetHelper.listVideoSources();
    production.nativeVideoSourcesById = new Map(reopenedSources.sources.map((source) => [source.sourceId, source]));
    testPhase = 'window-restart';
    await renderer(`start(${JSON.stringify(selected.sourceId)})`);
    await until(selectedColorMatches);
    const methodSwitches = [];
    if (mixedMethods) {
      methodSwitches.push(manager.state.captureMethod);
      await renderer('stop()');
      await until(() => !state.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
      testPhase = 'window-switch-wgc';
      await renderer(`start(${JSON.stringify(other.sourceId)})`);
      await until(async () => {
        const sample = await renderer('probe(960,540)');
        return sample.pixel && sample.pixel[0] > 150 && sample.pixel[1] < 70 && sample.pixel[2] > 150;
      });
      assert(manager.state === state && state.captureMethod === 'wgc-window', 'retainedHostDidNotChooseWgc');
      methodSwitches.push(state.captureMethod);
      await renderer('stop()');
      await until(() => !state.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
      testPhase = 'window-switch-bitblt';
      await renderer(`start(${JSON.stringify(selected.sourceId)})`);
      await until(selectedColorMatches);
      assert(manager.state === state && state.captureMethod === 'bitblt-window', 'retainedHostDidNotChooseBitblt');
      methodSwitches.push(state.captureMethod);
    }
    testPhase = 'window-close';
    await command('close', 'targetClosed');
    await until(() => !manager.state?.videoSessionId && !production.nativeVideoSession && !targetHelper.videoCapture);
    const ended = await renderer('probe(960,540)');
    assert(ended.readyState === 'ended' && ended.errors.includes('captureTargetClosed'), 'windowClosureNotEnded');
    const remaining = await targetHelper.listVideoSources();
    assert(remaining.sources.some((source) => source.windowId === ready.otherWindowId)
      && !remaining.sources.some((source) => source.windowId === ready.windowId), 'otherWindowWasTakenOver');
    assert(failures.length === 1 && failures[0].code === 'captureTargetClosed', 'unexpectedWindowFailure');
    cases.push({ mode: gameCheck ? 'controlled-d3d-game' : 'window', actualMethod: gameCheck ? 'game' : ordinaryMethod,
      pixelsChecked: true, diagnosticsChecked: true, firstFrameMs: started.firstFrameMs, frameRateChanges,
      methodSwitches,
      windowActions: ['same-title', 'rename-and-refresh', 'minimize', 'restore', 'stop-and-reopen', 'close-without-takeover'],
      helperExitCode: state.child.exitCode, helperSignal: state.child.signalCode,
      handleCount: bridge.currentProcessHandleCount() });
    await finish({ ok: true });
    return;
  }
  async function runCase(mode) {
    process.stdout.write(`${JSON.stringify({ phase: 'caseStarting', mode })}\n`);
    const started = await renderer(`start(${JSON.stringify(sourceId)})`);
    process.stdout.write(`${JSON.stringify({ phase: 'pageStarted', started })}\n`);
    const state = manager.state;
    assert(state?.helperVersion === '32.2.2', 'actualObsVersionMissing');
    let pixelsChecked = false;
    if (mode !== 'receiver-failure' && mode !== 'helper-exit') {
      await until(async () => { const p = await probe(); return p.pixel && p.pixel[0] > 150 && p.pixel[1] < 70 && p.pixel[2] > 100; });
      await renderer('markerCyan()');
      await until(async () => { const p = await probe(); return p.pixel && p.pixel[0] < 80 && p.pixel[1] > 130 && p.pixel[2] > 130; });
      pixelsChecked = true;
    }
    if (resourceCheck) await sleep(2000);
    const resourcesBefore = resourceCheck ? await readResources(state) : undefined;
    const before = await manager.getDiagnostics(state.videoSessionId);
    const nativeBeforeAt = performance.now();
    const pageBefore = await probe();
    const pageBeforeAt = performance.now();
    const durationMs = cases.length === 0 && !qualityCheck ? 15000 : 1000;
    await sleep(durationMs);
    const after = await manager.getDiagnostics(state.videoSessionId);
    const nativeIntervalMs = performance.now() - nativeBeforeAt;
    const page = await probe();
    const intervalMs = performance.now() - pageBeforeAt;
    const resourcesAfter = resourceCheck ? await readResources(state) : undefined;
    assert(page.input.submittedFrames > pageBefore.input.submittedFrames + 5
      && page.presented > pageBefore.presented + 5, 'pageStoppedPresentingFrames');
    assert(page.errors.length === 0 && page.input.writeFailures === 0, 'unexpectedPageFailure');
    const qualityChanges = [];
    if (qualityCheck) {
      for (const [id, custom] of [
        ['standard', { resolution: 1080, fps: 60 }],
        ['custom', { resolution: 1440, fps: 60 }],
        ['custom', { resolution: 1440, fps: 120 }],
        ['economy', { resolution: 1440, fps: 120 }],
        ['standard', { resolution: 1440, fps: 120 }],
      ]) {
        process.stdout.write(`${JSON.stringify({ phase: 'qualityChanging', id, ...custom })}\n`);
        const configured = await renderer(`configureQuality(${JSON.stringify(id)},${JSON.stringify(custom)})`);
        const { width, height, fps } = configured.profile;
        process.stdout.write(`${JSON.stringify({ phase: 'qualityConfigured', width, height, fps })}\n`);
        assert(configured.changed && configured.sameTrack && configured.readyState === 'live', 'qualityReplacedTrack');
        assert(manager.state === state && state.maxFps === fps && state.resolution.width === width
          && state.resolution.height === height, 'qualityReplacedCaptureSession');
        assert(configured.encodings[0].maxFramerate === fps, 'qualitySenderLimitMismatch');
        await renderer('markerMagenta()');
        await until(async () => { const p = await probe(); return p.pixel && p.pixel[0] > 150 && p.pixel[1] < 70 && p.pixel[2] > 100; });
        await renderer('markerCyan()');
        await until(async () => { const p = await probe(); return p.pixel && p.pixel[0] < 80 && p.pixel[1] > 130 && p.pixel[2] > 130; });
        await sleep(250);
        const nativeStart = await manager.getDiagnostics(state.videoSessionId);
        const nativeStartAt = performance.now();
        const pageStart = await probe();
        const pageStartAt = performance.now();
        await sleep(1500);
        const nativeEnd = await manager.getDiagnostics(state.videoSessionId);
        const nativeMs = performance.now() - nativeStartAt;
        const pageEnd = await probe();
        const pageMs = performance.now() - pageStartAt;
        assert(pageEnd.input.submittedFrames > pageStart.input.submittedFrames + 10
          && pageEnd.presented > pageStart.presented + 10, 'qualityStoppedFrames');
        assert(pageEnd.errors.length === 0 && pageEnd.input.writeFailures === 0, 'qualityPageFailure');
        const hostFps = Math.round((nativeEnd.bridgeFrames - nativeStart.bridgeFrames) * 1000 / nativeMs);
        const sourceScale = Math.min(1, width / (display.bounds.width * display.scaleFactor), height / (display.bounds.height * display.scaleFactor));
        const expectedWidth = Math.floor(display.bounds.width * display.scaleFactor * sourceScale);
        const expectedHeight = Math.floor(display.bounds.height * display.scaleFactor * sourceScale);
        assert(Math.abs(pageEnd.width - expectedWidth) <= 1 && Math.abs(pageEnd.height - expectedHeight) <= 1, 'qualityContentSizeMismatch');
        qualityChanges.push({ targetFps: fps, cap: { width, height }, output: { width: pageEnd.width, height: pageEnd.height },
          hostFps, freshPixelsChecked: true, encoderMeasured: false,
          submittedFps: Math.round((pageEnd.input.submittedFrames - pageStart.input.submittedFrames) * 1000 / pageMs),
          presentedFps: Math.round((pageEnd.presented - pageStart.presented) * 1000 / pageMs) });
      }
    }
    if (mode === 'receiver-failure') {
      ipcMain.emit('media:native-video:receiver-error', { sender: window.webContents },
        { sessionId: state.videoSessionId, message: 'controlledReceiverFailure' });
    } else if (mode === 'helper-exit') state.child.kill();
    if (mode === 'receiver-failure' || mode === 'helper-exit') {
      await until(async () => (await probe()).errors.length > 0);
    }
    const stopStart = performance.now();
    const stopped = await renderer('stop()');
    await until(() => !manager.state?.videoSessionId && !production.nativeVideoSession);
    assert(stopped.readyState === 'ended', 'generatedTrackNotEnded');
    if (mode === 'helper-exit') {
      assert(state.closed && (state.child.exitCode !== null || state.child.signalCode !== null)
        && production.helperProcessBridges.size === 0, 'helperExitNotConfirmed');
    } else if (mode === 'receiver-failure') {
      assert(state.closed || (manager.state === state && !state.videoSessionId), 'failedReceiverCaptureNotStopped');
    } else assert(manager.state === state && !state.closed, 'successfulStopDidNotRetainHost');
    assert(page.presented > 0 && page.width > 0 && page.height > 0, 'pageDidNotPresentContent');
    cases.push({ mode, engine: 'obs', pixelsChecked, qualityChanges,
      helperVersion: after.helperVersion,
      nativeWidth: state.resolution.width, nativeHeight: state.resolution.height,
      outputWidth: page.width, outputHeight: page.height,
      resources: resourceCheck ? resourceSummary(resourcesBefore, resourcesAfter) : undefined,
      firstFrameMs: started.firstFrameMs, framesSubmitted: page.input.submittedFrames,
      framesPresented: page.presented, hostFps: Math.round((after.bridgeFrames - before.bridgeFrames) * 1000 / nativeIntervalMs),
      nativeIntervalMs: Math.round(nativeIntervalMs),
      intervalMs: Math.round(intervalMs),
      submittedFps: Math.round((page.input.submittedFrames - pageBefore.input.submittedFrames) * 1000 / intervalMs),
      presentedFps: Math.round((page.presented - pageBefore.presented) * 1000 / intervalMs),
      slotDrops: after.bridgeDroppedFrames,
      stopMs: Math.round(performance.now() - stopStart),
      helperExitCode: state.child.exitCode, hostRetained: manager.state === state && !state.closed,
      handleCount: bridge.currentProcessHandleCount() });
    process.stdout.write(`${JSON.stringify({ phase: 'caseComplete', ...cases.at(-1) })}\n`);
    await sleep(200);
  }
  for (const mode of resourceCheck || qualityCheck ? ['success'] : ['success', 'success', 'receiver-failure', 'success', 'helper-exit', 'success']) await runCase(mode);
  assert(resourceCheck || qualityCheck ? failures.length === 0 : failures.length === 2 && failures[0].code === 'controlledReceiverFailure'
    && failures[1].code.startsWith('obsCaptureHostExited:'), 'unexpectedCaptureFailures');
  assert(cases.at(-1).handleCount <= cases[0].handleCount + 4, 'mainHandleCountKeptGrowing');
  assert(!diagnostics.some((message) => /Uncaught|Double destroy/.test(message)), 'unexpectedRuntimeDiagnostic');
  {
    assert(existsSync(resolve(app.getPath('userData'), 'obs-capture/32.2.2/win-capture')), 'pluginConfigDirectoryMissing');
    assert(!existsSync(resolve(prepared, 'obs-plugins/64bit/win-capture')), 'pluginCachePollutedRuntime');
  }
  await finish({ ok: true });
}).catch((error) => finish({ ok: false, error: String(error.message).slice(0, 220) }));
process.stdin.on('data', (chunk) => { if (String(chunk).includes('abort')) void finish({ ok: false, error: 'testAborted' }); });
process.on('uncaughtException', (error) => { void finish({ ok: false, error: String(error.message).slice(0, 220) }); });

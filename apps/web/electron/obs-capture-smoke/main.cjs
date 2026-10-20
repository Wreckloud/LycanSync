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

if (process.env.LYCANSYNC_RUN_OBS_CAPTURE_TEST !== '1') throw new Error('captureDeviceTestNotEnabled');

const projectRoot = resolve(__dirname, '../../../..');
const prepared = resolve(projectRoot, 'release/build-cache/obs-32.2.2/prepared');
const helperPath = resolve(prepared, 'bin/64bit/lycansync-obs-capture-host.exe');
const monitorName = process.argv.at(-1);
const resourceCheck = process.env.LYCANSYNC_CAPTURE_RESOURCE_CHECK === '1';
const qualityCheck = process.env.LYCANSYNC_CAPTURE_QUALITY_CHECK === '1';
const windowCheck = process.env.LYCANSYNC_CAPTURE_WINDOW_CHECK === '1';
const gameCheck = process.env.LYCANSYNC_CAPTURE_GAME_CHECK === '1';
const applicationCheck = process.env.LYCANSYNC_CAPTURE_APPLICATION_CHECK === '1';
if ([resourceCheck, qualityCheck, windowCheck, applicationCheck, gameCheck].filter(Boolean).length > 1) throw new Error('captureTestModesConflict');
const referenceRust = resourceCheck && process.env.LYCANSYNC_CAPTURE_REFERENCE === 'rust';
const rustPath = resolve(projectRoot, 'release/build-cache/media-helper-compare/release/lycansync-media.exe');
const cases = [];
const failures = [];
const diagnostics = [];
let window;
let production;
let manager;
let targetHelper;
let targetFixture;
let finishing = false;

async function readResources(state) {
  // 只读取本测试持有的子进程；工作集分开记录，不能当作整机物理内存。
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
    `$captureProcess = Get-Process -Id ${state.child.pid} -ErrorAction Stop; `
    + '[pscustomobject]@{cpuSeconds=$captureProcess.TotalProcessorTime.TotalSeconds; '
    + 'workingSetMiB=$captureProcess.WorkingSet64/1MB; privateMiB=$captureProcess.PrivateMemorySize64/1MB} | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 5000 });
  return { at: performance.now(), helper: JSON.parse(stdout), electron: app.getAppMetrics() };
}

function resourceSummary(before, after) {
  const seconds = (after.at - before.at) / 1000;
  assert(seconds > 0 && Number.isFinite(before.helper.cpuSeconds)
    && Number.isFinite(after.helper.cpuSeconds) && after.helper.cpuSeconds >= before.helper.cpuSeconds, 'invalidResourceInterval');
  const previous = new Map(before.electron.map((entry) => [entry.pid, entry.cpu.cumulativeCPUUsage]));
  let electronCpuSeconds = 0;
  for (const entry of after.electron) {
    const start = previous.get(entry.pid), end = entry.cpu.cumulativeCPUUsage;
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'resourceProcessChanged');
    electronCpuSeconds += end - start;
  }
  const electronWorkingSet = (sample) => Math.round(sample.electron.reduce((sum, entry) => sum + entry.memory.workingSetSize, 0) / 1024);
  return { intervalMs: Math.round(seconds * 1000), logicalProcessors: cpus().length,
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
    if (referenceRust) await manager.stopVideo(manager.state.videoSessionId);
    else await manager.stop(manager.state.videoSessionId);
  } }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  try { if (referenceRust) await manager?.shutdown(); }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  try { if (targetHelper) await targetHelper.shutdown(); }
  catch (error) { result.cleanupError = String(error.message).slice(0, 180); }
  if (gameCheck) production?.activityMonitor?.stop();
  if (targetFixture && targetFixture.exitCode === null && targetFixture.signalCode === null) {
    targetFixture.stdin.end('quit\n');
    try { await until(() => targetFixture.exitCode !== null || targetFixture.signalCode !== null, 5000); }
    catch { targetFixture.kill(); result.cleanupError = 'testWindowExitUnconfirmed'; }
  }
  result.helperClosed = !manager?.state;
  process.stdout.write(`${JSON.stringify({ type: 'obsCaptureSmokeResult', ...result, cases, failures, diagnostics })}\n`);
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
  production = { closing: false, process, console: { error: (...args) => diagnostics.push(args.map(String).join(' ').slice(0, 250)) },
    setTimeout, clearTimeout, randomUUID, sharedTexture, ipcMain, mainWindow: window,
    nativeMediaBridge: bridge, nativeVideoSession: undefined, lastStoppedNativeVideoSession: undefined,
    nativeScreenAudioSession: undefined, helperProcessBridges: new Map(),
    nativeMicrophoneSession: undefined, lastMicrophoneDroppedChunks: 0, lastScreenAudioDroppedChunks: 0,
    nativeVideoSourcesById: new Map([['monitor:1:0', { kind: 'monitor', title: monitorName }]]),
    loadNativeMediaBridge: () => bridge, mediaHelperPath: () => rustPath,
    mediaHelper: { startVideo: () => { throw new Error('unexpectedRustCapture'); } },
    trustedSender: (event) => event.sender === window.webContents,
    recordVideoFailure: (stage, error) => {
      const failure = { stage, code: String(error.message ?? error).slice(0, 160) };
      failures.push(failure);
      process.stdout.write(`${JSON.stringify({ phase: 'captureFailure', ...failure })}\n`);
    },
  };
  const main = readFileSync(resolve(__dirname, '../main.cjs'), 'utf8');
  // 运行生产入口本身，不复制另一套纹理交付和清理逻辑；不执行应用启动代码。
  runInNewContext([
    sourceRange(main, 'function releaseHelperProcessBridge(', 'function handleVideoCaptureEnded('),
    sourceRange(main, 'function handleVideoCaptureSuspended(', 'function finishNativeScreenAudioPipe('),
    sourceRange(main, 'function handleMediaHelperFailure(', 'function handleNativeSharedTextureFrame('),
    sourceRange(main, 'function handleNativeSharedTextureFrame(', 'function validMicrophoneSettings('),
    sourceRange(main, "ipcMain.handle('media:native-video:start',", "ipcMain.handle('media:remote-control:authorize',"),
    sourceRange(main, "ipcMain.on('media:native-video:receiver-error',", "ipcMain.handle('media:diagnostics',"),
    sourceRange(main, "ipcMain.handle('media:diagnostics',", "ipcMain.on('window:maximize',"),
  ].join('\n'), production);
  manager = referenceRust ? new MediaHelperManager({ executablePath: rustPath,
    onSharedTextureFrame: production.handleNativeSharedTextureFrame,
    onHelperClosed: production.releaseHelperProcessBridge,
    onHelperFailure: (_state, code) => failures.push({ stage: 'rustHelper', code }),
    onDiagnostic: (message) => { if (diagnostics.length < 30) diagnostics.push(message.slice(0, 250)); },
  }) : new ObsCaptureHostManager({ executablePath: helperPath,
    modulePath: resolve(prepared, 'obs-plugins/64bit/win-capture.dll'),
    dataPath: resolve(prepared, 'data/obs-plugins/win-capture'),
    configPath: resolve(app.getPath('userData'), 'obs-capture', '32.2.2'),
    onFrame: production.handleNativeSharedTextureFrame,
    onFailure: (state, error) => {
      const video = production.nativeVideoSession;
      if (video && video.sessionId === state.videoSessionId && !video.stopping) {
        production.recordVideoFailure('obsCaptureHost', error);
        production.notifyNativeVideoError(video, error.message === 'captureTargetClosed' ? error.message : 'obsCaptureHostFailed');
      }
    },
    onClosed: production.releaseHelperProcessBridge,
    onSuspended: production.handleVideoCaptureSuspended,
    onDiagnostic: (message) => { if (diagnostics.length < 30) diagnostics.push(message.slice(0, 250)); },
  });
  let sourceId = 'monitor:1:0';
  if (referenceRust) {
    production.mediaHelper = manager;
    production.obsCaptureHost = undefined;
    // 枚举只用于匹配已授权的主显示器，不输出或采集其他窗口。
    const snapshot = await manager.listVideoSources();
    const monitor = snapshot.sources.find((source) => source.kind === 'monitor' && source.title === monitorName);
    assert(monitor, 'primaryMonitorMissing');
    sourceId = monitor.sourceId;
  } else production.obsCaptureHost = manager;
  // 普通窗口验证不启动活动扫描；游戏模式会以本次自建程序的映射走真实分类命令。
  production.activityMonitor = { isCaptureGame: async () => false };
  await window.loadFile(resolve(projectRoot, 'release/build-cache/obs-32.2.2/smoke-page/renderer.html'));
  process.stdout.write('{"phase":"pageLoaded"}\n');
  window.showInactive();
  await until(() => window.webContents.executeJavaScript('Boolean(window.obsCaptureTest)'));
  const bounds = window.getContentBounds();
  const point = { x: Math.round((bounds.x + 48 - display.bounds.x) / display.bounds.width * 1920),
    y: Math.round((bounds.y + 48 - display.bounds.y) / display.bounds.height * 1080) };
  const probe = () => renderer(`probe(${point.x},${point.y})`);
  if (applicationCheck) {
    targetHelper = new MediaHelperManager({ executablePath: rustPath,
      onHelperFailure: production.handleMediaHelperFailure,
      onHelperClosed: production.releaseHelperProcessBridge,
      onDiagnostic: (message) => { if (diagnostics.length < 30) diagnostics.push(String(message).slice(0, 250)); },
    });
    production.mediaHelper = targetHelper;
    const snapshot = await targetHelper.listVideoSources();
    const existingWindowId = process.env.LYCANSYNC_CAPTURE_APPLICATION_WINDOW_ID;
    if (existingWindowId && !/^[1-9]\d{0,19}$/.test(existingWindowId)) throw new Error('invalidApplicationTestWindow');
    // 浏览器只匹配专用测试标题；已有应用只接受本次明确给出的窗口句柄，不打印其标题。
    const sources = snapshot.sources.filter((source) => source.kind === 'window'
      && (existingWindowId ? source.windowId === existingWindowId : source.title.startsWith('LycanSync OBS Browser Fixture')));
    assert(sources.length === (existingWindowId ? 1 : 2), 'applicationTestSourcesMissing');
    production.nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
    for (const source of sources) {
      const started = await renderer(`start(${JSON.stringify(source.sourceId)})`);
      const state = manager.state;
      const palette = new Set();
      const before = await renderer('probe(960,540)');
      const beforeAt = performance.now();
      for (let index = 0; index < 10; index++) {
        await sleep(400);
        const sample = await renderer('probe(960,540)');
        assert(sample.readyState === 'live' && sample.width === 1920 && sample.height === 1080
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
      const sourceDiagnostics = await renderer('diagnostics()');
      assert(sourceDiagnostics.sourceKind === 'window' && sourceDiagnostics.captureBackend === 'obsLibobs', 'applicationDiagnosticsMismatch');
      const stopped = await renderer('stop()');
      await until(() => !manager.state && !production.nativeVideoSession && !targetHelper.videoCapture);
      assert(stopped.readyState === 'ended' && state.child.exitCode === 0, 'applicationStopUnconfirmed');
      cases.push({ mode: browserKind ?? 'existing-application', firstFrameMs: started.firstFrameMs,
        submittedFps: Math.round((after.input.submittedFrames - before.input.submittedFrames) * 1000 / intervalMs),
        presentedFps: Math.round((after.presented - before.presented) * 1000 / intervalMs),
        freshPixelsChecked: Boolean(browserKind), helperExitCode: state.child.exitCode });
    }
    if (!existingWindowId) assert(new Set(cases.map((entry) => entry.mode)).size === 2, 'browserWindowsNotDistinct');
    assert(failures.length === 0 && !diagnostics.some((entry) => /Uncaught|Double destroy/.test(entry)), 'applicationCaptureFailure');
    await finish({ ok: true });
    return;
  }
  if (windowCheck || gameCheck) {
    const fixturePath = resolve(projectRoot, 'release/build-cache/obs-32.2.2/cmake-build/test-tools',
      gameCheck ? 'lycansync-obs-test-d3d.exe' : 'lycansync-obs-test-windows.exe');
    assert(existsSync(fixturePath), 'buildWithBuildTestWindowsFirst');
    const events = [];
    let buffer = '';
    targetFixture = spawn(fixturePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const ready = await until(() => events.find((event) => event.event === 'ready'));
    targetHelper = new MediaHelperManager({ executablePath: rustPath,
      onHelperFailure: production.handleMediaHelperFailure,
      onHelperClosed: production.releaseHelperProcessBridge,
      onDiagnostic: (message) => diagnostics.push(String(message).slice(0, 250)),
    });
    production.mediaHelper = targetHelper;
    const snapshot = await targetHelper.listVideoSources();
    const selected = snapshot.sources.find((source) => source.windowId === ready.windowId);
    const other = snapshot.sources.find((source) => source.windowId === ready.otherWindowId);
    assert(selected && other && selected.title === other.title && selected.sourceId !== other.sourceId, 'sameTitleTestWindowsMissing');
    production.nativeVideoSourcesById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
    const statuses = [];
    manager.onSuspended = (state, event) => { statuses.push(event.suspended); production.handleVideoCaptureSuspended(state, event); };
    if (gameCheck) {
      const { createActivityHelper } = require('../activity-helper.cjs');
      production.activityMonitor = createActivityHelper({ enabled: true,
        executablePath: () => resolve(projectRoot, 'native/activity-helper/target/release/lycansync-activity.exe'),
        onActivity: () => {} });
      await production.activityMonitor.configure([{ executable: fixturePath, name: 'Controlled D3D fixture' }]);
    }
    const started = await renderer(`start(${JSON.stringify(selected.sourceId)})`);
    const state = manager.state;
    let cyan = false;
    const selectedColorMatches = async () => { const sample = await renderer('probe(960,540)');
      return sample.pixel && sample.pixel[0] < 100 && sample.pixel[1] > 120
        && (cyan ? sample.pixel[2] > 160 : sample.pixel[2] < 120); };
    await until(selectedColorMatches);
    const reserved = await targetHelper.getDiagnostics();
    assert(reserved.state === 'running' && reserved.captureBackend === null && reserved.framesReceived === null, 'identityHelperStartedCapture');
    const command = async (text, event) => {
      const before = events.length;
      targetFixture.stdin.write(`${text}\n`);
      await until(() => events.slice(before).some((entry) => entry.event === event));
    };
    const frameRateChanges = [];
    const identityState = targetHelper.videoCapture;
    // 检查四档对应的原生节奏及回到标准；每次切换后变色，不能用旧纹理冒充恢复。
    for (const fps of [120, 30, 60, 30, 60]) {
      const configured = await renderer(`configureFrameRate(${fps})`);
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
      frameRateChanges.push({ targetFps: fps, hostFps, freshPixelsChecked: true });
    }
    await command('rename', 'renamed');
    const refreshed = await targetHelper.listVideoSources();
    assert(refreshed.sources.some((source) => source.windowId === ready.windowId && source.sourceId === selected.sourceId), 'renamedWindowIdentityChanged');
    await until(selectedColorMatches);
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
    await command('restore', 'restored');
    await until(() => statuses.at(-1) === false);
    await until(selectedColorMatches);
    const restoredDiagnostics = await renderer('diagnostics()');
    assert(restoredDiagnostics.sourceKind === 'window' && restoredDiagnostics.captureSuspended === false,
      'windowRestoredDiagnosticsMismatch');
    await renderer('stop()');
    await until(() => !manager.state && !production.nativeVideoSession && !targetHelper.videoCapture);
    assert(state.child.exitCode === 0, 'windowNormalStopWasForced');
    const reopenedSources = await targetHelper.listVideoSources();
    production.nativeVideoSourcesById = new Map(reopenedSources.sources.map((source) => [source.sourceId, source]));
    await renderer(`start(${JSON.stringify(selected.sourceId)})`);
    await until(selectedColorMatches);
    await command('close', 'targetClosed');
    await until(() => !manager.state && !production.nativeVideoSession && !targetHelper.videoCapture);
    const ended = await renderer('probe(960,540)');
    assert(ended.readyState === 'ended' && ended.errors.includes('captureTargetClosed'), 'windowClosureNotEnded');
    const remaining = await targetHelper.listVideoSources();
    assert(remaining.sources.some((source) => source.windowId === ready.otherWindowId)
      && !remaining.sources.some((source) => source.windowId === ready.windowId), 'otherWindowWasTakenOver');
    assert(failures.length === 1 && failures[0].code === 'captureTargetClosed', 'unexpectedWindowFailure');
    cases.push({ mode: gameCheck ? 'controlled-d3d-game' : 'window', pixelsChecked: true, diagnosticsChecked: true, firstFrameMs: started.firstFrameMs, frameRateChanges,
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
    assert(referenceRust || state?.helperVersion === '32.2.2', 'actualObsVersionMissing');
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
      for (const fps of [30, 120, 60]) {
        process.stdout.write(`${JSON.stringify({ phase: 'qualityChanging', fps })}\n`);
        const configured = await renderer(`configureFrameRate(${fps})`);
        process.stdout.write(`${JSON.stringify({ phase: 'qualityConfigured', fps })}\n`);
        assert(configured.changed && configured.sameTrack && configured.readyState === 'live', 'qualityReplacedTrack');
        assert(manager.state === state && state.maxFps === fps, 'qualityReplacedCaptureSession');
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
        assert(hostFps >= fps * 0.75 && hostFps <= fps * 1.25, `qualityHostFrameRateMismatch:${fps}:${hostFps}`);
        qualityChanges.push({ targetFps: fps,
          hostFps,
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
    if (referenceRust) await manager.shutdown();
    await until(() => !manager.state && !production.nativeVideoSession && production.helperProcessBridges.size === 0);
    assert(stopped.readyState === 'ended', 'generatedTrackNotEnded');
    assert(state.closed && (state.child.exitCode !== null || state.child.signalCode !== null), 'helperExitNotConfirmed');
    assert(page.presented > 0 && (referenceRust || (page.width === 1920 && page.height === 1080)), 'pageDidNotPresent1080p');
    cases.push({ mode, engine: referenceRust ? 'rust' : 'obs', pixelsChecked, qualityChanges,
      helperVersion: after.helperVersion,
      nativeWidth: referenceRust ? after.frameWidth : 1920, nativeHeight: referenceRust ? after.frameHeight : 1080,
      outputWidth: page.width, outputHeight: page.height,
      resources: resourceCheck ? resourceSummary(resourcesBefore, resourcesAfter) : undefined,
      firstFrameMs: started.firstFrameMs, framesSubmitted: page.input.submittedFrames,
      framesPresented: page.presented, hostFps: referenceRust ? after.videoOutputFps
        : Math.round((after.bridgeFrames - before.bridgeFrames) * 1000 / nativeIntervalMs),
      nativeIntervalMs: Math.round(nativeIntervalMs),
      intervalMs: Math.round(intervalMs),
      submittedFps: Math.round((page.input.submittedFrames - pageBefore.input.submittedFrames) * 1000 / intervalMs),
      presentedFps: Math.round((page.presented - pageBefore.presented) * 1000 / intervalMs),
      slotDrops: referenceRust ? undefined : after.bridgeDroppedFrames,
      outputDrops: referenceRust ? after.videoOutputDroppedFrames : undefined,
      stopMs: Math.round(performance.now() - stopStart),
      helperExitCode: state.child.exitCode, handleCount: bridge.currentProcessHandleCount() });
    process.stdout.write(`${JSON.stringify({ phase: 'caseComplete', ...cases.at(-1) })}\n`);
    await sleep(200);
  }
  for (const mode of resourceCheck || qualityCheck ? ['success'] : ['success', 'success', 'receiver-failure', 'success', 'helper-exit', 'success']) await runCase(mode);
  assert(resourceCheck || qualityCheck ? failures.length === 0 : failures.length === 2 && failures[0].code === 'controlledReceiverFailure'
    && failures[1].code.startsWith('obsCaptureHostExited:'), 'unexpectedCaptureFailures');
  assert(cases.at(-1).handleCount <= cases[0].handleCount + 4, 'mainHandleCountKeptGrowing');
  assert(!diagnostics.some((message) => /Uncaught|Double destroy/.test(message)), 'unexpectedRuntimeDiagnostic');
  if (!referenceRust) {
    assert(existsSync(resolve(app.getPath('userData'), 'obs-capture/32.2.2/win-capture')), 'pluginConfigDirectoryMissing');
    assert(!existsSync(resolve(prepared, 'obs-plugins/64bit/win-capture')), 'pluginCachePollutedRuntime');
  }
  await finish({ ok: true });
}).catch((error) => finish({ ok: false, error: String(error.message).slice(0, 220) }));
process.stdin.on('data', (chunk) => { if (String(chunk).includes('abort')) void finish({ ok: false, error: 'testAborted' }); });
process.on('uncaughtException', (error) => { void finish({ ok: false, error: String(error.message).slice(0, 220) }); });

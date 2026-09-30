const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Module } = require('node:module');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

let window;
let helper;
let helperBridge;
let textureBridgeApi;
let helperPath;
let requestSequence = 0;
let pendingRequests = new Map();
let pendingSlots = new Map();
let sources = [];
let sessionId;
let latestHelperFrameAt;
let emittedFrames = 0;
let bridgeDroppedFrames = 0;
let inFlightPeak = 0;
let writerFrames = 0;
let writerDroppedFrames = 0;
let writerTimes = [];
let lastCaptureError;
let stopping = false;
let shutdownRequested = false;
let diagnosticsRequestPending = false;
let diagnosticsTimer;
let latestHelperDiagnostics = {};

function loadBridge(path) {
  const bridgeModule = new Module(path);
  process.dlopen(bridgeModule, path);
  return bridgeModule.exports;
}

function setStatus(state) {
  if (window && !window.isDestroyed()) window.webContents.send('wgc-smoke:status', diagnostics(state));
}

function diagnostics(state) {
  const now = performance.now();
  const recent = writerTimes.filter((time) => now - time <= 1_000);
  writerTimes = recent.slice(-64);
  const elapsed = recent.length > 1 ? (recent.at(-1) - recent[0]) / 1_000 : 0;
  return {
    state,
    emittedFrames,
    rendererWrittenFrames: writerFrames,
    bridgeOutputFps: recentHelperFps,
    rendererWrittenFps: elapsed > 0 ? (recent.length - 1) / elapsed : null,
    bridgeDroppedFrames,
    rendererDroppedFrames: writerDroppedFrames,
    inFlightTextures: pendingSlots.size,
    inFlightPeak,
    texturePoolCapacity: 3,
    framePoolRecreates: latestHelperDiagnostics.framePoolRecreates ?? null,
    sizeChanges: latestHelperDiagnostics.sizeChanges ?? null,
    stopDurationMs: latestHelperDiagnostics.stopDurationMs ?? null,
    helperFramesReceived: latestHelperDiagnostics.framesReceived ?? null,
    helperFramesProcessed: latestHelperDiagnostics.framesProcessed ?? null,
    rawCaptureFps: latestHelperDiagnostics.rawCaptureFps ?? null,
    lastFrameAgeMs: latestHelperFrameAt === undefined ? null : Math.round(now - latestHelperFrameAt),
    width: lastSize?.width ?? null,
    height: lastSize?.height ?? null,
    lastCaptureError,
  };
}

let recentHelperFps = null;
let lastSize;

function sendProtocol(command, fields = {}) {
  if (!helper || helper.exitCode !== null || helper.stdin.destroyed) {
    return Promise.reject(new Error('mediaHelperUnavailable'));
  }
  const requestId = `wgc-smoke-${++requestSequence}`;
  return new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      rejectResult(new Error('mediaHelperRequestTimeout'));
    }, 5_000);
    pendingRequests.set(requestId, { resolve: resolveResult, reject: rejectResult, timeout });
    const message = JSON.stringify({ protocolVersion: 1, requestId, command, ...fields });
    helper.stdin.write(`${message}\n`, (error) => {
      if (!error) return;
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);
      pending.reject(new Error('mediaHelperWriteFailed'));
    });
  });
}

function failHelper(errorCode) {
  lastCaptureError = errorCode;
  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(errorCode));
    pendingRequests.delete(requestId);
  }
  for (const imported of pendingSlots.values()) {
    try { imported.release(); } catch { /* Electron may already have released it. */ }
  }
  pendingSlots.clear();
  helperBridge?.release();
  helperBridge = undefined;
  setStatus('failed');
}

function sendFrameEvent(event) {
  if (!sessionId || event.sessionId !== sessionId) return;
  if (!/^[0-9a-f]{16}$/i.test(event.sourceHandleHex)
      || !Number.isInteger(event.slotIndex) || event.slotIndex < 0 || event.slotIndex >= 3) {
    lastCaptureError = 'invalidSharedTextureDescriptor';
    setStatus('failed');
    return;
  }
  if (pendingSlots.has(event.slotIndex)) {
    bridgeDroppedFrames += 1;
    return;
  }
  let owned;
  let imported;
  const releaseSlot = () => {
    pendingSlots.delete(event.slotIndex);
    if (helper && helper.exitCode === null && sessionId) {
      void sendProtocol('releaseSharedTextureSlot', {
        sessionId,
        slotIndex: event.slotIndex,
      }).catch(() => {});
    }
    setStatus(stopping ? 'stopping' : 'running');
  };
  try {
    owned = helperBridge.duplicateSharedTexture(event.sourceHandleHex);
    imported = owned.withImportHandle((ntHandle) => sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: event.pixelFormat,
        codedSize: event.codedSize,
        visibleRect: {
          x: 0,
          y: 0,
          width: event.contentSize.width,
          height: event.contentSize.height,
        },
        timestamp: event.timestampMicros,
        handle: { ntHandle },
      },
      allReferencesReleased: releaseSlot,
    }));
    owned.release();
  } catch {
    lastCaptureError = 'sharedTextureImportFailed';
    void sendProtocol('releaseSharedTextureSlot', {
      sessionId,
      slotIndex: event.slotIndex,
    }).catch(() => {});
    setStatus('failed');
    return;
  }
  pendingSlots.set(event.slotIndex, imported);
  inFlightPeak = Math.max(inFlightPeak, pendingSlots.size);
  latestHelperFrameAt = performance.now();
  emittedFrames = Math.max(emittedFrames, Number(event.bridgeFrames) || 0);
  bridgeDroppedFrames = Math.max(bridgeDroppedFrames, Number(event.bridgeDroppedFrames) || 0);
  recentHelperFps = Number.isFinite(event.bridgeOutputFps) ? event.bridgeOutputFps : null;
  lastSize = event.contentSize;
  setStatus('running');
  void sharedTexture.sendSharedTexture({
    frame: window.webContents.mainFrame,
    importedSharedTexture: imported,
  }, 'wgc-frame').then(() => {
    imported.release();
  }).catch(() => {
    lastCaptureError = 'sharedTextureTransferFailed';
    imported.release();
    setStatus('failed');
  });
}

function parseHelperLine(line) {
  if (Buffer.byteLength(line, 'utf8') > 64 * 1024) {
    failHelper('helperLineTooLong');
    return;
  }
  let event;
  try { event = JSON.parse(line); } catch {
    failHelper('helperMalformedOutput');
    return;
  }
  if (event.event === 'sharedTextureFrame') {
    try { sendFrameEvent(event); } catch {
      lastCaptureError = 'sharedTextureImportFailed';
      setStatus('failed');
    }
    return;
  }
  if (typeof event.requestId !== 'string') {
    failHelper('helperUnexpectedOutput');
    return;
  }
  const pending = pendingRequests.get(event.requestId);
  if (!pending) {
    failHelper('helperUnexpectedRequestId');
    return;
  }
  clearTimeout(pending.timeout);
  pendingRequests.delete(event.requestId);
  if (event.event === 'error') pending.reject(new Error(event.code));
  else pending.resolve(event);
}

async function startCapture(sourceId) {
  if (!sources.some((source) => source.sourceId === sourceId)) throw new Error('sourceSelectionRequired');
  if (sessionId) throw new Error('captureAlreadyRunning');
  sessionId = randomUUID();
  stopping = false;
  emittedFrames = 0;
  bridgeDroppedFrames = 0;
  writerFrames = 0;
  writerDroppedFrames = 0;
  writerTimes = [];
  inFlightPeak = 0;
  latestHelperFrameAt = undefined;
  lastCaptureError = undefined;
  try {
    await sendProtocol('startCaptureProbe', { sessionId, sourceId });
    setStatus('running');
  } catch (error) {
    sessionId = undefined;
    setStatus('idle');
    throw error;
  }
}

async function stopCapture() {
  if (!sessionId) return { changed: false };
  stopping = true;
  window.webContents.send('wgc-smoke:stop-renderer-track');
  setStatus('stopping');
  const deadline = Date.now() + 2_000;
  while (pendingSlots.size && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (pendingSlots.size) throw new Error('sharedTextureReferencesStillInFlight');
  const currentSession = sessionId;
  const result = await sendProtocol('stopCaptureProbe', { sessionId: currentSession });
  latestHelperDiagnostics = await sendProtocol('diagnostics');
  sessionId = undefined;
  stopping = false;
  setStatus('idle');
  return { changed: result.changed };
}

function trusted(event) {
  if (!window || event.sender !== window.webContents) throw new Error('untrustedMediaSmokeSender');
}

app.whenReady().then(async () => {
  try {
    helperPath = process.argv.at(-2);
    const bridgePath = process.argv.at(-1);
    if (!helperPath || !bridgePath || !sharedTexture?.importSharedTexture || !sharedTexture?.sendSharedTexture) {
      throw new Error('sharedTextureBridgeUnavailable');
    }
    textureBridgeApi = loadBridge(bridgePath);
    helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    helperBridge = textureBridgeApi.openSpawnedMediaHelper(helper.pid, helperPath);
    helper.stdout.on('error', () => failHelper('mediaHelperOutputFailed'));
    createInterface({ input: helper.stdout, crlfDelay: Infinity }).on('line', parseHelperLine);
    helper.once('error', () => failHelper('mediaHelperSpawnFailed'));
    helper.once('close', (code) => {
      if (code !== 0 || !shutdownRequested) failHelper('mediaHelperExited');
      helperBridge?.release();
      helperBridge = undefined;
    });

    window = new BrowserWindow({
      width: 1050,
      height: 760,
      webPreferences: {
        preload: resolve(__dirname, 'wgc-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(resolve(__dirname, 'wgc-renderer.html'));
    const list = await sendProtocol('listVideoSources');
    sources = list.sources;
    window.webContents.send('wgc-smoke:sources', sources.map(({ sourceId, kind, title, width, height }) => ({
      sourceId, kind, title, width, height,
    })));
    diagnosticsTimer = setInterval(() => {
      if (!sessionId || diagnosticsRequestPending || !helper || helper.exitCode !== null) return;
      diagnosticsRequestPending = true;
      void sendProtocol('diagnostics').then((snapshot) => {
        latestHelperDiagnostics = snapshot;
        if (typeof snapshot.lastCaptureError === 'string') lastCaptureError = snapshot.lastCaptureError;
        setStatus(stopping ? 'stopping' : 'running');
      }).catch(() => {}).finally(() => {
        diagnosticsRequestPending = false;
      });
    }, 1_000);
    setStatus('idle');
  } catch (error) {
    failHelper(String(error?.message || 'wgcSmokeStartupFailed').slice(0, 100));
    helper?.kill();
  }
});

ipcMain.handle('wgc-smoke:start', (event, sourceId) => {
  trusted(event);
  if (typeof sourceId !== 'string' || sourceId.length > 128) throw new Error('invalidSourceSelection');
  return startCapture(sourceId);
});
ipcMain.handle('wgc-smoke:stop', (event) => {
  trusted(event);
  return stopCapture();
});
ipcMain.on('wgc-smoke:frame-written', (event) => {
  trusted(event);
  writerFrames += 1;
  writerTimes.push(performance.now());
  if (writerTimes.length > 64) writerTimes.shift();
  setStatus(stopping ? 'stopping' : 'running');
});
ipcMain.on('wgc-smoke:frame-dropped', (event) => {
  trusted(event);
  writerDroppedFrames += 1;
  setStatus(stopping ? 'stopping' : 'running');
});

app.on('before-quit', (event) => {
  if (helper && helper.exitCode === null) {
    event.preventDefault();
    clearInterval(diagnosticsTimer);
    const child = helper;
    void stopCapture().catch(() => {}).finally(async () => {
      shutdownRequested = true;
      try { await sendProtocol('shutdown'); } catch { /* bounded child teardown follows */ }
      await Promise.race([
        new Promise((resolveClose) => child.once('close', resolveClose)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_500)),
      ]);
      if (child.exitCode === null) child.kill();
      await Promise.race([
        new Promise((resolveClose) => child.once('close', resolveClose)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_500)),
      ]);
      app.exit(child.exitCode === null ? 1 : 0);
    });
  }
});

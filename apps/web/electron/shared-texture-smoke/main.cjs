const { app, BrowserWindow, sharedTexture } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Module } = require('node:module');
const { resolve } = require('node:path');

let window;
let stopped = false;
let rendererSequence = 0;
let shutdownInProgress = false;
const activeChildren = new Set();

function finish(result) {
  if (stopped) return;
  stopped = true;
  process.stdout.write(`${JSON.stringify({ type: 'sharedTextureSmokeResult', ...result })}\n`);
  if (window && !window.isDestroyed()) window.destroy();
  app.quit();
}

function loadBridge(path) {
  const bridgeModule = new Module(path);
  process.dlopen(bridgeModule, path);
  return bridgeModule.exports;
}

function waitForChildClose(child, timeoutMs = 3_000) {
  return Promise.race([
    new Promise((resolveClose, rejectClose) => {
      child.once('close', (code, signal) => resolveClose({ code, signal }));
      child.once('error', rejectClose);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('helperCloseTimeout')), timeoutMs)),
  ]);
}

function readDescriptor(child, timeoutMs = 5_000) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return new Promise((resolveDescriptor, rejectDescriptor) => {
    const timeout = setTimeout(() => rejectDescriptor(new Error('helperDescriptorTimeout')), timeoutMs);
    lines.once('line', (line) => {
      clearTimeout(timeout);
      lines.close();
      try {
        const descriptor = JSON.parse(line);
        if (descriptor.event !== 'sharedTextureSmoke'
            || descriptor.pixelFormat !== 'bgra'
            || descriptor.codedSize?.width !== 2
            || descriptor.codedSize?.height !== 2
            || !/^[0-9a-f]{16}$/i.test(descriptor.sourceHandleHex)) {
          throw new Error('invalidSyntheticTextureDescriptor');
        }
        resolveDescriptor(descriptor);
      } catch (error) {
        rejectDescriptor(error);
      }
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      rejectDescriptor(new Error(`helperClosedBeforeDescriptor:${code}`));
    });
    child.once('error', () => {
      clearTimeout(timeout);
      rejectDescriptor(new Error('helperSpawnFailed'));
    });
  });
}

async function countUntilStable(bridge, baseline, tolerance = 2) {
  const deadline = Date.now() + 4_000;
  let count = bridge.currentProcessHandleCount();
  while (Date.now() < deadline && Math.abs(count - baseline) > tolerance) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
    count = bridge.currentProcessHandleCount();
  }
  if (Math.abs(count - baseline) > tolerance) {
    throw new Error(`mainHandleCountDidNotReturn:${baseline}:${count}`);
  }
  return count;
}

async function awaitElectronRelease(releasePromise) {
  return Promise.race([
    releasePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('electronReferenceReleaseTimeout')), 4_000)),
  ]);
}

async function settleHandleBaseline(bridge) {
  const deadline = Date.now() + 10_000;
  let previous;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const count = bridge.currentProcessHandleCount();
    stableSamples = count === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 5) return count;
    previous = count;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  throw new Error('mainHandleBaselineDidNotStabilize');
}

async function runCase({ bridge, helperPath, mode, baseline }) {
  const args = mode === 'crash-before-description' ? ['before-description'] : [];
  const child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  const childClose = waitForChildClose(child);
  let bridgeHelper;
  let owned;
  let imported;
  let allReferencesReleased;
  let helperResult;
  let expectedError;

  try {
    if (mode === 'crash-before-description') {
      try {
        await readDescriptor(child, 2_000);
      } catch {
        helperResult = await childClose;
        if (helperResult.code !== 86) throw new Error(`unexpectedHelperExit:${helperResult.code}`);
      }
    } else {
      try {
        bridge.openSpawnedMediaHelper(child.pid, process.execPath);
        throw new Error('wrongHelperImageWasAccepted');
      } catch (error) {
        if (error.message === 'wrongHelperImageWasAccepted') throw error;
        if (!error.message.includes('spawnedMediaHelperIdentityMismatch')) throw error;
      }
      try {
        bridge.openSpawnedMediaHelper(process.pid, helperPath);
        throw new Error('nonChildProcessWasAccepted');
      } catch (error) {
        if (error.message === 'nonChildProcessWasAccepted') throw error;
        if (!error.message.includes('spawnedMediaHelperIdentityMismatch')) throw error;
      }
      bridgeHelper = bridge.openSpawnedMediaHelper(child.pid, helperPath);
      const descriptor = await readDescriptor(child);
      if (mode === 'crash-after-description-before-copy') {
        child.stdin.end('crash\n');
        helperResult = await childClose;
        if (helperResult.code !== 87) throw new Error(`unexpectedHelperExit:${helperResult.code}`);
        try {
          bridgeHelper.duplicateSharedTexture(descriptor.sourceHandleHex);
          throw new Error('deadHelperHandleWasAccepted');
        } catch (error) {
          if (error.message === 'deadHelperHandleWasAccepted') throw error;
          expectedError = error.message;
          if (expectedError !== 'spawnedMediaHelperExited') throw error;
        }
      } else {
        owned = bridgeHelper.duplicateSharedTexture(descriptor.sourceHandleHex);
        if (mode === 'crash-after-copy-before-import') {
          child.stdin.end('crash\n');
          helperResult = await childClose;
          if (helperResult.code !== 87) throw new Error(`unexpectedHelperExit:${helperResult.code}`);
          owned.release();
          owned = undefined;
          expectedError = 'crashAfterCopyBeforeImport';
        } else {
          let resolveReferences;
          allReferencesReleased = new Promise((resolveRelease) => { resolveReferences = resolveRelease; });
          imported = owned.withImportHandle((ntHandle) => sharedTexture.importSharedTexture({
            textureInfo: {
              pixelFormat: descriptor.pixelFormat,
              codedSize: descriptor.codedSize,
              visibleRect: { x: 0, y: 0, width: 2, height: 2 },
              timestamp: rendererSequence + 1,
              handle: { ntHandle: Buffer.from(ntHandle) },
            },
            allReferencesReleased: () => resolveReferences(),
          }));
          rendererSequence += 1;
          owned.release();
          owned = undefined;

          if (mode === 'crash-after-import-before-release-callback') {
            child.stdin.end('crash\n');
            helperResult = await childClose;
            if (helperResult.code !== 87) throw new Error(`unexpectedHelperExit:${helperResult.code}`);
            imported.release();
            await awaitElectronRelease(allReferencesReleased);
          } else {
            const token = mode === 'receiver-reject' ? 'receiver-error' : 'smoke-frame';
            const rendererResultPromise = waitForRendererResult();
            const sendResult = await sharedTexture.sendSharedTexture({
              frame: window.webContents.mainFrame,
              importedSharedTexture: imported,
            }, token).then(() => 'sent', () => 'rejected');
            imported.release();
            await awaitElectronRelease(allReferencesReleased);
            const rendererResult = await rendererResultPromise;
            if (mode === 'receiver-reject') {
              if (!rendererResult.startsWith('receiverRejected')) {
                throw new Error(`receiverRejectionWasNotObserved:${sendResult}:${rendererResult}`);
              }
              expectedError = 'receiverRejected';
            } else {
              if (sendResult !== 'sent' || !rendererResult.startsWith('frameWritten:')) {
                throw new Error(`rendererFrameFailed:${sendResult}:${rendererResult}`);
              }
              child.stdin.end('release\n');
              helperResult = await childClose;
              if (helperResult.code !== 0) throw new Error(`unexpectedHelperExit:${helperResult.code}`);
            }
          }
        }
      }
    }
  } finally {
    if (imported) {
      try { imported.release(); } catch { /* release is best effort during test cleanup */ }
    }
    if (owned) owned.release();
    if (bridgeHelper) bridgeHelper.release();
    if (child.exitCode === null && !child.stdin.destroyed) child.kill();
    if (child.exitCode === null) {
      try { await childClose; } catch { /* the case already reports its primary failure */ }
    }
  }

  const handleCount = baseline === undefined
    ? bridge.currentProcessHandleCount()
    : await countUntilStable(bridge, baseline);
  return { mode, helperExitCode: helperResult?.code ?? child.exitCode, expectedError, handleCount };
}

let nextRendererResult;
function waitForRendererResult(timeoutMs = 5_000) {
  return new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => rejectResult(new Error('rendererResultTimeout')), timeoutMs);
    nextRendererResult = (result) => {
      clearTimeout(timeout);
      nextRendererResult = undefined;
      resolveResult(result);
    };
  });
}

app.whenReady().then(async () => {
  try {
    const helperPath = process.argv.at(-2);
    const bridgePath = process.argv.at(-1);
    if (!helperPath || !bridgePath || !sharedTexture?.importSharedTexture || !sharedTexture?.sendSharedTexture) {
      throw new Error('sharedTextureBridgeUnavailable');
    }
    const bridge = loadBridge(bridgePath);
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on('page-title-updated', (_event, title) => {
      if (!title.startsWith('bridge-smoke:result:')) return;
      nextRendererResult?.(title.slice('bridge-smoke:result:'.length));
    });
    await window.loadFile(resolve(__dirname, 'renderer.html'));

    await runCase({ bridge, helperPath, mode: 'success' });
    await runCase({ bridge, helperPath, mode: 'success' });
    const baseline = await settleHandleBaseline(bridge);
    const modes = [
      'success',
      'success',
      'receiver-reject',
      'receiver-reject',
      'crash-before-description',
      'crash-after-description-before-copy',
      'crash-after-copy-before-import',
      'crash-after-import-before-release-callback',
      'success',
    ];
    const cases = [];
    for (const mode of modes) {
      cases.push(await runCase({ bridge, helperPath, mode, baseline }));
    }
    finish({ ok: true, baselineHandleCount: baseline, cases });
  } catch (error) {
    finish({ ok: false, error: String(error?.message || error).slice(0, 160) });
  }
}).catch((error) => finish({ ok: false, error: `startup:${String(error?.message || error).slice(0, 120)}` }));

app.on('before-quit', () => {
  if (window && !window.isDestroyed()) window.destroy();
});

app.on('before-quit', (event) => {
  if (shutdownInProgress || activeChildren.size === 0) return;
  event.preventDefault();
  shutdownInProgress = true;
  const children = [...activeChildren];
  for (const child of children) child.kill();
  Promise.race([
    Promise.all(children.map((child) => new Promise((resolveClose) => child.once('close', resolveClose)))),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]).finally(() => {
    shutdownInProgress = false;
    app.quit();
  });
});

process.stdin.on('data', (data) => {
  if (data.toString('utf8').includes('abort')) finish({ ok: false, error: 'testAborted' });
});

process.on('uncaughtException', (error) => finish({ ok: false, error: `uncaught:${String(error.message).slice(0, 120)}` }));

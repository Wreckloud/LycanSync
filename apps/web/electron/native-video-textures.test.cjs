const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNativeVideoTextures } = require('./native-video-textures.cjs');

const sessionId = '12345678-1234-1234-1234-123456789abc';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('纹理交付、停止和迟到结果共用一次主进程引用释放', async (context) => {
  for (const mode of ['sent-then-stop', 'stop-then-sent', 'stop-then-rejected', 'rejected']) {
    await context.test(mode, async () => {
      let resolveSend, rejectSend, allReferencesReleased;
      const sent = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
      const failures = [], notifications = [], slots = [];
      let releases = 0;
      const renderer = { mainFrame: {}, isDestroyed: () => false, isLoadingMainFrame: () => false,
        getBackgroundThrottling: () => false };
      const video = { sessionId: 'texture-session', startedAt: performance.now(), renderer,
        imported: new Map(), pendingSlotReleases: new Set() };
      const state = { alive: true, closed: false, child: { pid: 1234 }, executablePath: 'C:\\host.exe',
        releaseSharedTextureSlot: async (...args) => slots.push(args) };
      const sandbox = {
        performance, writeMediaDiagnostic: async () => {},
        nativeVideoSession: video,
        mainWindow: { webContents: renderer, isDestroyed: () => false, isMinimized: () => false, isVisible: () => true },
        nativeMediaBridge: { openSpawnedMediaHelper: () => ({ duplicateSharedTexture: () => ({
          withImportHandle: (callback) => callback(Buffer.alloc(8)), release: () => {},
        }) }) },
        sharedTexture: {
          importSharedTexture: (options) => {
            allReferencesReleased = options.allReferencesReleased;
            return { release: () => { releases++; assert.equal(releases, 1, '不能重复释放主进程引用'); } };
          },
          sendSharedTexture: () => sent,
        },
        recordVideoFailure: (stage) => failures.push(stage),
        notifyNativeVideoError: (_video, code) => notifications.push(code),
      };
      const textures = createNativeVideoTextures({
        getVideo: () => sandbox.nativeVideoSession, getBridge: () => sandbox.nativeMediaBridge,
        getWindow: () => sandbox.mainWindow, sharedTexture: sandbox.sharedTexture,
        writeDiagnostic: sandbox.writeMediaDiagnostic, recordFailure: sandbox.recordVideoFailure,
        notifyFailure: sandbox.notifyNativeVideoError,
      });
      textures.receiveFrame(state, { sessionId: video.sessionId, slotIndex: 0,
        codedSize: { width: 1920, height: 1080 }, contentSize: { width: 1920, height: 1080 } });
      if (mode.startsWith('stop-')) {
        video.stopping = true;
        textures.releaseImports(video);
        assert.equal(releases, 0, '交付仍等待确认时，停止也不能提前释放主进程引用');
      }
      if (mode.includes('rejected')) rejectSend(new Error('controlledTransferFailure'));
      else resolveSend();
      await new Promise((resolve) => setImmediate(resolve));
      textures.releaseImports(video);
      assert.equal(releases, 1);
      assert.equal(video.imported.size, 1, '总释放回调之前必须继续登记未归还纹理，停止不能提前越过等待');
      assert.equal(notifications.length, mode === 'rejected' ? 1 : 0);
      assert.equal(failures.length, notifications.length);
      // 主进程引用释放不等于消费者已用完，只有 Electron 的总释放回调归还槽位。
      assert.equal(slots.length, 0);
      allReferencesReleased();
      allReferencesReleased();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(slots.length, 1);
      assert.equal(video.imported.size, 0);
      assert.equal(video.pendingSlotReleases.size, 0);
    });
  }
});

function textureTransferFixture() {
  const events = [], failures = [], releases = [];
  let complete, reject, referencesReleased;
  let mainReleases = 0;
  let openedHosts = 0, releasedHosts = 0;
  const renderer = { mainFrame: {}, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getBackgroundThrottling: () => false };
  const video = { sessionId, renderer, stopping: false, failureNotified: false, sourceFrameReceived: true,
    imported: new Map(), pendingSlotReleases: new Set() };
  const state = { alive: true, closed: false, child: { pid: 1234 }, executablePath: 'C:\\obs\\host.exe',
    releaseSharedTextureSlot: async (id, slot) => releases.push([id, slot]) };
  const imported = { release: () => { mainReleases++; referencesReleased(); } };
  const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, performance, nativeVideoSession: video,
    mainWindow: { isDestroyed: () => false, isMinimized: () => true, isVisible: () => false },
    nativeMediaBridge: { openSpawnedMediaHelper: (pid, path) => {
      assert.equal(pid, state.child.pid);
      assert.equal(path, state.executablePath);
      openedHosts++;
      return { release: () => { releasedHosts++; }, duplicateSharedTexture: () => ({
        withImportHandle: callback => callback('opaque'), release: () => {} }) };
    } },
    sharedTexture: {
      importSharedTexture: options => { referencesReleased = options.allReferencesReleased; return imported; },
      sendSharedTexture: options => {
        assert.equal(options.frame, renderer.mainFrame);
        return new Promise((resolve, fail) => { complete = resolve; reject = fail; });
      },
    },
    writeMediaDiagnostic: async event => events.push(event),
    recordVideoFailure: (stage, _error, _frame, details) => events.push({ stage, ...details }),
    notifyNativeVideoError: (_video, code) => { failures.push(code); video.stopping = true; },
  };
  const textures = createNativeVideoTextures({
    getVideo: () => sandbox.nativeVideoSession, getBridge: () => sandbox.nativeMediaBridge,
    getWindow: () => sandbox.mainWindow, sharedTexture: sandbox.sharedTexture,
    writeDiagnostic: sandbox.writeMediaDiagnostic, recordFailure: sandbox.recordVideoFailure,
    notifyFailure: sandbox.notifyNativeVideoError,
  });
  const frame = { sessionId, slotIndex: 0, pixelFormat: 'bgra',
    codedSize: { width: 1920, height: 1080 }, contentSize: { width: 1920, height: 1080 }, timestampMicros: 1 };
  textures.receiveFrame(state, frame);
  return { sandbox, textures, state, frame, video, imported, events, failures, releases,
    hostCounts: () => ({ opened: openedHosts, released: releasedHosts }),
    complete: () => complete(), reject: error => reject(error),
    mainReleases: () => mainReleases };
}

test('在途纹理不能提前释放或复用，交付完成后仅归还一次', async () => {
  const f = textureTransferFixture();
  f.video.imported.get(0).release();
  assert.equal(f.mainReleases(), 0);
  assert.equal(f.releases.length, 0);
  f.complete();
  await flush();
  assert.equal(f.mainReleases(), 1);
  assert.deepEqual(f.releases, [[sessionId, 0]]);
  assert.equal(f.video.imported.size, 0);
  assert.deepEqual(f.failures, []);
});

test('交付超时保留安全停止，导出页面状态，不重试同一纹理', async () => {
  const f = textureTransferFixture();
  f.reject(new Error('transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'));
  await flush();
  assert.deepEqual(f.failures, ['sharedTextureTransferTimedOut']);
  const event = f.events.find(entry => entry.stage === 'sendTexture');
  assert.equal(event.rendererAlive, true);
  assert.equal(event.windowMinimized, true);
  assert.equal(event.backgroundThrottling, false);
  assert.equal(event.code, 'sharedTextureTransferTimedOut');
  assert.equal(f.mainReleases(), 1);
});

test('主动停止或新会话开始后的迟到交付失败只回收旧引用，不误报新会话故障', async () => {
  for (const stopped of [true, false]) {
    const f = textureTransferFixture();
    if (stopped) f.video.stopping = true;
    else f.sandbox.nativeVideoSession = { sessionId: 'next' };
    f.reject(new Error('transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'));
    await flush();
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.events, []);
    assert.equal(f.mainReleases(), 1);
  }
});

test('每个宿主复用同一进程句柄，停止和关闭重复清理只释放一次', async () => {
  const f = textureTransferFixture();
  f.complete(); await flush();
  f.textures.receiveFrame(f.state, f.frame);
  f.complete(); await flush();
  assert.deepEqual(f.hostCounts(), { opened: 1, released: 0 });
  f.textures.releaseHost(f.state);
  f.textures.releaseHost(f.state);
  assert.deepEqual(f.hostCounts(), { opened: 1, released: 1 });
});

test('旧会话槽位回收的迟到失败不通知或停止新会话', async () => {
  const f = textureTransferFixture();
  let rejectRelease;
  f.state.releaseSharedTextureSlot = () => new Promise((_, reject) => { rejectRelease = reject; });
  f.complete(); await flush();
  assert.equal(f.video.pendingSlotReleases.size, 1);
  f.sandbox.nativeVideoSession = { sessionId: 'next' };
  const eventsBeforeFailure = f.events.length;
  rejectRelease(new Error('videoSessionMismatch'));
  await flush();
  assert.equal(f.video.pendingSlotReleases.size, 0);
  assert.equal(f.events.length, eventsBeforeFailure);
  assert.deepEqual(f.failures, []);
});

test('当前会话槽位释放失败明确停止并记录原因', async () => {
  const f = textureTransferFixture();
  f.state.releaseSharedTextureSlot = async () => { throw new Error('sharedTextureSlotReleaseFailed'); };
  f.complete(); await flush();
  assert.equal(f.video.pendingSlotReleases.size, 0);
  assert.ok(f.events.some(event => event.stage === 'releaseTextureSlot'));
  assert.deepEqual(f.failures, ['sharedTextureSlotReleaseFailed']);
});


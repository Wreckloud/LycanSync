const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { MediaHelperManager } = require('./media-helper.cjs');
const { matchNativeVideoSourceThumbnails, monitorDisplayId } = require('./native-video-thumbnails.cjs');

test('纹理交付、停止和迟到结果共用一次主进程引用释放', async (context) => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const cleanupStart = main.indexOf('function releaseNativeVideoImports(');
  const cleanupEnd = main.indexOf('function notifyNativeVideoError(', cleanupStart);
  const frameStart = main.indexOf('function handleNativeSharedTextureFrame(');
  const frameEnd = main.indexOf('async function startNativeVideo(', frameStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart && frameStart >= 0 && frameEnd > frameStart);
  for (const mode of ['sent-then-stop', 'stop-then-sent', 'stop-then-rejected', 'rejected']) {
    await context.test(mode, async () => {
      let resolveSend, rejectSend, allReferencesReleased;
      const sent = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
      const failures = [], notifications = [], slots = [];
      let releases = 0;
      const video = { sessionId: 'texture-session', imported: new Map(), pendingSlotReleases: new Set() };
      const state = { alive: true, closed: false, child: { pid: 1234 }, executablePath: 'C:\\host.exe',
        releaseSharedTextureSlot: async (...args) => slots.push(args) };
      const sandbox = {
        nativeVideoSession: video, helperProcessBridges: new Map(), mainWindow: { webContents: { mainFrame: {} } },
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
      runInNewContext(`${main.slice(cleanupStart, cleanupEnd)}\n${main.slice(frameStart, frameEnd)}`, sandbox);
      sandbox.handleNativeSharedTextureFrame(state, { sessionId: video.sessionId, slotIndex: 0,
        codedSize: { width: 1920, height: 1080 }, contentSize: { width: 1920, height: 1080 } });
      if (mode.startsWith('stop-')) {
        sandbox.releaseNativeVideoImports(video);
        assert.equal(releases, 0, '交付仍等待确认时，停止也不能提前释放主进程引用');
      }
      if (mode.includes('rejected')) rejectSend(new Error('controlledTransferFailure'));
      else resolveSend();
      await new Promise((resolve) => setImmediate(resolve));
      sandbox.releaseNativeVideoImports(video);
      assert.equal(releases, 1);
      assert.equal(notifications.length, mode.includes('rejected') ? 1 : 0);
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

const capabilities = {
  videoSourceDiscovery: { available: true, reason: 'windowsGraphicsCapture' },
  microphoneCapture: { available: true, reason: 'windowsWasapiSharedModeSonora' },
  systemAudioCapture: { available: false, reason: 'notImplemented' },
  processAudioCapture: { available: false, reason: 'notImplemented' },
};

class FakeHelper extends EventEmitter {
  constructor(mode = {}) {
    super();
    this.mode = mode;
    this.commands = [];
    this.killCount = 0;
    this.closed = false;
    this.capabilitiesCount = 0;
    this.sourceRevision = 0;
    this.videoState = 'idle';
    this.videoSessionId = null;
    this.microphoneState = 'idle';
    this.microphoneSessionId = null;
    this.requests = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.mode.writeFailure) {
          callback(new Error('fake write failure'));
          return;
        }
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const command = JSON.parse(line);
          this.requests.push(command);
          this.handleCommand(command);
        }
        callback();
      },
      final: (callback) => {
        if (!this.mode.shutdownHang) this.exit(0);
        callback();
      },
    });
  }

  handleCommand(command) {
    this.commands.push(command.command);
    if (command.command === 'hello') {
      if (this.mode.helloTimeout) return;
      const response = { event: 'hello', protocolVersion: 1, requestId: command.requestId, helperVersion: 'test' };
      if (this.mode.wrongVersion) response.protocolVersion = 2;
      if (this.mode.wrongRequestId) response.requestId = 'unexpected';
      this.writeResponse(response);
      return;
    }
    if (command.command === 'capabilities') {
      this.capabilitiesCount += 1;
      if (this.mode.capabilitiesTimeout
          || (this.mode.capabilitiesHangAfterFirst && this.capabilitiesCount > 1)) return;
      if (this.mode.invalidJson) { this.stdout.write('not-json\n'); return; }
      if (this.mode.invalidUtf8) { this.stdout.write(Buffer.from([0xc3, 0x28, 0x0a])); return; }
      if (this.mode.outputTooLong) { this.stdout.write(`${'x'.repeat(64 * 1024 + 1)}\n`); return; }
      if (this.mode.capabilitiesExit) {
        setImmediate(() => this.exit(17));
        return;
      }
      const response = {
        event: 'capabilities', protocolVersion: 1, requestId: command.requestId, state: 'idle',
        windowsOnly: true, ...capabilities, ...this.mode.capabilityOverrides,
      };
      if (this.mode.wrongCapabilitiesRequestId) response.requestId = 'unexpected';
      this.writeResponse(response);
      return;
    }
    if (command.command === 'listVideoSources') {
      if (this.mode.holdVideoSources) return;
      if (this.mode.listVideoSourcesFailure) {
        this.writeResponse({ event: 'error', protocolVersion: 1, requestId: command.requestId,
          code: 'sourceDiscoveryFailed', message: 'source discovery failed', recoverable: true, state: 'idle' });
        return;
      }
      this.sourceRevision += 1;
      this.writeResponse({
        event: 'videoSources', protocolVersion: 1, requestId: command.requestId,
        revision: this.sourceRevision,
        sources: [{ sourceId: `monitor:${this.sourceRevision}:0`, kind: 'monitor', title: 'DISPLAY1',
          width: 1920, height: 1080, primary: true, monitorOrigin: { x: 0, y: 0 } },
        ...(this.mode.windowSources ? [{ sourceId: `window:${this.sourceRevision}:0`, kind: 'window',
          title: 'Test window', width: 640, height: 480, primary: false, windowId: '123456' }] : [])],
      });
      return;
    }
    if (command.command === 'reserveVideo') {
      if (this.mode.reserveVideoTimeout) return;
      this.videoState = 'running';
      this.videoSessionId = command.sessionId;
      this.writeResponse({ event: 'videoReserved', protocolVersion: 1, requestId: command.requestId,
        sessionId: command.sessionId, sourceId: command.sourceId,
        target: this.mode.invalidVideoTarget ?? (command.sourceId.startsWith('monitor:')
          ? { kind: 'monitor', monitorName: '\\\\.\\DISPLAY1' }
          : { kind: 'window', windowId: '123456', propertyName: 'LycanSync.MediaHelper.Window.1.2.3',
            propertyValue: '987654', executable: 'C:\\Games\\game.exe' }) });
      return;
    }
    if (command.command === 'startMicrophoneCapture') {
      if (this.mode.holdMicrophoneStart) {
        this.pendingMicrophoneStart = command;
        return;
      }
      const acknowledge = () => {
        if (this.closed) return;
        this.microphoneState = 'running';
        this.microphoneSessionId = command.sessionId;
        this.writeResponse({ event: 'microphoneCaptureStarted', protocolVersion: 1,
          requestId: command.requestId, sessionId: command.sessionId, state: 'running',
          sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
      };
      if (this.mode.microphoneStartDelayMs) setTimeout(acknowledge, this.mode.microphoneStartDelayMs);
      else acknowledge();
      return;
    }
    if (command.command === 'configureMicrophoneCapture' || command.command === 'stopMicrophoneCapture') {
      if (command.command === 'stopMicrophoneCapture') {
        this.microphoneState = 'idle';
        this.microphoneSessionId = null;
      }
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (['setRemoteControl', 'remoteInput', 'clearRemoteControl'].includes(command.command)) {
      if (command.command === 'setRemoteControl' && this.mode.deferRemoteControl) return;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'running', changed: true });
      return;
    }
    if (command.command === 'stopVideo') {
      if (this.mode.videoStopTimeout) return;
      this.videoState = 'idle';
      this.videoSessionId = null;
      this.writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: command.command, state: 'idle', changed: true });
      return;
    }
    if (command.command === 'diagnostics') {
      const diagnostics = {
        event: 'diagnostics', protocolVersion: 1, requestId: command.requestId,
        helperVersion: '0.1.0', captureBackend: null,
        state: this.videoState, sessionId: this.videoSessionId,
        available: true, sourceKind: null,
        microphoneCaptureDroppedChunks: 0,
        frameWidth: null,
        frameHeight: null,
        framesReceived: null,
        framesProcessed: null,
        screenShareAudio: { state: 'idle', sessionId: null,
          sourceKind: null,
          sampleRate: null,
          channels: null,
          packetsReceived: null,
          framesReceived: null,
          silentPackets: 0, droppedAudioChunks: 0, lastError: null },
      };
      if (this.mode.omitMicrophoneCaptureDroppedChunks) delete diagnostics.microphoneCaptureDroppedChunks;
      if (this.mode.captureSuspended !== undefined) diagnostics.captureSuspended = this.mode.captureSuspended;
      this.writeResponse({ ...diagnostics, ...this.mode.diagnosticsOverrides });
      return;
    }
    if (command.command === 'shutdown' && !this.mode.shutdownHang) {
      this.writeResponse({
        event: 'acknowledged', protocolVersion: 1, requestId: command.requestId,
        command: 'shutdown', state: 'idle', changed: false,
      });
    }
  }

  writeResponse(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    this.killCount += 1;
    if (this.mode.killNoClose) return true;
    setImmediate(() => this.exit(1));
    return true;
  }

  exit(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', code, null);
    this.stdout.end();
    this.emit('close', code, null);
  }
}

function createManager(mode = {}, options = {}) {
  const children = [];
  const spawnOptions = [];
  const manager = new MediaHelperManager({
    executablePath: 'fake-media-helper.exe',
    platform: 'win32',
    spawnProcess: (_executable, _args, options) => {
      spawnOptions.push(options);
      const child = new FakeHelper(mode);
      children.push(child);
      return child;
    },
    createRequestId: (() => { let next = 0; return () => `request-${++next}`; })(),
    handshakeTimeoutMs: 40,
    requestTimeoutMs: 80,
    audioStartTimeoutMs: 80,
    shutdownTimeoutMs: 40,
    killTimeoutMs: 40,
    idleTimeoutMs: 1000,
    retryDelayMs: 20,
    ...options,
  });
  return { manager, children, spawnOptions };
}

test('OBS 窗口预留复用视频会话并阻止空闲退出，不启动 Rust 画面采集', async () => {
  const { manager, children } = createManager({ windowSources: true }, { idleTimeoutMs: 20 });
  try {
    const snapshot = await manager.listVideoSources();
    const sourceId = snapshot.sources.find((source) => source.kind === 'window').sourceId;
    const target = await manager.reserveVideo('obs-window-session', sourceId);
    assert.equal(target.kind, 'window');
    assert.equal(target.windowId, '123456');
    assert.equal(target.executable, 'C:\\Games\\game.exe');
    assert.equal(manager.videoCapture.starting, false);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(children[0].closed, false);
    assert.ok(!children[0].commands.includes('startVideo'));
    await assert.rejects(manager.reserveVideo('other', sourceId), /AlreadyRunning/);
    await assert.rejects(manager.stopVideo('old-session'), /Mismatch/);
    assert.equal((await manager.stopVideo('obs-window-session')).changed, true);
    assert.equal((await manager.stopVideo('obs-window-session')).changed, false);
    assert.equal(manager.videoCapture, undefined);
  } finally { await manager.shutdown(); }
});

test('OBS 整屏预留不启动视频 worker，远控绑定该会话，窗口预留不能获得整屏授权', async () => {
  const { manager, children } = createManager({ windowSources: true });
  try {
    const snapshot = await manager.listVideoSources();
    const monitorId = snapshot.sources.find((entry) => entry.kind === 'monitor').sourceId;
    assert.deepEqual(await manager.reserveVideo('obs-monitor', monitorId), { kind: 'monitor', monitorName: '\\\\.\\DISPLAY1' });
    await manager.setRemoteControl('obs-monitor', 'control', 'friend');
    await manager.sendRemoteInput('obs-monitor', 'control', 'friend', 1, { kind: 'keyDown', key: 'letterA' });
    await assert.rejects(manager.sendRemoteInput('old', 'control', 'friend', 2, { kind: 'keyUp', key: 'letterA' }), /InvalidSession/);
    assert.equal(children[0].commands.includes('startVideo'), false);
    await manager.clearRemoteControl('obs-monitor', 'control');
    await manager.stopVideo('obs-monitor');
    const windowId = snapshot.sources.find((entry) => entry.kind === 'window').sourceId;
    await manager.reserveVideo('obs-window', windowId);
    await assert.rejects(manager.setRemoteControl('obs-window', 'control', 'friend'), /SourceUnavailable/);
    await manager.stopVideo('obs-window');
  } finally { await manager.shutdown(); }
});

test('整屏预留拒绝错类型及非法设备名，不接受旧的无类型响应', async () => {
  for (const target of [{ kind: 'window' }, { monitorName: '\\\\.\\DISPLAY1' },
    { kind: 'monitor', monitorName: 'DISPLAY25' }, { kind: 'monitor', monitorName: '' }]) {
    const { manager } = createManager({ invalidVideoTarget: target });
    try {
      const snapshot = await manager.listVideoSources();
      await assert.rejects(manager.reserveVideo('obs-monitor', snapshot.sources[0].sourceId), /InvalidVideoTarget/);
      assert.equal(manager.videoCapture, undefined);
    } finally { await manager.shutdown(); }
  }
});

test('停止 Promise 未完成已禁止输入和新授权，迟到授权响应不能恢复权限', async () => {
  const { manager, children } = createManager();
  try {
    const snapshot = await manager.listVideoSources();
    await manager.reserveVideo('obs-monitor', snapshot.sources[0].sourceId);
    await manager.setRemoteControl('obs-monitor', 'control', 'friend');
    children[0].mode.videoStopTimeout = true;
    const stopping = manager.stopVideo('obs-monitor');
    await assert.rejects(manager.sendRemoteInput('obs-monitor', 'control', 'friend', 1, { kind: 'keyDown', key: 'letterA' }), /InvalidSession/);
    await assert.rejects(manager.setRemoteControl('obs-monitor', 'other', 'friend'), /SourceUnavailable/);
    const stopRequest = children[0].requests.at(-1);
    children[0].writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: stopRequest.requestId,
      command: 'stopVideo', state: 'idle', changed: true });
    await stopping;
    children[0].mode.videoStopTimeout = false;
    await manager.reserveVideo('next-monitor', snapshot.sources[0].sourceId);
    children[0].mode.deferRemoteControl = true;
    const granting = assert.rejects(manager.setRemoteControl('next-monitor', 'next-control', 'friend'), /InvalidRemoteControlStart/);
    const grantRequest = children[0].requests.at(-1);
    await manager.stopVideo('next-monitor');
    children[0].writeResponse({ event: 'acknowledged', protocolVersion: 1, requestId: grantRequest.requestId,
      command: 'setRemoteControl', state: 'running', changed: true });
    await granting;
    assert.equal(manager.videoCapture, undefined);
  } finally { await manager.shutdown(); }
});

test('窗口预留只接受当前快照，坏身份响应明确失败并关闭失去同步的 helper', async () => {
  const { manager, children } = createManager({ windowSources: true,
    invalidVideoTarget: { windowId: '123', propertyName: 'untrusted', propertyValue: '4' } });
  try {
    await assert.rejects(manager.reserveVideo('obs-session', 'window:1:0'), /videoSourceExpired/);
    assert.equal(children.length, 0);
    await manager.listVideoSources();
    await assert.rejects(manager.reserveVideo('obs-session', 'window:9:0'), /videoSourceExpired/);
    assert.equal(children[0].commands.filter((command) => command === 'reserveVideo').length, 0);
    await assert.rejects(manager.reserveVideo('obs-session', 'window:1:0'), /InvalidVideoTarget/);
    assert.equal(manager.videoCapture, undefined);
    await waitUntil(() => children[0].closed);
    assert.equal(children[0].closed, true);
  } finally { await manager.shutdown(); }
});

test('窗口程序路径仅接受完整本机 exe 身份，缺失或非法响应不继续分类', async () => {
  for (const executable of [undefined, 'relative.exe', 'C:\\Apps\\not-an-exe.txt', 'C:\\Apps\\bad\n.exe']) {
    const { manager, children } = createManager({ windowSources: true,
      invalidVideoTarget: { kind: 'window', windowId: '123', propertyName: 'LycanSync.MediaHelper.Window.1.2.3',
        propertyValue: '456', executable } });
    try {
      await manager.listVideoSources();
      await assert.rejects(manager.reserveVideo('obs-session', 'window:1:0'), /InvalidVideoTarget/);
      assert.equal(manager.videoCapture, undefined);
      await waitUntil(() => children[0].closed);
    } finally { await manager.shutdown(); }
  }
});

test('窗口身份预留中停止遇到请求超时，明确失败并回收 helper，不启动采集', async () => {
  const { manager, children } = createManager({ windowSources: true, reserveVideoTimeout: true });
  try {
    await manager.listVideoSources();
    const reservation = assert.rejects(manager.reserveVideo('obs-session', 'window:1:0'), /Timeout/);
    const stopped = assert.rejects(manager.stopVideo('obs-session'), /Timeout/);
    await Promise.all([reservation, stopped]);
    await waitUntil(() => children[0].closed);
    assert.equal(manager.videoCapture, undefined);
    assert.ok(!children[0].commands.some((command) => command === 'startVideo'));
  } finally { await manager.shutdown(); }
});

test('窗口预览按句柄匹配，同标题窗口仍各自显示正确画面', () => {
  const videoSources = [
    { sourceId: 'window:4:0', kind: 'window', title: 'Notepad', windowId: '99' },
    { sourceId: 'window:4:1', kind: 'window', title: 'Duplicate', windowId: '100' },
    { sourceId: 'window:4:2', kind: 'window', title: 'Duplicate', windowId: '101' },
    { sourceId: 'monitor:4:0', kind: 'monitor', title: '\\\\.\\DISPLAY1', displayId: '123' },
  ];
  const desktopSources = [
    { id: 'window:99:0', name: 'Notepad', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,notepad' } },
    { id: 'window:100:0', name: 'Duplicate', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,first' } },
    { id: 'window:101:0', name: 'Duplicate', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,second' } },
    { id: 'screen:0:secret', name: 'Screen 1', type: 'screen', displayId: '123', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,display' } },
    { id: 'screen:1:secret', name: 'Notepad', type: 'screen', thumbnail: { isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,wrong-kind' } },
  ];

  assert.deepEqual(matchNativeVideoSourceThumbnails(videoSources, desktopSources), [
    { sourceId: 'window:4:0', thumbnail: 'data:image/png;base64,notepad' },
    { sourceId: 'window:4:1', thumbnail: 'data:image/png;base64,first' },
    { sourceId: 'window:4:2', thumbnail: 'data:image/png;base64,second' },
    { sourceId: 'monitor:4:0', thumbnail: 'data:image/png;base64,display' },
  ]);
});

test('native chooser skips empty and over-budget preview images', () => {
  const sources = [
    { sourceId: 'window:1:0', kind: 'window', title: 'Empty', windowId: '1' },
    { sourceId: 'window:1:1', kind: 'window', title: 'Large', windowId: '2' },
  ];
  const desktopSources = [
    { id: 'window:1:0', name: 'Empty', type: 'window', thumbnail: { isEmpty: () => true, toDataURL: () => '' } },
    { id: 'window:2:0', name: 'Large', type: 'window', thumbnail: { isEmpty: () => false,
      toDataURL: () => `data:image/png;base64,${'x'.repeat(80 * 1024)}` } },
  ];
  assert.deepEqual(matchNativeVideoSourceThumbnails(sources, desktopSources), []);
});

test('缺失或重复窗口句柄不退回标题猜测，也不使用其他窗口的缩略图', () => {
  const source = { sourceId: 'window:1:0', kind: 'window', title: 'Same', windowId: '10' };
  const desktop = { id: 'window:11:0', type: 'window', name: 'Same', thumbnail: {
    isEmpty: () => false, toDataURL: () => 'data:image/png;base64,wrong' } };
  assert.deepEqual(matchNativeVideoSourceThumbnails([source], [desktop]), []);
  assert.deepEqual(matchNativeVideoSourceThumbnails([{ ...source, windowId: undefined }], [desktop]), []);
  const matching = { ...desktop, id: 'window:10:0' };
  assert.deepEqual(matchNativeVideoSourceThumbnails([source], [matching, matching]), []);
});

test('整屏预览按物理位置转换后的显示器 ID 匹配，支持负坐标与不同缩放', () => {
  const source = { sourceId: 'monitor:1:0', kind: 'monitor', title: '\\\\.\\DISPLAY2',
    width: 1920, height: 1080, monitorOrigin: { x: -1920, y: 0 } };
  let physical;
  const displayId = monitorDisplayId(source, {
    screenToDipPoint(point) { physical = point; return { x: -640, y: 360 }; },
    getDisplayNearestPoint: () => ({ id: 42, bounds: { x: -1280, y: 0, width: 1280, height: 720 } }),
  });
  assert.deepEqual(physical, { x: -960, y: 540 });
  assert.equal(displayId, '42');
  const image = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,screen' };
  const desktop = [{ type: 'screen', displayId: '42', name: 'Screen 1', thumbnail: image }];
  assert.deepEqual(matchNativeVideoSourceThumbnails([{ ...source, displayId }], desktop),
    [{ sourceId: source.sourceId, thumbnail: 'data:image/png;base64,screen' }]);
  assert.deepEqual(matchNativeVideoSourceThumbnails([{ ...source, displayId: 'wrong' }], desktop), []);
  assert.deepEqual(matchNativeVideoSourceThumbnails([{ ...source, displayId }], [...desktop, ...desktop]), []);
  assert.equal(monitorDisplayId({ kind: 'window' }, {}), undefined);
  assert.equal(monitorDisplayId({ ...source, monitorOrigin: undefined }, {}), undefined);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test timed out waiting for fake helper state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('helper stderr 保留原生错误并且不干扰协议响应', async () => {
  const diagnostics = [];
  const { manager, children } = createManager({}, { onDiagnostic: (message) => diagnostics.push(message) });
  try {
    await manager.getCapabilities();
    children[0].stderr.write('stage=initialize hresult=0x80070057\n');
    children[0].stderr.write('x'.repeat(9000));
    assert.equal(diagnostics[0], 'stage=initialize hresult=0x80070057\n');
    assert.ok(diagnostics.every((message) => message.length <= 4096));
    assert.deepEqual((await manager.getCapabilities()).microphoneCapture, capabilities.microphoneCapture);
  } finally {
    await manager.shutdown();
  }
});

test('helper starts lazily and concurrent capability requests share one process and handshake', async () => {
  const { manager, children, spawnOptions } = createManager();
  assert.equal(children.length, 0);

  const results = await Promise.all(Array.from({ length: 6 }, () => manager.getCapabilities()));
  assert.equal(children.length, 1);
  assert.deepEqual(spawnOptions[0].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(children[0].commands.filter((command) => command === 'hello').length, 1);
  assert.equal(children[0].commands.filter((command) => command === 'capabilities').length, 1);
  assert.deepEqual(results[0].microphoneCapture, capabilities.microphoneCapture);
  await manager.shutdown();
});

test('来源记忆使用 helper 生命周期标识，重启实例不能复用旧标识', async () => {
  const first = createManager();
  const second = createManager();
  try {
    const snapshot = await first.manager.listVideoSources();
    assert.equal((await first.manager.listVideoSources()).discoveryId, snapshot.discoveryId);
    assert.match(snapshot.discoveryId, /^[0-9a-f-]{36}$/);
    assert.notEqual((await second.manager.listVideoSources()).discoveryId, snapshot.discoveryId);
  } finally {
    await Promise.all([first.manager.shutdown(), second.manager.shutdown()]);
  }
});

test('handshake timeout, wrong protocol version, and wrong request id reject and clean the child', async (t) => {
  for (const mode of [{ helloTimeout: true }, { wrongVersion: true }, { wrongRequestId: true }]) {
    await t.test(JSON.stringify(mode), async () => {
      const { manager, children } = createManager(mode);
      await assert.rejects(manager.getCapabilities());
      await waitUntil(() => children[0]?.closed);
      assert.equal(children[0].killCount, 1);
      await manager.shutdown();
    });
  }
});

test('unexpected helper exit rejects pending capability request and allows only a later controlled retry', async () => {
  const { manager, children } = createManager({ capabilitiesExit: true });
  await assert.rejects(manager.getCapabilities(), /mediaHelperExited:17/);
  assert.equal(children.length, 1);
  await assert.rejects(manager.getCapabilities(), /mediaHelperRetryDelayed/);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('malformed output, oversized lines, request timeouts, and write failures reject requests and kill the child', async (t) => {
  for (const mode of [
    { invalidJson: true },
    { invalidUtf8: true },
    { outputTooLong: true },
    { capabilitiesTimeout: true },
    { writeFailure: true },
    { wrongCapabilitiesRequestId: true },
  ]) {
    await t.test(JSON.stringify(mode), async () => {
      const { manager, children } = createManager(mode);
      await assert.rejects(manager.getCapabilities());
      await waitUntil(() => children[0]?.closed);
      assert.equal(children[0].killCount, 1);
      await manager.shutdown();
    });
  }
});

test('idle helper receives shutdown and closes normally', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0]?.closed);
  assert.equal(children[0].commands.at(-1), 'shutdown');
  assert.equal(children[0].killCount, 0);
  await manager.shutdown();
});

test('native microphone capture validates settings, configures the active session, and stops idempotently', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 20 });
  const settings = { inputGain: 0.8, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false };
  const pipeId = '58d00436-8ac2-4d0c-9283-9d5d5f70ed01';
  const sessionId = 'microphone-session';
  const started = await manager.startMicrophoneCapture(pipeId, sessionId, settings);
  assert.deepEqual(started, { sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
  assert.deepEqual(await manager.startMicrophoneCapture(pipeId, sessionId, settings), { ...started, changed: false });
  await assert.rejects(manager.startMicrophoneCapture(pipeId, 'other-session', settings), /microphoneCaptureAlreadyRunning/);
  assert.deepEqual(await manager.configureMicrophoneCapture(sessionId, { ...settings, inputGain: 1.2 }), { changed: true });
  assert.deepEqual(await manager.stopMicrophoneCapture(sessionId), { changed: true });
  assert.deepEqual(await manager.stopMicrophoneCapture(sessionId), { changed: false });
  assert.equal(children[0].requests.filter((request) => request.command === 'startMicrophoneCapture').length, 1);
  assert.equal(children[0].requests.find((request) => request.command === 'startMicrophoneCapture').pipeId, pipeId);
  await waitUntil(() => children[0].closed);
  await manager.shutdown();
});

test('microphone startup allows the Rust worker startup deadline beyond the general request timeout', async () => {
  const { manager, children } = createManager({ microphoneStartDelayMs: 65 }, {
    requestTimeoutMs: 30,
    audioStartTimeoutMs: 150,
  });
  const settings = { inputGain: 1, noiseSuppression: false, autoGainControl: false, voiceEnhancement: false };
  const sessionId = 'delayed-microphone-session';
  const started = await manager.startMicrophoneCapture(
    '58d00436-8ac2-4d0c-9283-9d5d5f70ed01', sessionId, settings,
  );
  assert.equal(started.changed, true);
  assert.equal(children[0].killCount, 0);
  await manager.stopMicrophoneCapture(sessionId);
  await manager.shutdown();
});

test('stopping the native microphone while start is pending waits for start then stops the same session', async () => {
  const { manager, children } = createManager({ holdMicrophoneStart: true });
  const settings = { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true };
  const sessionId = 'pending-microphone-session';
  const start = manager.startMicrophoneCapture('58d00436-8ac2-4d0c-9283-9d5d5f70ed01', sessionId, settings);
  await waitUntil(() => children[0]?.pendingMicrophoneStart);
  const stop = manager.stopMicrophoneCapture(sessionId);
  children[0].writeResponse({ event: 'microphoneCaptureStarted', protocolVersion: 1,
    requestId: children[0].pendingMicrophoneStart.requestId, sessionId, state: 'running',
    sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10, changed: true });
  await start;
  assert.deepEqual(await stop, { changed: true });
  assert.deepEqual(children[0].commands.slice(-2), ['startMicrophoneCapture', 'stopMicrophoneCapture']);
  await manager.shutdown();
});

test('pending source refresh allows confirmation and replaces the snapshot only after completion', async () => {
  const { manager, children } = createManager({}, { requestTimeoutMs: 1000 });
  try {
    const sources = await manager.listVideoSources();
    const child = children[0];
    child.mode.holdVideoSources = true;
    const refresh = manager.listVideoSources();
    await waitUntil(() => child.requests.filter(({ command }) => command === 'listVideoSources').length === 2);

    await manager.reserveVideo('video-session', sources.sources[0].sourceId);
    assert.equal(child.commands.includes('reserveVideo'), true);
    await manager.stopVideo('video-session');

    const request = child.requests.filter(({ command }) => command === 'listVideoSources')[1];
    child.writeResponse({ event: 'videoSources', protocolVersion: 1, requestId: request.requestId,
      revision: 2, sources: [] });
    assert.deepEqual((await refresh).sources, []);
    await assert.rejects(manager.reserveVideo('late-session', sources.sources[0].sourceId), /videoSourceExpired/);
    assert.equal(child.requests.filter(({ command }) => command === 'reserveVideo').length, 1);
  } finally {
    await manager.shutdown();
  }
});

test('failed source refresh invalidates the previous snapshot', async () => {
  const { manager, children } = createManager();
  const sources = await manager.listVideoSources();
  children[0].mode.listVideoSourcesFailure = true;
  await assert.rejects(manager.listVideoSources(), /mediaHelper:sourceDiscoveryFailed/);
  await assert.rejects(manager.reserveVideo('video-session', sources.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children[0].commands.includes('reserveVideo'), false);
  await manager.shutdown();
});

test('source ids expire when the lazy helper is reclaimed and do not start a replacement', async () => {
  const { manager, children } = createManager({}, { idleTimeoutMs: 15 });
  const sources = await manager.listVideoSources();
  await waitUntil(() => children[0]?.closed);

  await assert.rejects(manager.reserveVideo('video-session', sources.sources[0].sourceId), /videoSourceExpired/);
  assert.equal(children.length, 1);
  assert.equal(children[0].commands.includes('reserveVideo'), false);
  await manager.shutdown();
});

test('诊断保留真实helper版本和麦克风统计，不再补回已移除的视频探针字段', async () => {
  const { manager } = createManager({ omitMicrophoneCaptureDroppedChunks: true });
  const diagnostics = await manager.getDiagnostics();
  assert.equal(diagnostics.helperVersion, '0.1.0');
  assert.equal(diagnostics.captureBackend, null);
  assert.equal('framePoolRecreates' in diagnostics, false);
  assert.equal('probeProcessedFps' in diagnostics, false);
  assert.equal((await manager.getDiagnostics()).microphoneCaptureDroppedChunks, 0);
  await manager.shutdown();
});

test('运行中的原生后端按协议保留，非法版本或后端不能进入报告', async (t) => {
  const { manager } = createManager();
  try {
    assert.equal((await manager.getDiagnostics()).captureBackend, null);
  } finally { await manager.shutdown(); }
  for (const diagnosticsOverrides of [{ helperVersion: undefined }, { helperVersion: 'https://private/token' },
    { captureBackend: 'unverifiedBackend' }, { captureBackend: 'windowsGraphicsCapture' }]) {
    await t.test(JSON.stringify(diagnosticsOverrides), async () => {
      const { manager } = createManager({ diagnosticsOverrides });
      try { await assert.rejects(manager.getDiagnostics(), /mediaHelperInvalidDiagnostics/); }
      finally { await manager.shutdown(); }
    });
  }
});

test('application shutdown during idle close rejects a waiting request without respawning', async () => {
  const { manager, children } = createManager({ shutdownHang: true }, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0].commands.includes('shutdown'));

  const waitingRequest = manager.getCapabilities();
  const shutdown = manager.shutdown();
  await assert.rejects(waitingRequest, /mediaHelperShuttingDown/);
  await shutdown;

  assert.equal(children.length, 1);
  assert.equal(children[0].closed, true);
  assert.equal(children[0].commands.filter((command) => command === 'hello').length, 1);
});

test('application shutdown sends shutdown and waits for normal helper exit', async () => {
  const { manager, children } = createManager();
  await manager.getCapabilities();
  await manager.shutdown();
  assert.equal(children[0].commands.at(-1), 'shutdown');
  assert.equal(children[0].closed, true);
  assert.equal(children[0].killCount, 0);
});

test('shutdown timeout terminates and reaps an unresponsive helper within a bound', async () => {
  const { manager, children } = createManager({ shutdownHang: true });
  await manager.getCapabilities();
  const startedAt = Date.now();
  await manager.shutdown();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(children[0].killCount, 1);
  assert.equal(children[0].closed, true);
});

test('idle kill without close blocks a replacement helper and remains diagnosable', async () => {
  const { manager, children } = createManager({ shutdownHang: true, killNoClose: true }, { idleTimeoutMs: 20 });
  await manager.getCapabilities();
  await waitUntil(() => children[0].killCount === 1);
  await waitUntil(() => manager.lastError);

  await assert.rejects(manager.getCapabilities(), /mediaHelperTerminationUnconfirmed/);
  assert.equal(children.length, 1);
  assert.equal(children[0].closed, false);
  assert.equal(manager.children.size, 1);
  await assert.rejects(manager.shutdown(), /mediaHelperTerminationUnconfirmed/);
});

test('kill without close is reported, pending requests settle, and no second helper starts', async () => {
  const { manager, children } = createManager({
    shutdownHang: true,
    killNoClose: true,
    capabilitiesHangAfterFirst: true,
  });
  await manager.getCapabilities();
  const pendingRequest = manager.getCapabilities();
  const pendingRejection = assert.rejects(pendingRequest);
  const startedAt = Date.now();

  await assert.rejects(manager.shutdown(), /mediaHelperTerminationUnconfirmed/);
  await pendingRejection;
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(children[0].killCount, 1);
  assert.equal(children[0].closed, false);
  assert.equal(manager.children.size, 1);
  assert.equal([...manager.children][0].pending.size, 0);
  await assert.rejects(manager.getCapabilities(), /mediaHelperShuttingDown/);
  assert.equal(children.length, 1);
});

test('remote input is bound to one active monitor session and authenticated identity', async () => {
  const { manager, children } = createManager();
  const sources = await manager.listVideoSources();
  await manager.reserveVideo('video-control', sources.sources[0].sourceId);
  await manager.setRemoteControl('video-control', 'control-session', 'member-a');
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 1,
    { kind: 'move', x: 0, y: 65535 }), { changed: true, dropped: false });
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 3,
    { kind: 'move', x: 3, y: 4 }), { changed: true, dropped: false });
  assert.deepEqual(await manager.sendRemoteInput('video-control', 'control-session', 'member-a', 2,
    { kind: 'buttonUp', button: 'left', x: 333, y: 444 }), { changed: true, dropped: false });
  const buttonRelease = children[0].requests.find((request) => request.command === 'remoteInput' && request.sequence === 2);
  assert.deepEqual(buttonRelease.input, { kind: 'buttonUp', button: 'left', x: 333, y: 444 });
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-b', 2,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 1,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 4,
    { kind: 'execute', command: 'bad' }), /remoteControlInvalidSession/);
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 4,
    { kind: 'move', x: 1, y: 2, hwnd: 1234 }), /remoteControlInvalidSession/);
  assert.deepEqual(await manager.clearRemoteControl('video-control', 'control-session'), { changed: true });
  await assert.rejects(manager.sendRemoteInput('video-control', 'control-session', 'member-a', 5,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await manager.stopVideo('video-control');
  await manager.shutdown();
});

test('mouse movement may be dropped under load, but discrete overload clears the helper grant', async () => {
  const { manager } = createManager();
  const sources = await manager.listVideoSources();
  await manager.reserveVideo('video-overload', sources.sources[0].sourceId);
  await manager.setRemoteControl('video-overload', 'control-overload', 'member-a');
  for (let sequence = 1; sequence <= 120; sequence += 1) {
    await manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', sequence,
      { kind: 'move', x: sequence, y: 2 });
  }
  await assert.rejects(manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', 121,
    { kind: 'keyUp', key: 'letterA' }), /remoteControlInputRateExceeded/);
  await assert.rejects(manager.sendRemoteInput('video-overload', 'control-overload', 'member-a', 122,
    { kind: 'move', x: 1, y: 2 }), /remoteControlInvalidSession/);
  await manager.stopVideo('video-overload');
  await manager.shutdown();
});

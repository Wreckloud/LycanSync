const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNativeVideoSession } = require('./native-video-session.cjs');
const { createMediaBackgroundPolicy } = require('./media-background.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function mainRendererFixture() {
  let throttled = true;
  return { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false, send: () => {},
    getBackgroundThrottling: () => throttled, setBackgroundThrottling: value => { throttled = value; } } };
}

function gameRoutingFixture(classify, startFailure, requiresWindowCapture = false) {
  const calls = [];
  const targetState = { alive: true, closed: false };
  const target = { kind: 'window', windowId: '123', lifetimeName: 'Local\\LycanSync.WindowLifetime.1.2.3.123',
    processCreationTime: '456', processId: 123, requiresWindowCapture, executable: 'C:\\Games\\selected.exe' };
  const sandbox = { recording: { active: undefined, withVideoChange: operation => operation() }, mainWindow: mainRendererFixture(), performance, writeMediaDiagnostic: async () => {}, closing: false,
    nativeMediaBridge: {},
    nativeScreenAudio: { sessionId: undefined, pausePublishing: () => {} },
    nativeVideoSourcesById: new Map([['window:7:0', { kind: 'window', title: 'same title' }]]),
    activityMonitor: { isCaptureGame: classify },
    obsCaptureHost: { state: undefined,
      start: async (sourceId, fps, id, target, settings, resolution) => {
        calls.push({ action: 'start', sourceId, fps, id, target, settings, resolution });
        if (startFailure) throw new Error(startFailure);
        sandbox.obsCaptureHost.state = { videoSessionId: id };
        return { sessionId: id, changed: true };
      },
      stop: async (id) => { calls.push({ action: 'stop', id }); sandbox.obsCaptureHost.state = undefined; return { changed: true }; } },
    mediaHelper: { videoCapture: undefined, videoSourceSnapshot: { state: targetState },
      inspectVideoSource: async () => { calls.push({ action: 'inspect' }); return { ...target }; },
      reserveVideo: async (id) => {
        sandbox.mediaHelper.videoCapture = { state: sandbox.mediaHelper.videoSourceSnapshot.state, sessionId: id };
        calls.push({ action: 'reserve', id });
        return { ...target };
      },
      stopVideo: async (id) => {
        calls.push({ action: 'release', id }); sandbox.mediaHelper.videoCapture = undefined; return { changed: true };
      },
      startVideo: () => assert.fail('不能回退到 Rust') },
    recordVideoFailure: () => {} };
  sandbox.nativeVideo = createNativeVideoSession({ host: sandbox.obsCaptureHost, mediaHelper: sandbox.mediaHelper,
    getSources: () => sandbox.nativeVideoSourcesById, isCaptureGame: executable => sandbox.activityMonitor.isCaptureGame(executable),
    getBridge: () => sandbox.nativeMediaBridge, getWindow: () => sandbox.mainWindow, sharedTexture: {},
    getRecording: () => sandbox.recording, screenAudio: sandbox.nativeScreenAudio,
    getGameFollow: () => sandbox.leagueCaptureFollow, isClosing: () => sandbox.closing,
    setMediaBackgroundActive: createMediaBackgroundPolicy(), platform: 'win32',
    writeDiagnostic: entry => sandbox.writeMediaDiagnostic(entry), recordFailure: (...args) => sandbox.recordVideoFailure(...args),
  });
  return { sandbox, calls, target, start: (settings = { hideCursor: true, hideBorder: true }) => sandbox.nativeVideo.start('window:7:0', 120, settings) };
}

test('先预留窗口身份再分类启动，停止先确认宿主再释放身份', async () => {
  const f = gameRoutingFixture(async () => { f.calls.push({ action: 'classify' }); return false; });
  const started = await f.start();
  const video = f.sandbox.nativeVideo.current;
  assert.equal(video.targetState, f.sandbox.mediaHelper.videoSourceSnapshot.state);
  assert.equal(video.sourceKind, 'window');
  const capture = f.calls.find(call => call.action === 'start');
  assert.equal(capture.target.windowId, f.target.windowId);
  assert.equal(capture.target.executable, undefined);
  await f.sandbox.nativeVideo.stop(started.sessionId);
  assert.deepEqual(f.calls.map(call => call.action), ['reserve', 'classify', 'start', 'stop', 'release']);
  assert.equal(f.sandbox.nativeVideo.current, undefined);
});

test('显示器各帧率均走 OBS，计时记录真实启动且重复停止不触发新清理', async () => {
  const f = gameRoutingFixture(() => assert.fail('显示器不进行游戏分类'));
  const { sandbox } = f;
  sandbox.nativeVideoSourcesById.set('monitor:7:0', { kind: 'monitor' });
  f.target.kind = 'monitor';
  f.target.monitorName = '\\\\.\\DISPLAY2';
  const timings = [];
  sandbox.writeMediaDiagnostic = async entry => timings.push(entry);
  for (const fps of [30, 60, 120]) {
    const started = await sandbox.nativeVideo.start('monitor:7:0', fps, { hideCursor: true, hideBorder: false });
    assert.equal(f.calls.at(-1).fps, fps);
    assert.equal(f.calls.at(-1).target.kind, 'monitor');
    await sandbox.nativeVideo.stop(started.sessionId);
    const count = f.calls.length;
    assert.deepEqual(await sandbox.nativeVideo.stop(started.sessionId), { changed: false });
    assert.equal(f.calls.length, count);
  }
  assert.equal(timings.filter(entry => entry.stage === 'screenVideoStartRequested').length, 3);
  const ready = timings.filter(entry => entry.stage === 'obsReady');
  assert.equal(ready.length, 3);
  assert.ok(ready.every(entry => Number.isFinite(entry.durationMs) && entry.durationMs >= 0));
});

test('停止先禁用远控再清理采集；撤销失败仍回收画面但不报告成功', async () => {
  for (const fails of [false, true]) {
    const f = gameRoutingFixture(async () => false);
    const { sandbox, calls } = f;
    const { sessionId } = await f.start();
    calls.length = 0;
    let finish;
    const control = { controlSessionId: 'control', accepting: true };
    sandbox.mediaHelper.videoCapture.remoteControl = control;
    sandbox.mediaHelper.clearRemoteControl = async (id, controlId) => {
      assert.equal(id, sessionId); assert.equal(controlId, control.controlSessionId);
      calls.push({ action: 'revoke' }); control.accepting = false;
      await new Promise(resolve => { finish = resolve; });
      if (fails) throw new Error('remoteControlInputFailed');
    };
    const stopping = sandbox.nativeVideo.stop(sessionId);
    const rejected = fails ? assert.rejects(stopping, /remoteControlInputFailed/) : undefined;
    assert.equal(control.accepting, false);
    assert.equal(sandbox.nativeVideo.current.stopping, true);
    assert.deepEqual(calls.map(call => call.action), ['revoke']);
    finish();
    if (fails) {
      await rejected;
      assert.equal(sandbox.nativeVideo.current.stopping, true);
      await assert.rejects(f.start(), /AlreadyRunning/);
    } else {
      await stopping;
      assert.equal(sandbox.nativeVideo.current, undefined);
    }
    assert.deepEqual(calls.map(call => call.action), ['revoke', 'stop', 'release']);
  }
});

test('停止等待消费者引用和槽位确认，不提前清空登记或停止宿主', async context => {
  const f = gameRoutingFixture(async () => false);
  const { sandbox, calls } = f;
  const { sessionId } = await f.start();
  calls.length = 0;
  const video = sandbox.nativeVideo.current;
  sandbox.mainWindow.webContents.send = channel => calls.push({ action: channel });
  video.imported.set(0, { release: () => calls.push({ action: 'release-reference' }) });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = sandbox.nativeVideo.stop(sessionId);
  assert.deepEqual(calls.map(call => call.action), ['media:native-video-stopping', 'release-reference']);
  assert.equal(video.imported.size, 1);
  video.imported.clear(); video.pendingSlotReleases.add(0);
  context.mock.timers.tick(10); await flush();
  assert.equal(calls.some(call => call.action === 'stop'), false);
  video.pendingSlotReleases.clear();
  context.mock.timers.tick(10); await stopping;
  assert.deepEqual(calls.slice(-2).map(call => call.action), ['stop', 'release']);
  assert.equal(sandbox.nativeVideo.current, undefined);
});

test('纹理释放超时只在宿主退出和身份释放确认后允许重开', async context => {
  for (const failure of [undefined, 'shutdown', 'identity']) {
    const f = gameRoutingFixture(async () => false);
    const { sandbox, calls } = f;
    const { sessionId } = await f.start();
    const video = sandbox.nativeVideo.current;
    video.imported.set(0, { release: () => {} });
    calls.length = 0;
    const events = [];
    sandbox.writeMediaDiagnostic = async entry => events.push(entry);
    sandbox.obsCaptureHost.shutdown = async (force, reason) => {
      assert.equal(force, true); assert.equal(reason, 'textureTimeout');
      calls.push({ action: 'shutdown' });
      if (failure === 'shutdown') throw new Error('obsCaptureStopUnconfirmed');
      sandbox.obsCaptureHost.state = undefined;
    };
    if (failure === 'identity') sandbox.mediaHelper.stopVideo = async () => { throw new Error('identityReleaseFailed'); };
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const stopping = sandbox.nativeVideo.stop(sessionId);
    const rejected = failure ? assert.rejects(stopping, /obsCaptureStopUnconfirmed|identityReleaseFailed/) : undefined;
    context.mock.timers.tick(1300);
    if (failure) {
      await rejected;
      assert.equal(sandbox.nativeVideo.current, video);
      await assert.rejects(f.start(), /AlreadyRunning/);
      assert.ok(!events.some(entry => entry.stage === 'screenVideoStopRecovered'));
      if (failure === 'shutdown') assert.equal(calls.length, 1);
    } else {
      await stopping;
      assert.equal(sandbox.nativeVideo.current, undefined);
      assert.deepEqual(calls.map(call => call.action), ['shutdown', 'stop', 'release']);
      assert.ok(events.some(entry => entry.stage === 'screenVideoStopRecovered'));
    }
    context.mock.timers.reset();
  }
});

test('宿主未确认停止时保留来源身份，启动失败的清理也不能绕过', async () => {
  for (const startFailure of [undefined, 'controlledStartFailure']) {
    const f = gameRoutingFixture(async () => false, startFailure);
    const { sandbox } = f;
    sandbox.obsCaptureHost.stop = async () => { throw new Error('obsCaptureStopUnconfirmed'); };
    if (startFailure) await assert.rejects(f.start(), /obsCaptureStopUnconfirmed/);
    else {
      const { sessionId } = await f.start();
      await assert.rejects(sandbox.nativeVideo.stop(sessionId), /obsCaptureStopUnconfirmed/);
    }
    assert.ok(sandbox.mediaHelper.videoCapture);
    assert.equal(sandbox.nativeVideo.current.stopping, true);
    await assert.rejects(f.start(), /AlreadyRunning/);
    assert.equal(f.calls.some(call => call.action === 'release'), false);
  }
});

test('宿主已属于其他会话时，旧会话清理不释放新来源', async () => {
  const f = gameRoutingFixture(async () => false);
  const { sessionId } = await f.start();
  const { sandbox } = f;
  const state = sandbox.obsCaptureHost.state;
  state.videoSessionId = 'new-session';
  sandbox.mediaHelper.videoCapture = { sessionId: 'new-session' };
  sandbox.obsCaptureHost.stop = () => assert.fail('不能停止新会话');
  sandbox.mediaHelper.stopVideo = () => assert.fail('不能释放新来源');
  await sandbox.nativeVideo.stop(sessionId);
  assert.equal(sandbox.obsCaptureHost.state, state);
  assert.equal(sandbox.mediaHelper.videoCapture.sessionId, 'new-session');
});

async function switchingFixture() {
  const f = gameRoutingFixture(async () => true);
  const follow = {};
  let active = true;
  const { sandbox, calls } = f;
  sandbox.nativeVideoSourcesById.set('window:2:0', { kind: 'window' });
  sandbox.leagueCaptureFollow = {
    require: () => { if (!active) throw new Error('nativeGameFollowUnavailable'); return follow; },
    findSource: async () => ({ sourceId: 'window:2:0' }),
    begin: () => 'league',
    bind: id => { assert.equal(id, 'league'); calls.push({ action: 'bind' }); },
    end: () => { active = false; },
  };
  const initial = await f.start({ hideCursor: false, hideBorder: true, followGame: 'league' });
  calls.length = 0;
  return { ...f, initial, cancel: () => { active = false; },
    switch: () => sandbox.nativeVideo.switchGame('league', 'window:2:0', 60,
      { hideCursor: false, hideBorder: true }, { width: 1920, height: 1080 }) };
}

test('跟随切换先确认旧会话停止，再以同一授权启动新窗口', async () => {
  const f = await switchingFixture();
  const started = await f.switch();
  assert.equal(started.gameFollowId, 'league');
  assert.equal(f.calls[0].action, 'stop');
  assert.equal(f.calls[0].id, f.initial.sessionId);
  assert.deepEqual(f.calls.map(call => call.action), ['stop', 'release', 'reserve', 'bind', 'start']);
  assert.equal(f.calls.at(-1).sourceId, 'window:2:0');
  assert.equal(f.calls.at(-1).settings.followGame, 'league');
  await f.sandbox.nativeVideo.stop(started.sessionId);
});

test('旧来源清理等待中取消或停止失败，不会启动新窗口', async () => {
  for (const failure of [false, true]) {
    const f = await switchingFixture();
    let finish;
    f.sandbox.obsCaptureHost.stop = () => new Promise((resolve, reject) => {
      finish = () => failure ? reject(new Error('obsCaptureStopUnconfirmed')) : resolve({ changed: true });
    });
    const rejected = assert.rejects(f.switch(), failure ? /StopUnconfirmed/ : /nativeGameFollowUnavailable/);
    await flush();
    if (!failure) f.cancel();
    finish(); await rejected;
    assert.equal(f.calls.some(call => call.action === 'start'), false);
  }
});

test('来源改变、其他共享占用和非法参数在停止旧共享前拒绝', async () => {
  for (const invalid of ['source', 'owner', 'settings']) {
    const f = await switchingFixture();
    if (invalid === 'source') f.sandbox.leagueCaptureFollow.findSource = async () => ({ sourceId: 'window:3:0' });
    if (invalid === 'owner') f.sandbox.nativeVideo.current.gameFollowId = 'other';
    await assert.rejects(invalid === 'settings'
      ? f.sandbox.nativeVideo.switchGame('league', 'window:2:0', 180, {}, {}) : f.switch(), /nativeGameFollow/);
    assert.equal(f.calls.some(call => ['start', 'stop'].includes(call.action)), false);
    await f.sandbox.nativeVideo.stop(f.initial.sessionId);
  }
});

test('共享停止先暂停声音发布，等待录像与回放收尾，再停止声音和画面', async () => {
  for (const recordingKind of ['active', 'replay']) {
    const f = gameRoutingFixture(async () => false);
    const { sandbox, calls } = f;
    const { sessionId } = await f.start();
    calls.length = 0;
    sandbox.recording[recordingKind] = { videoSessionId: sessionId };
    let finish;
    sandbox.nativeScreenAudio.pausePublishing = id => { assert.equal(id, sessionId); calls.push({ action: 'pause-audio' }); };
    sandbox.recording.stopAll = () => new Promise(resolve => {
      calls.push({ action: 'recording-stop' }); finish = resolve;
    });
    sandbox.nativeScreenAudio.sessionId = sessionId;
    sandbox.nativeScreenAudio.stop = async id => { assert.equal(id, sessionId); calls.push({ action: 'audio-stop' }); };
    const stopped = sandbox.nativeVideo.stop(sessionId);
    assert.deepEqual(calls.map(call => call.action), ['pause-audio', 'recording-stop']);
    finish(); await stopped;
    assert.deepEqual(calls.map(call => call.action), ['pause-audio', 'recording-stop', 'audio-stop', 'stop', 'release']);
  }
});

test('页面销毁后故障仍停止采集，不向已销毁页面发送通知', async () => {
  const f = gameRoutingFixture(async () => false);
  await f.start();
  const { sandbox } = f;
  sandbox.mainWindow.webContents.isDestroyed = () => true;
  sandbox.mainWindow.webContents.send = () => { throw new Error('Object has been destroyed'); };
  await sandbox.nativeVideo.notifyFailure(sandbox.nativeVideo.current, 'captureTargetClosed');
  assert.equal(sandbox.nativeVideo.current, undefined);
  assert.equal(sandbox.mediaHelper.videoCapture, undefined);
});

test('旧会话故障不能再发通知或改变新共享', async () => {
  const f = gameRoutingFixture(async () => false);
  const old = await f.start();
  const { sandbox } = f;
  const oldVideo = sandbox.nativeVideo.current;
  await sandbox.nativeVideo.stop(old.sessionId);
  const next = await f.start();
  const messages = [];
  sandbox.mainWindow.webContents.send = (...args) => messages.push(args);
  await sandbox.nativeVideo.notifyFailure(oldVideo, 'sharedTextureSlotReleaseFailed');
  assert.deepEqual(messages, []);
  assert.equal(sandbox.nativeVideo.current.sessionId, next.sessionId);
  assert.equal(sandbox.nativeVideo.current.stopping, false);
  await sandbox.nativeVideo.stop(next.sessionId);
});

test('暂停事件只更新当前宿主会话，页面销毁不打断暂停状态接收', async () => {
  const f = gameRoutingFixture(async () => false);
  const { sessionId } = await f.start();
  const { sandbox } = f;
  const video = sandbox.nativeVideo.current;
  const state = sandbox.obsCaptureHost.state;
  sandbox.nativeVideo.suspend({ videoSessionId: sessionId }, { sessionId, suspended: true });
  sandbox.nativeVideo.suspend(state, { sessionId: 'old', suspended: true });
  assert.equal(video.suspended, undefined);
  sandbox.mainWindow.webContents.isDestroyed = () => true;
  sandbox.mainWindow.webContents.send = () => { throw new Error('Object has been destroyed'); };
  sandbox.nativeVideo.suspend(state, { sessionId, suspended: true });
  assert.equal(video.suspended, true);
  await sandbox.nativeVideo.stop(sessionId);
  sandbox.nativeVideo.suspend(state, { sessionId, suspended: false });
  assert.equal(video.suspended, true);
});

test('选窗准备仅检查身份与分类，同一选择合并请求，启动复用分类但重新预留身份', async () => {
  let classified = 0;
  const f = gameRoutingFixture(async () => { classified++; return true; });
  const prepare = () => f.sandbox.nativeVideo.prepare('window:7:0');
  await Promise.all([prepare(), prepare()]);
  assert.equal(classified, 1);
  assert.deepEqual(f.calls.map(call => call.action), ['inspect']);
  assert.equal(f.sandbox.nativeVideo.current, undefined);
  assert.equal(f.sandbox.mediaHelper.videoCapture, undefined);
  const started = await f.start();
  assert.equal(classified, 1);
  assert.deepEqual(f.calls.map(call => call.action), ['inspect', 'reserve', 'start']);
  assert.equal(f.calls.at(-1).target.kind, 'game');
  await f.sandbox.nativeVideo.stop(started.sessionId);
});

test('窗口实例或 helper 身份改变，旧准备结果不能替代启动时的权威身份', async () => {
  for (const field of ['lifetimeName', 'processCreationTime', 'processId', 'requiresWindowCapture', 'executable', 'helper']) {
    let classified = 0;
    const f = gameRoutingFixture(async () => ++classified === 1);
    await f.sandbox.nativeVideo.prepare('window:7:0');
    if (field === 'helper') f.sandbox.mediaHelper.videoSourceSnapshot.state = { alive: true, closed: false };
    else if (field === 'requiresWindowCapture') f.target[field] = true;
    else if (field === 'processId') f.target[field]++;
    else f.target[field] += '-new';
    const started = await f.start();
    assert.equal(classified, field === 'requiresWindowCapture' ? 1 : 2);
    assert.equal(f.calls.at(-1).target.kind, 'window');
    await f.sandbox.nativeVideo.stop(started.sessionId);
  }
});

test('取消准备使迟到分类失效，不采集也不覆盖下一次选择', async () => {
  let finish;
  const f = gameRoutingFixture(() => new Promise(resolve => { finish = resolve; }));
  const preparing = f.sandbox.nativeVideo.prepare('window:7:0');
  await flush();
  await f.sandbox.nativeVideo.prepare(null);
  finish(true);
  assert.equal((await preparing).prepared, false);
  assert.equal(f.sandbox.nativeVideo.current, undefined);
  assert.deepEqual(f.calls.map(call => call.action), ['inspect']);
});

test('可选准备失败不停止正在工作的共享，也不保留失败的准备缓存', async () => {
  const f = gameRoutingFixture(async () => false);
  const started = await f.start();
  const current = f.sandbox.nativeVideo.current;
  f.sandbox.mediaHelper.inspectVideoSource = async () => { throw new Error('videoSourceExpired'); };
  await assert.rejects(f.sandbox.nativeVideo.prepare('window:7:0'), /videoSourceExpired/);
  assert.equal(f.sandbox.nativeVideo.current, current);
  assert.equal(f.calls.filter(call => call.action === 'stop').length, 0);
  await f.sandbox.nativeVideo.stop(started.sessionId);
});

test('只在采集会话期间关闭后台节流，停止和启动失败清理后恢复原值', async () => {
  for (const initial of [true, false]) {
    const f = gameRoutingFixture(async () => false);
    const contents = f.sandbox.mainWindow.webContents;
    contents.setBackgroundThrottling(initial);
    const started = await f.start();
    assert.equal(contents.getBackgroundThrottling(), false);
    await f.sandbox.nativeVideo.stop(started.sessionId);
    assert.equal(contents.getBackgroundThrottling(), initial);
  }
  const failed = gameRoutingFixture(async () => false, 'captureBorderUnsupported');
  await assert.rejects(failed.start(), /captureBorderUnsupported/);
  assert.equal(failed.sandbox.mainWindow.webContents.getBackgroundThrottling(), true);
  assert.equal(failed.sandbox.nativeVideo.current, undefined);
});

test('手动窗口方式跳过游戏猜测，手动游戏仍只绑定原窗口', async () => {
  for (const method of ['bitblt', 'wgc', 'game']) {
    const { start, calls } = gameRoutingFixture(() => assert.fail('手动方式不能被分类器覆盖'));
    await start({ hideCursor: false, hideBorder: true, windowMethod: method });
    const target = calls.find(call => call.action === 'start').target;
    assert.equal(target.kind, method === 'game' ? 'game' : 'window');
    assert.equal(target.windowId, '123');
    assert.equal(target.processCreationTime, '456');
    assert.equal(target.executable, undefined);
  }
});

test('高权限窗口自动走普通窗口源，不尝试注入；手动游戏仍明确执行', async () => {
  for (const method of ['auto', 'game']) {
    const { calls, start } = gameRoutingFixture(() => assert.fail('权限受限时不依赖游戏分类'), undefined, true);
    await start({ hideCursor: false, hideBorder: true, windowMethod: method });
    const target = calls.find(call => call.action === 'start').target;
    assert.equal(target.kind, method === 'game' ? 'game' : 'window');
    assert.equal(target.windowId, '123');
    assert.equal(target.processId, 123);
    assert.equal(target.requiresWindowCapture, undefined);
  }
});

test('所选游戏走精确钩子并保留来源与偏好；启动失败清理身份，不降级窗口或整屏', async () => {
  for (const failure of [undefined, 'obsGameBindingUnavailable', 'obsGameTargetMismatch']) {
    const { sandbox, calls, start } = gameRoutingFixture(async (executable) => {
      assert.equal(executable, 'C:\\Games\\selected.exe'); return true;
    }, failure);
    if (failure) await assert.rejects(start(), new RegExp(failure));
    else {
      const started = await start();
      assert.equal(sandbox.nativeVideo.current.sourceKind, 'window');
      await sandbox.nativeVideo.stop(started.sessionId);
    }
    const capture = calls.find((entry) => entry.action === 'start');
    assert.equal(capture.sourceId, 'window:7:0');
    assert.equal(capture.target.kind, 'game');
    assert.equal(capture.target.windowId, '123');
    assert.equal(capture.target.executable, undefined);
    assert.equal(calls.filter((entry) => entry.action === 'start').length, 1);
    assert.equal(calls.at(-1).action, 'release');
    assert.equal(sandbox.nativeVideo.current, undefined);
  }
});

test('程序分类失败不启动采集，预留身份仍被释放', async () => {
  const { sandbox, calls, start } = gameRoutingFixture(async () => { throw new Error('obsCaptureGameDetectionFailed'); });
  await assert.rejects(start(), /obsCaptureGameDetectionFailed/);
  assert.equal(calls.some((entry) => entry.action === 'start'), false);
  assert.equal(calls.at(-1).action, 'release');
  assert.equal(sandbox.nativeVideo.current, undefined);
});

test('分类等待中重复启动被拒绝；停止后迟到结果不能重开或关闭新会话', async () => {
  let resolveOld;
  let count = 0;
  const { sandbox, calls, start } = gameRoutingFixture(() => ++count === 1
    ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(true));
  const old = assert.rejects(start(), /nativeVideoSessionStopped/);
  await flush();
  await assert.rejects(start(), /videoCaptureAlreadyRunning/);
  const oldId = sandbox.nativeVideo.current.sessionId;
  await sandbox.nativeVideo.stop(oldId);
  const current = await start();
  const state = sandbox.obsCaptureHost.state;
  resolveOld(true);
  await old;
  assert.equal(sandbox.obsCaptureHost.state, state);
  assert.equal(sandbox.nativeVideo.current.sessionId, current.sessionId);
  assert.equal(calls.filter((entry) => entry.action === 'start').length, 1);
  await sandbox.nativeVideo.stop(current.sessionId);
});


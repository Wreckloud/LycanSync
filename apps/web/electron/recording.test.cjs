const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir, mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { createRecording } = require('./recording.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(context, overrides = {}) {
  const cache = resolve(__dirname, '../../../release/test-cache/recordings');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'recording-'));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  let video = { sessionId: 'video-1' };
  let id = 0;
  const calls = [], events = [], diagnostics = [];
  const host = {
    setRecordingFrameRate: async () => {},
    startRecording: async (...args) => { calls.push(['start', ...args]); await writeFile(args[2], 'controlled-recorded-content'); },
    stopRecording: async (...args) => { calls.push(['stop', ...args]); return { outputFrames: 12 }; },
    startReplay: async (...args) => { calls.push(['replayStart', ...args]); return { width: 1920, height: 1080, frameRate: 60 }; },
    stopReplay: async (...args) => { calls.push(['replayStop', ...args]); },
    saveReplay: async (...args) => { calls.push(['replaySave', ...args]); await writeFile(args[3], 'controlled-replay-content'); },
    ...overrides.host,
  };
  const recording = createRecording({ dataDirectory: root, host, getVideo: () => video,
    createId: () => `12345678-1234-1234-1234-${String(++id).padStart(12, '0')}`,
    ensureAudio: async (...args) => { calls.push(['audio', ...args]); },
    releaseAudio: async (...args) => { calls.push(['releaseAudio', ...args]); },
    ensureVoice: async (...args) => { calls.push(['voice', ...args]); },
    releaseVoice: async (...args) => { calls.push(['releaseVoice', ...args]); },
    onChange: state => events.push(state), onDiagnostic: entry => diagnostics.push(entry), ...overrides, host,
  });
  return { recording, root, calls, events, diagnostics, setVideo: value => { video = value; } };
}

test('默认只录应用声音，主进程生成独占文件，停止保存不停止共享', async context => {
  const f = await fixture(context);
  const settings = await f.recording.load();
  assert.equal(settings.directory, join(f.root, 'recordings'));
  assert.equal(settings.applicationAudio, true); assert.equal(settings.microphone, false); assert.equal(settings.friends, false);
  assert.equal((await f.recording.start()).phase, 'recording');
  assert.deepEqual(f.calls[0], ['audio', 'video-1']);
  assert.equal(f.calls[1][4], true); assert.equal(f.calls[1][5], false);
  const saved = await f.recording.stop();
  assert.equal(saved.saved, true); assert.equal(saved.phase, 'saved');
  assert.equal(await readFile(await f.recording.revealPath(), 'utf8'), 'controlled-recorded-content');
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /recordings[\\/]|\.mkv/);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /recordings[\\/]|\.mkv/);
});

test('回放与录像共用同一音频和编码身份，停止一路不回收另一路所需资源', async context => {
  const f = await fixture(context);
  await f.recording.configure({ microphone: true });
  const replay = await f.recording.startReplay();
  assert.equal(replay.replay.phase, 'buffering');
  assert.equal(replay.mediaVoices, true);
  await f.recording.start();
  assert.equal(f.calls.filter(call => call[0] === 'audio').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'voice').length, 1);
  const replayStart = f.calls.find(call => call[0] === 'replayStart');
  const fileStart = f.calls.find(call => call[0] === 'start');
  assert.equal(replayStart[6], fileStart[6]);
  assert.equal(replayStart[7].videoFps, 60); assert.equal(fileStart[7].videoHeight, 1080);
  await f.recording.stop();
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 0);
  assert.equal(f.recording.snapshot().replay.holdingResources, true);
  await f.recording.stopReplay();
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'releaseVoice').length, 1);
  assert.equal(f.recording.snapshot().mediaId, null);
});

test('录像和回放共用一份视频帧率需求，最后一路停止才归还', async context => {
  const rates = [];
  const f = await fixture(context, { host: { setRecordingFrameRate: async (...args) => rates.push(args) } });
  await f.recording.startReplay();
  await f.recording.start();
  assert.deepEqual(rates, [['video-1', 60]]);
  await f.recording.stop();
  assert.equal(rates.length, 1);
  await f.recording.stopReplay();
  assert.deepEqual(rates, [['video-1', 60], ['video-1', 0]]);
});

test('录像启动失败也归还已提高的帧率需求，不遗留额外渲染负载', async context => {
  const rates = [];
  const f = await fixture(context, { host: {
    setRecordingFrameRate: async (...args) => rates.push(args),
    startRecording: async () => { throw new Error('recordingEncoderStartFailed'); },
  } });
  await assert.rejects(f.recording.start(), /recordingEncoderStartFailed/);
  assert.deepEqual(rates, [['video-1', 60], ['video-1', 0]]);
});

test('普通录像启动失败保留正在缓存的回放，仍能保存近期片段', async context => {
  const rates = [];
  const f = await fixture(context, { host: {
    setRecordingFrameRate: async (...args) => rates.push(args),
    startRecording: async () => { throw new Error('recordingEncoderStartFailed'); },
  } });
  await f.recording.startReplay();
  await assert.rejects(f.recording.start(), /recordingEncoderStartFailed/);
  assert.equal(f.recording.snapshot().replay.phase, 'buffering');
  assert.deepEqual(rates, [['video-1', 60]]);
  const saved = await f.recording.saveReplay();
  assert.ok(saved.replay.lastSavedId);
  assert.equal(f.calls.filter(call => call[0] === 'replayStop').length, 0);
  await f.recording.stopReplay();
  assert.deepEqual(rates, [['video-1', 60], ['video-1', 0]]);
});

test('回放启动失败不结束已在进行的录像，也不提前归还共享编码需求', async context => {
  const rates = [];
  const f = await fixture(context, { host: {
    setRecordingFrameRate: async (...args) => rates.push(args),
    startReplay: async () => { throw new Error('recordingEncoderStartFailed'); },
  } });
  await f.recording.start();
  await assert.rejects(f.recording.startReplay(), /recordingEncoderStartFailed/);
  assert.equal(f.recording.snapshot().phase, 'recording');
  assert.deepEqual(rates, [['video-1', 60]]);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 0);
  assert.equal((await f.recording.stop()).saved, true);
  assert.deepEqual(rates, [['video-1', 60], ['video-1', 0]]);
});

test('回放保存后登记真实文件，不把配置时长当成片段实测时长，不泄露路径', async context => {
  const f = await fixture(context);
  await f.recording.startReplay();
  await assert.rejects(f.recording.configure({ videoFps: 120 }), /recordingBusy/);
  const result = await f.recording.saveReplay();
  assert.equal(result.replay.saving, false);
  assert.equal(result.replay.lastSavedDuringWarmup, true);
  assert.equal(result.replay.warming, true);
  const entry = (await f.recording.library.list()).items[0];
  assert.equal(entry.id, result.replay.lastSavedId);
  assert.equal(entry.state, 'saved'); assert.equal(entry.durationMs, null);
  assert.equal(await readFile(await f.recording.library.filePath(entry.id), 'utf8'), 'controlled-replay-content');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /\.mkv|recordings[\\/]|12345678/);
  await f.recording.stopReplay();
  assert.equal(f.recording.snapshot().replay.warming, false);
});

test('连续保存只允许一个快照，停止等待已提交的保存完成，不丢已确认文件', async context => {
  const writing = deferred();
  const f = await fixture(context, { host: { saveReplay: async (...args) => {
    await writing.promise; await writeFile(args[3], 'saved');
  } } });
  await f.recording.startReplay();
  const saving = f.recording.saveReplay();
  await assert.rejects(f.recording.saveReplay(), /recordingBusy/);
  const stopping = f.recording.stopReplay();
  assert.equal(f.recording.snapshot().replay.phase, 'stopping');
  writing.resolve(); await saving; await stopping;
  assert.equal((await f.recording.library.list()).items[0].state, 'saved');
  assert.equal(f.recording.snapshot().replay.holdingResources, false);
});

test('保存超时阻挡下一次快照，正常停止确认后保留部分文件，不误报成功', async context => {
  const f = await fixture(context, { host: { saveReplay: async (...args) => {
    await writeFile(args[3], 'partial'); throw new Error('replaySaveUnconfirmed');
  } } });
  await f.recording.startReplay();
  await assert.rejects(f.recording.saveReplay(), /replaySaveUnconfirmed/);
  assert.equal(f.recording.snapshot().replay.lastSavedId, null);
  await assert.rejects(f.recording.saveReplay(), /recordingBusy/);
  assert.equal((await f.recording.library.list()).items.length, 0);
  await f.recording.stopReplay();
  const entry = (await f.recording.library.list()).items[0];
  assert.equal(entry.state, 'interrupted'); assert.equal(entry.bytes, 7);
});

test('关闭回放不停止普通录像，重设规格先结束两个输出再续录', async context => {
  const f = await fixture(context); await f.recording.start(); await f.recording.startReplay();
  await f.recording.stopReplay();
  assert.equal(f.recording.snapshot().phase, 'recording');
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 0);
  await f.recording.startReplay();
  await f.recording.withVideoChange(async () => { f.calls.push(['configure']); });
  const calls = f.calls.filter(call => ['replayStop', 'stop', 'configure', 'replayStart', 'start'].includes(call[0])).map(call => call[0]);
  assert.deepEqual(calls.slice(-5), ['replayStop', 'stop', 'configure', 'replayStart', 'start']);
  assert.equal(f.recording.snapshot().replay.phase, 'buffering');
  await f.recording.stopAll();
  assert.equal(f.recording.media, undefined);
});

test('回放停止未确认仍持有资源，不能修改配置；迟到的确认解除阻挡', async context => {
  const f = await fixture(context, { host: { stopReplay: async () => { throw new Error('recordingStopUnconfirmed'); } } });
  await f.recording.startReplay(); const id = f.recording.replay.id;
  await assert.rejects(f.recording.stopReplay(), /recordingStopUnconfirmed/);
  await assert.rejects(f.recording.configure({ videoHeight: 720 }), /recordingBusy/);
  assert.ok(f.recording.media);
  f.recording.replayHostEvent({}, { event: 'replayStopped', replayId: id });
  while (f.recording.replay) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.recording.media, undefined);
});

test('回放宿主意外退出保留故障证据，释放音频且允许重新开启', async context => {
  const f = await fixture(context); await f.recording.startReplay();
  f.recording.replayHostEvent({}, { event: 'replayFailed', replayId: f.recording.replay.id, code: 'recordingHostExited' });
  while (f.recording.replay) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.recording.snapshot().replay.phase, 'failed');
  assert.equal(f.recording.snapshot().replay.error, 'recordingHostExited');
  assert.equal(f.recording.media, undefined);
  assert.ok(f.diagnostics.some(entry => entry.stage === 'replayStopped' && entry.code === 'recordingHostExited'));
  await f.recording.startReplay(); await f.recording.stopReplay();
  assert.equal(f.recording.snapshot().replay.error, null);
});

test('回放准备声音时取消，不继续打开麦克风或启动编码输出', async context => {
  const preparing = deferred(), entered = deferred();
  const f = await fixture(context, { ensureAudio: () => { entered.resolve(); return preparing.promise; } });
  await f.recording.configure({ microphone: true });
  const starting = assert.rejects(f.recording.startReplay(), /recordingCancelled/);
  await entered.promise;
  const stopping = f.recording.stopReplay();
  assert.equal(f.recording.snapshot().mediaVoices, false);
  preparing.resolve(); await starting; await stopping;
  assert.equal(f.calls.some(call => call[0] === 'voice' || call[0] === 'replayStart'), false);
  assert.equal(f.recording.media, undefined);
  assert.equal(f.recording.snapshot().replay.error, null);
});

test('取消迟到的回放启动但停止未确认，仍明确保留失败与资源阻挡', async context => {
  const entered = deferred(), preparing = deferred();
  const f = await fixture(context, { host: {
    startReplay: async () => { entered.resolve(); return preparing.promise; },
    stopReplay: async () => { throw new Error('recordingStopUnconfirmed'); },
  } });
  const starting = assert.rejects(f.recording.startReplay(), /recordingStopUnconfirmed/);
  await entered.promise;
  await assert.rejects(f.recording.stopReplay(), /recordingStopUnconfirmed/);
  preparing.resolve({ width: 1920, height: 1080 }); await starting;
  assert.equal(f.recording.snapshot().replay.phase, 'failed');
  assert.equal(f.recording.snapshot().replay.holdingResources, true);
  assert.equal(f.recording.snapshot().replay.error, 'recordingStopUnconfirmed');
  await assert.rejects(f.recording.configure({ videoFps: 30 }), /recordingBusy/);
  f.recording.replayHostEvent({}, { event: 'replayStopped', replayId: f.recording.replay.id });
  while (f.recording.replay) await new Promise(resolve => setImmediate(resolve));
});

test('没有共享时明确失败，不打开音频或建立录像文件', async context => {
  const f = await fixture(context); f.setVideo(undefined);
  await assert.rejects(f.recording.start(), /recordingShareUnavailable/);
  await assert.rejects(f.recording.startReplay(), /recordingShareUnavailable/);
  assert.equal(f.calls.length, 0);
});

test('开始日志保留宿主确认的录像尺寸，不把共享画布当作实际编码尺寸', async context => {
  const f = await fixture(context, { host: { startRecording: async () => ({ width: 1220, height: 786 }) } });
  await f.recording.start();
  const started = f.diagnostics.find(entry => entry.stage === 'recordingStarted');
  assert.equal(started.width, 1220);
  assert.equal(started.height, 786);
  await f.recording.stop();
});

test('两个可选人声开关独立保存，录制只增加一个 PCM 消费者', async context => {
  const f = await fixture(context);
  await f.recording.configure({ applicationAudio: false, microphone: false, friends: true });
  await f.recording.start();
  assert.equal(f.calls.filter(call => call[0] === 'audio').length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'voice').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'start')[5], true);
  await assert.rejects(f.recording.configure({ microphone: true }), /recordingBusy/);
  await f.recording.stop();
  assert.equal(f.calls.filter(call => call[0] === 'releaseVoice').length, 1);
});

test('开始过程中取消不启动输出，正常取消不记录失败', async context => {
  const preparing = deferred();
  const f = await fixture(context, { ensureAudio: () => preparing.promise });
  const starting = f.recording.start();
  const rejected = assert.rejects(starting, /recordingCancelled/);
  while (!f.recording.active?.path) await new Promise(resolve => setImmediate(resolve));
  const stopping = f.recording.stop();
  preparing.resolve(); await rejected; await stopping;
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 0);
  assert.equal(f.recording.snapshot().error, null);
  assert.equal(f.diagnostics.some(entry => entry.stage === 'recordingFailed'), false);
});

test('画质变更先确认旧文件收尾，再建立新文件段', async context => {
  const f = await fixture(context);
  await f.recording.start();
  const old = f.recording.snapshot().recordingId;
  await f.recording.withVideoChange(async () => { f.calls.push(['configure']); return true; });
  assert.notEqual(f.recording.snapshot().recordingId, old);
  assert.equal(f.recording.snapshot().phase, 'recording');
  assert.deepEqual(f.calls.filter(call => ['start', 'stop', 'configure'].includes(call[0])).map(call => call[0]),
    ['start', 'stop', 'configure', 'start']);
  await f.recording.stop();
});

test('变更期间主动停止撤销续录，迟到配置结果不能重新录制', async context => {
  const f = await fixture(context); await f.recording.start();
  const configured = deferred(); const entered = deferred();
  const changing = f.recording.withVideoChange(async () => { entered.resolve(); await configured.promise; });
  await entered.promise; await f.recording.stop(); configured.resolve(); await changing;
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});

test('停止未确认保留阻挡，不能叠加录制或重设画布', async context => {
  const f = await fixture(context, { host: { stopRecording: async () => { throw new Error('recordingStopUnconfirmed'); } } });
  await f.recording.start();
  await assert.rejects(f.recording.stop(), /recordingStopUnconfirmed/);
  assert.ok(f.recording.active);
  assert.equal(f.recording.snapshot().holdingResources, true);
  await assert.rejects(f.recording.start(), /recordingBusy/);
  await assert.rejects(f.recording.withVideoChange(async () => {}), /recordingBusy/);
});

test('输出失败保留文件，只反馈固定原因且释放录制音频', async context => {
  const f = await fixture(context); await f.recording.start();
  const id = f.recording.snapshot().recordingId;
  f.recording.hostEvent({}, { event: 'recordingStopped', recordingId: id, code: 'recordingDiskFull' });
  while (f.recording.active) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.recording.snapshot().phase, 'failed');
  assert.equal(f.recording.snapshot().error, 'recordingDiskFull');
  assert.equal(f.recording.snapshot().saved, false);
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 1);
});

test('只有容器文件头而没有编码帧，不能显示录像保存成功', async context => {
  const f = await fixture(context, { host: { stopRecording: async () => ({ outputFrames: 0 }) } });
  await f.recording.start();
  const stopped = await f.recording.stop();
  assert.equal(stopped.saved, false); assert.equal(stopped.phase, 'idle');
});

test('停止超时后仍可接受迟到确认，回收资源并解除下一次录制阻挡', async context => {
  const f = await fixture(context, { host: { stopRecording: async () => { throw new Error('recordingStopUnconfirmed'); } } });
  await f.recording.start();
  const id = f.recording.snapshot().recordingId;
  await assert.rejects(f.recording.stop(), /recordingStopUnconfirmed/);
  f.recording.hostEvent({}, { event: 'recordingStopped', recordingId: id, outputFrames: 10 });
  while (f.recording.active) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.recording.snapshot().phase, 'saved');
  assert.equal(f.calls.filter(call => call[0] === 'releaseAudio').length, 1);
});

test('旧录像故障不能停止新文件段，宿主退出则解除旧资源但不假报保存成功', async context => {
  const f = await fixture(context); await f.recording.start();
  const old = f.recording.snapshot().recordingId;
  await f.recording.withVideoChange(async () => {});
  f.recording.hostEvent({}, { event: 'recordingFailed', recordingId: old, code: 'recordingHostExited' });
  assert.equal(f.recording.snapshot().phase, 'recording');
  f.recording.hostEvent({}, { event: 'recordingFailed', recordingId: f.recording.snapshot().recordingId, code: 'recordingHostExited' });
  while (f.recording.active) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.recording.snapshot().phase, 'failed');
  assert.equal(f.recording.snapshot().saved, false);
});

test('输出已结束后的统计读取失败应明确报错，但不能永久占住输出状态', async context => {
  const io = require('node:fs/promises');
  const failing = await fixture(context, { io: { ...io, stat: async () => { const error = new Error('private-path'); error.code = 'EIO'; throw error; } } });
  await failing.recording.start();
  await assert.rejects(failing.recording.stop(), /recordingWriteFailed/);
  assert.equal(failing.recording.snapshot().holdingResources, false);
  assert.equal(failing.recording.active, undefined);
});

test('同一批宿主消息中刚启动就停止，不得被迟到的启动结果复活', async context => {
  let recording;
  const f = await fixture(context, { host: { startRecording: async (_session, id) => {
    recording.hostEvent({}, { event: 'recordingStopped', recordingId: id, outputFrames: 0 });
  } } });
  recording = f.recording;
  await assert.rejects(recording.start(), /recordingWriteFailed/);
  assert.equal(recording.active, undefined);
  assert.equal(recording.snapshot().phase, 'failed');
  assert.equal(f.diagnostics.some(entry => entry.stage === 'recordingStarted'), false);
});

test('应用声音准备失败不冒充磁盘错误，录制中的应用声音失败只结束当前录像', async context => {
  const f = await fixture(context, { ensureAudio: async () => { throw new Error('private-device-error'); } });
  await assert.rejects(f.recording.start(), /recordingApplicationAudioUnavailable/);
  assert.equal(f.calls.some(call => call[0] === 'start'), false);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-device/);
  const running = await fixture(context); await running.recording.start();
  await running.recording.failMedia(running.recording.media.id, 'recordingApplicationAudioUnavailable');
  assert.equal(running.recording.snapshot().phase, 'failed');
  assert.equal(running.recording.active, undefined);
  assert.equal(running.calls.filter(call => call[0] === 'releaseAudio').length, 1);
});

test('录像索引在重启后保留原片信息，读取列表不暴露路径或扫描未登记文件', async context => {
  const f = await fixture(context, { host: { startRecording: async (...args) => {
    await writeFile(args[2], 'recorded'); return { width: 1920, height: 1080 };
  } } });
  await f.recording.start(); await f.recording.stop();
  await writeFile(join(f.root, 'recordings', 'unregistered.mkv'), 'not-registered');
  const { createRecordingLibrary } = require('./recording-library.cjs');
  const reopened = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false });
  const result = await reopened.list();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].state, 'saved');
  assert.equal(result.items[0].availability, 'available');
  assert.equal(result.items[0].bytes, 8);
  assert.equal(result.items[0].width, 1920); assert.equal(result.items[0].height, 1080);
  assert.ok(result.items[0].durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(result), /\.mkv|recordings[\\/]|fileIdentity/);
  assert.equal(await readFile(await reopened.filePath(result.items[0].id), 'utf8'), 'recorded');
});

test('重启时未收尾的录像显示保存未确认，不伪造成功，活动原片禁止打开或删除', async context => {
  const f = await fixture(context); await f.recording.start();
  const id = f.recording.snapshot().recordingId;
  assert.equal((await f.recording.library.list()).items[0].state, 'recording');
  await assert.rejects(f.recording.library.filePath(id), /recordingBusy/);
  await assert.rejects(f.recording.library.remove(id), /recordingBusy/);
  const { createRecordingLibrary } = require('./recording-library.cjs');
  const reopened = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false });
  const entry = (await reopened.list()).items[0];
  assert.equal(entry.state, 'interrupted'); assert.equal(entry.durationMs, null);
  assert.equal(await readFile(await reopened.filePath(id), 'utf8'), 'controlled-recorded-content');
  await f.recording.stop();
});

test('画质与来源续录归为同一组，独立开始为新组，不能续接任意旧条目', async context => {
  const f = await fixture(context); await f.recording.start();
  const first = f.recording.snapshot().recordingId;
  await f.recording.withVideoChange(async () => {});
  const second = f.recording.snapshot().recordingId;
  await f.recording.stop();
  await f.recording.start(second); await f.recording.stop();
  await f.recording.start(); await f.recording.stop();
  const entries = (await f.recording.library.list()).items;
  assert.equal(entries.filter(entry => entry.sessionId === first).length, 3);
  assert.equal(new Set(entries.map(entry => entry.sessionId)).size, 2);
  await assert.rejects(f.recording.start(first), /recordingSessionMismatch/);
});

test('原片被移动或替换后只移除索引，不删除其他文件', async context => {
  const fs = require('node:fs/promises');
  const f = await fixture(context); await f.recording.start(); await f.recording.stop();
  const id = f.recording.snapshot().recordingId;
  const path = await f.recording.library.filePath(id);
  await fs.rename(path, path + '.original');
  assert.equal((await f.recording.library.list()).items[0].availability, 'missing');
  await assert.rejects(f.recording.library.filePath(id), /recordingFileUnavailable/);
  await fs.writeFile(path, 'other-file');
  assert.equal((await f.recording.library.list()).items[0].availability, 'changed');
  await f.recording.library.remove(id);
  assert.equal(await fs.readFile(path, 'utf8'), 'other-file');
  assert.equal((await f.recording.library.list()).items.length, 0);
  await assert.rejects(f.recording.library.remove(path), /recordingEntryMissing/);
});

test('删除指定原片后同步索引，目录变更不改变旧条目的授权路径', async context => {
  const f = await fixture(context); await f.recording.start(); await f.recording.stop();
  const id = f.recording.snapshot().recordingId;
  const path = await f.recording.library.filePath(id);
  await f.recording.configure({ directory: join(f.root, 'new-recordings') });
  assert.equal(await f.recording.library.filePath(id), path);
  await f.recording.library.remove(id);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const stored = JSON.parse(await readFile(join(f.root, 'recording-library.json'), 'utf8'));
  assert.deepEqual(stored.entries, []);
});

test('索引损坏不覆盖为新空列表，不启动输出；修正后可重新读取', async context => {
  const f = await fixture(context);
  const path = join(f.root, 'recording-library.json');
  await writeFile(path, '{invalid');
  await assert.rejects(f.recording.start(), /recordingLibraryUnavailable/);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [] }));
  assert.deepEqual((await f.recording.library.list()).items, []);
  await f.recording.start(); await f.recording.stop();
});

test('列表分页只检查本页已登记文件，不读取视频内容', async context => {
  const fs = require('node:fs/promises');
  const f = await fixture(context); await f.recording.start(); await f.recording.stop();
  const path = join(f.root, 'recording-library.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.entries = Array.from({ length: 55 }, (_, index) => {
    const id = `12345678-1234-1234-1234-${String(index + 1).padStart(12, '0')}`;
    return { ...stored.entries[0], id, sessionId: id, path: join(f.root, `LycanSync-test-${id}.mkv`) };
  });
  await writeFile(path, JSON.stringify(stored));
  let checks = 0;
  const { createRecordingLibrary } = require('./recording-library.cjs');
  const library = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false,
    io: { ...fs, lstat: async path => { checks++; return fs.lstat(path); } } });
  assert.equal((await library.list()).items.length, 50); assert.equal(checks, 50);
  const next = await library.list(50);
  assert.equal(next.items.length, 5); assert.equal(next.hasMore, false); assert.equal(checks, 55);
  await assert.rejects(library.list(-1), /recordingEntryMissing/);
});

test('文件IPC只信任主窗口和条目ID，删除取消不写文件，确认后再次检查活动状态', async context => {
  const f = await fixture(context); await f.recording.start(); await f.recording.stop();
  const id = f.recording.snapshot().recordingId;
  const handlers = new Map(); let response = 0; const opened = [];
  const { readFileSync } = require('node:fs');
  const { runInNewContext } = require('node:vm');
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const sandbox = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedSender: event => event.trusted === true, closing: false, mainWindow: {}, recording: f.recording,
    dialog: { showMessageBox: async () => ({ response }) },
    shell: { openPath: async path => { opened.push(path); return ''; }, showItemInFolder: path => opened.push(path) }, Error };
  runInNewContext(source.slice(source.indexOf("ipcMain.handle('recording:library'"),
    source.indexOf("ipcMain.handle('media:remote-control:authorize'")), sandbox);
  const operation = handlers.get('recording:file');
  const trusted = { trusted: true };
  await assert.rejects(operation({}, id, 'play'), /请求来源无效/);
  await assert.rejects(operation(trusted, await f.recording.library.filePath(id), 'play'), /recordingEntryMissing/);
  await assert.rejects(operation(trusted, id, 'execute'), /请求来源无效/);
  assert.equal(await operation(trusted, id, 'delete'), false);
  assert.equal((await f.recording.library.list()).items.length, 1);
  await operation(trusted, id, 'play'); assert.equal(opened.length, 1);
  response = 1;
  const starting = await f.recording.start();
  await assert.rejects(operation(trusted, starting.recordingId, 'delete'), /recordingBusy/);
  await f.recording.stop();
  sandbox.closing = true;
  await assert.rejects(operation(trusted, id, 'play'), /请求来源无效/);
  sandbox.closing = false;
  assert.equal(await operation(trusted, id, 'delete'), true);
});

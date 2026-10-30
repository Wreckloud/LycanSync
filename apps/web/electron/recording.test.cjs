const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRecording } = require('./recording.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(context, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lycan-recording-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let video = { sessionId: 'video-1' };
  let id = 0;
  const calls = [], events = [], diagnostics = [];
  const host = {
    startRecording: async (...args) => { calls.push(['start', ...args]); await writeFile(args[2], 'controlled-recorded-content'); },
    stopRecording: async (...args) => { calls.push(['stop', ...args]); return { outputFrames: 12 }; },
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

test('没有共享时明确失败，不打开音频或建立录像文件', async context => {
  const f = await fixture(context); f.setVideo(undefined);
  await assert.rejects(f.recording.start(), /recordingShareUnavailable/);
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
  await running.recording.fail(running.recording.snapshot().recordingId, 'recordingApplicationAudioUnavailable');
  assert.equal(running.recording.snapshot().phase, 'failed');
  assert.equal(running.recording.active, undefined);
  assert.equal(running.calls.filter(call => call[0] === 'releaseAudio').length, 1);
});

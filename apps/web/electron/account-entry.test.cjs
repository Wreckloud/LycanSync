const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

function fixture(failVideo = false) {
  const calls = [];
  const stop = name => async () => { calls.push(name); };
  const context = {
    audioShortcuts: { clear: stop('shortcuts') }, screenShareWindows: { closeAll: stop('viewers') },
    activityMonitor: { clearMappings: stop('activity') }, voiceOverlay: { clear: stop('overlay') },
    recording: { stopAll: stop('recording') }, nativeVideo: { current: { sessionId: 'video' },
      stop: async () => { calls.push('video'); if (failVideo) throw new Error('failed'); } },
    nativeScreenAudio: { sessionId: 'audio', stop: stop('audio') }, nativeMicrophone: { sessionId: 'microphone', stop: stop('microphone') },
    savedDiagnosticReports: { flush: stop('report') },
    writeMediaDiagnostic: Object.assign(() => {}, { flush: stop('log') }),
    Error,
  };
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function returnToAccountEntry()');
  const end = main.indexOf("ipcMain.handle('auth:return'", start);
  const leave = runInNewContext(`${main.slice(start, end)}; returnToAccountEntry`, context);
  return { leave, calls, context };
}

test('返回账号页回收每项媒体，不接触已保存凭据', async () => {
  const f = fixture();
  await f.leave();
  assert.deepEqual(f.calls, ['shortcuts', 'viewers', 'activity', 'overlay', 'recording', 'video', 'audio', 'microphone', 'report', 'log']);
});

test('一路停止失败仍继续清理声音与麦克风，并报告失败', async () => {
  const f = fixture(true);
  await assert.rejects(f.leave(), /退出时发生问题/);
  assert.deepEqual(f.calls.slice(-5), ['video', 'audio', 'microphone', 'report', 'log']);
});

test('录像尚未保存时不停止采集，也不提前完成退出', async () => {
  const f = fixture();
  let finish;
  f.context.recording.stopAll = () => new Promise(resolve => { finish = resolve; });
  const leaving = f.leave();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.includes('video'), false);
  finish();
  await leaving;
  assert.deepEqual(f.calls.slice(-5), ['video', 'audio', 'microphone', 'report', 'log']);
});

test('窗口关闭或渲染端崩溃仍等待主进程收尾，再销毁窗口', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function finishClose()');
  const end = main.indexOf('async function serveApplication', start);
  for (const fail of [false, true]) {
    let finish;
    const calls = [];
    const context = { clearTimeout() {}, closeTimer: 1, canClose: false,
      shutdownMediaResources: () => new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('failed')) : resolve(); }),
      console: { error: () => calls.push('error') },
      screenShareWindows: { closeAll: () => calls.push('viewers') }, voiceOverlay: { clear: () => calls.push('overlay') },
      mainWindow: { destroy: () => calls.push('destroy') } };
    const close = runInNewContext(`${main.slice(start, end)}; finishClose`, context);
    const closing = close();
    assert.deepEqual(calls, []);
    assert.equal(context.canClose, false);
    finish();
    await closing;
    assert.equal(calls.at(-1), 'destroy');
    assert.equal(context.canClose, true);
  }
});

test('关闭期间允许停止回放及提交当前录像人声，停止后的旧数据仍拒绝', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const handlers = new Map();
  let writes = 0, stops = 0;
  const media = { id: 'current', stopping: false, options: { microphone: true } };
  const context = { closing: true, trustedSender: event => event === 'trusted',
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    recording: { media, stopReplay: async () => { stops++; } },
    recordingVoice: { write: () => { writes++; return true; } } };
  for (const name of ['recording:voice', 'recording:replay-stop']) {
    const start = main.indexOf(`ipcMain.handle('${name}',`);
    const end = main.indexOf('\n});', start) + 4;
    runInNewContext(main.slice(start, end), context);
  }
  const write = handlers.get('recording:voice');
  assert.equal(write('trusted', 'current', 0, new Uint8Array()), true);
  assert.equal(write('trusted', 'old', 0, new Uint8Array()), false);
  assert.equal(write('untrusted', 'current', 0, new Uint8Array()), false);
  media.stopping = true;
  assert.equal(write('trusted', 'current', 0, new Uint8Array()), false);
  assert.equal(writes, 1);
  await handlers.get('recording:replay-stop')('trusted');
  assert.equal(stops, 1);
  assert.throws(() => handlers.get('recording:replay-stop')('untrusted'));
});

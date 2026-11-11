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
    Error,
  };
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function returnToAccountEntry()');
  const end = main.indexOf("ipcMain.handle('auth:return'", start);
  const leave = runInNewContext(`${main.slice(start, end)}; returnToAccountEntry`, context);
  return { leave, calls };
}

test('返回账号页回收每项媒体，不接触已保存凭据', async () => {
  const f = fixture();
  await f.leave();
  assert.deepEqual(f.calls, ['shortcuts', 'viewers', 'activity', 'overlay', 'recording', 'video', 'audio', 'microphone']);
});

test('一路停止失败仍继续清理声音与麦克风，并报告失败', async () => {
  const f = fixture(true);
  await assert.rejects(f.leave(), /退出时发生问题/);
  assert.deepEqual(f.calls.slice(-3), ['video', 'audio', 'microphone']);
});

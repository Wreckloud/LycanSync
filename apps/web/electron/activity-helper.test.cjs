const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function fixture() {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const normalizeStart = main.indexOf('function normalizeActivity(');
  const normalizeEnd = main.indexOf('function validMicrophoneSettings(', normalizeStart);
  const start = main.indexOf('function startActivityHelper(');
  const end = main.indexOf('async function loadSession(', start);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart && start >= 0 && end > start);
  const children = [];
  const readers = [];
  const activities = [];
  const restarts = [];
  const state = { process: { platform: 'win32' }, closing: false, activityHelper: undefined, activityRestartTimer: undefined,
    activityHelperPath: () => 'test-helper', existsSync: () => true,
    spawn: () => { const child = new EventEmitter(); child.stdout = {}; children.push(child); return child; },
    createInterface: () => { const reader = new EventEmitter(); readers.push(reader); return reader; },
    publishActivity: (activity) => activities.push(activity),
    setTimeout: (callback, delay) => { assert.equal(delay, 5000); restarts.push(callback); return restarts.length; } };
  // 使用正式解析与进程回调，只用事件对象替代子进程；不读取进程列表或运行 helper。
  const startHelper = runInNewContext(`${main.slice(normalizeStart, normalizeEnd)}\n${main.slice(start, end)}\nstartActivityHelper`, state);
  startHelper();
  const game = (name) => JSON.stringify({ activityType: 'GAME', activityName: name,
    startedAtEpochSeconds: Math.floor(Date.now() / 1000) });
  return { state, children, readers, activities, restarts, game };
}

test('退出与重启后旧 helper 输出不能恢复旧游戏，当前输出仍能更新', () => {
  const { children, readers, activities, restarts, game } = fixture();
  readers[0].emit('line', game('旧游戏'));
  assert.equal(activities.at(-1).name, '旧游戏');
  children[0].emit('exit');
  assert.equal(activities.at(-1), null);
  const count = activities.length;
  readers[0].emit('line', game('退出后旧输出'));
  assert.equal(activities.length, count);
  restarts[0]();
  readers[0].emit('line', game('重启后旧输出'));
  assert.equal(activities.length, count);
  readers[1].emit('line', game('当前游戏'));
  assert.equal(activities.at(-1).name, '当前游戏');
});

test('关闭期间不再发布活动；非法单行被忽略，合法清除仍生效', () => {
  const { state, readers, activities, game } = fixture();
  readers[0].emit('line', '{broken');
  assert.equal(activities.length, 0);
  readers[0].emit('line', game('游戏'));
  readers[0].emit('line', JSON.stringify({ activityType: null }));
  assert.equal(activities.at(-1), null);
  state.closing = true;
  const count = activities.length;
  readers[0].emit('line', game('关闭后输出'));
  assert.equal(activities.length, count);
});

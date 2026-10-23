const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { createActivityHelper, normalizeActivity, normalizeMappings } = require('./activity-helper.cjs');

function fixture(enabled = true) {
  const children = [];
  const readers = [];
  const activities = [];
  const timers = new Map();
  let timerId = 0;
  const monitor = createActivityHelper({ enabled, executablePath: () => 'test-helper',
    onActivity: (activity) => activities.push(activity), fileExists: () => true,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = {};
      child.commands = [];
      child.stdin = new EventEmitter();
      child.stdin.write = (line, callback) => { child.commands.push(JSON.parse(line)); callback?.(); };
      child.kill = () => child.emit('exit');
      children.push(child);
      return child;
    },
    openLines: () => {
      const reader = new EventEmitter();
      reader.close = () => {};
      readers.push(reader);
      return reader;
    },
    schedule: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    cancel: (id) => timers.delete(id),
  });
  monitor.start();
  const reply = (index, command, result = {}) => readers[index].emit('line', JSON.stringify({ requestId: command.requestId, ...result }));
  const activity = (index, name, type = 'GAME', configurationId = children[index].commands.findLast((command) => command.method === 'configure').requestId) => {
    readers[index].emit('line', JSON.stringify({ configurationId, activityType: name ? type : null,
      activityName: name, startedAtEpochSeconds: Math.floor(Date.now() / 1000) }));
  };
  if (enabled) reply(0, children[0].commands[0]);
  return { monitor, children, readers, activities, timers, reply, activity };
}

test('采集分类只查所选程序，不受当前动态影响，也不暴露路径给动态订阅者', async () => {
  const { monitor, children, activities, reply, activity } = fixture();
  try {
    activity(0, '另一个游戏');
    const before = activities.length;
    const query = monitor.isCaptureGame('C:\\Games\\selected.exe');
    const command = children[0].commands.at(-1);
    assert.equal(command.method, 'captureGame');
    assert.equal(command.executable, 'C:\\Games\\selected.exe');
    reply(0, command, { game: true });
    assert.equal(await query, true);
    const ordinary = monitor.isCaptureGame('C:\\Apps\\app.exe');
    reply(0, children[0].commands.at(-1), { game: false });
    assert.equal(await ordinary, false);
    assert.equal(activities.length, before);
    await assert.rejects(monitor.isCaptureGame('relative.exe'), /obsCaptureGameDetectionFailed/);
  } finally { monitor.stop(); }
});

test('诊断只返回现存子进程，停止请求后仍保留至真正关闭，不启动或重建helper', () => {
  const { monitor, children } = fixture();
  assert.deepEqual(monitor.diagnosticProcesses(), [children[0]]);
  monitor.stop();
  assert.deepEqual(monitor.diagnosticProcesses(), [children[0]]);
  children[0].emit('close');
  assert.deepEqual(monitor.diagnosticProcesses(), []);
  assert.equal(children.length, 1);
  const unsupported = fixture(false);
  assert.deepEqual(unsupported.monitor.diagnosticProcesses(), []);
  assert.equal(unsupported.children.length, 0);
});

test('分类响应缺失、超时或配置切换时明确失败，不把未知当普通窗口', async () => {
  const { monitor, children, timers, reply } = fixture();
  try {
    const invalid = assert.rejects(monitor.isCaptureGame('C:\\Games\\a.exe'), /obsCaptureGameDetectionFailed/);
    reply(0, children[0].commands.at(-1), {});
    await invalid;
    const stale = assert.rejects(monitor.isCaptureGame('C:\\Games\\a.exe'), /obsCaptureGameDetectionFailed/);
    const query = children[0].commands.at(-1);
    monitor.clearMappings();
    reply(0, children[0].commands.at(-1));
    reply(0, query, { game: true });
    await stale;
    const timeout = assert.rejects(monitor.isCaptureGame('C:\\Games\\a.exe'), /obsCaptureGameDetectionFailed/);
    [...timers.values()].find((entry) => entry.delay === 10_000).callback();
    await timeout;
  } finally { monitor.stop(); }
});

test('退出、重启及配置变化后旧 helper 输出不能恢复活动', async () => {
  const { monitor, children, readers, activities, timers, reply, activity } = fixture();
  try {
    activity(0, '旧游戏');
    assert.equal(activities.at(-1).name, '旧游戏');
    children[0].emit('exit');
    assert.equal(activities.at(-1), null);
    const count = activities.length;
    activity(0, '退出后的旧游戏');
    assert.equal(activities.length, count);
    [...timers.values()].find((timer) => timer.delay === 5000).callback();
    reply(1, children[1].commands[0]);
    activity(0, '重启后的旧游戏');
    assert.equal(activities.length, count);
    activity(1, '新音乐', 'MUSIC');
    assert.equal(activities.at(-1).type, 'MUSIC');
    const previousId = children[1].commands.at(-1).requestId;
    const configuring = monitor.configure([{ executable: 'c:\\games\\game.exe', name: '自定义' }]);
    assert.equal(activities.at(-1), null);
    activity(1, '旧配置', 'GAME', previousId);
    assert.equal(activities.at(-1), null);
    reply(1, children[1].commands.at(-1));
    await configuring;
    activity(1, '自定义');
    assert.equal(activities.at(-1).name, '自定义');
    readers[1].emit('line', '{broken');
    assert.equal(activities.at(-1).name, '自定义');
  } finally { monitor.stop(); }
});

test('停止后旧消息不能重新发布，待处理窗口请求明确失败且不重启', async () => {
  const { monitor, activities, timers, activity } = fixture();
  activity(0, '游戏');
  const querying = monitor.listWindows();
  const rejected = assert.rejects(querying, /已停止/);
  monitor.stop();
  await rejected;
  activity(0, '迟到游戏');
  assert.equal(activities.at(-1), null);
  assert.equal(timers.size, 0);
});

test('清除账号名称先清空动态，旧配置无权恢复；下一进程只恢复空配置', async () => {
  const { monitor, children, activities, timers, reply, activity } = fixture();
  try {
    const configuring = monitor.configure([{ executable: 'c:\\game.exe', name: '账号 A' }]);
    reply(0, children[0].commands.at(-1));
    await configuring;
    const previousId = children[0].commands.at(-1).requestId;
    activity(0, '账号 A');
    monitor.clearMappings();
    assert.equal(activities.at(-1), null);
    activity(0, '账号 A', 'GAME', previousId);
    assert.equal(activities.at(-1), null);
    reply(0, children[0].commands.at(-1));
    children[0].emit('exit');
    [...timers.values()].find((timer) => timer.delay === 5000).callback();
    assert.deepEqual(children[1].commands[0].mappings, []);
  } finally { monitor.stop(); }
});

test('窗口清单通过固定命令返回，名称映射不上传或执行程序', async () => {
  const { monitor, children, reply } = fixture();
  try {
    const querying = monitor.listWindows();
    const command = children[0].commands.at(-1);
    assert.equal(command.method, 'windows');
    reply(0, command, { windows: [{ executable: 'c:\\game.exe', title: '游戏 - 私人房间' }] });
    assert.deepEqual(await querying, [{ executable: 'c:\\game.exe', title: '游戏 - 私人房间' }]);
    const invalid = monitor.listWindows();
    reply(0, children[0].commands.at(-1), { windows: [{ executable: 'not-an-executable', title: '无效' }] });
    await assert.rejects(invalid, /窗口列表无效/);
  } finally { monitor.stop(); }
});

test('配置失败和超时不会接受旧结果，后续重启恢复上次配置', async () => {
  const { monitor, children, readers, activities, timers, reply, activity } = fixture();
  try {
    const configuring = monitor.configure([{ executable: 'c:\\game.exe', name: '未成功' }]);
    const command = children[0].commands.at(-1);
    const rejected = assert.rejects(configuring, /无法读取/);
    reply(0, command, { error: '无法读取运行窗口' });
    await rejected;
    activity(0, '未成功');
    assert.equal(activities.at(-1) ?? null, null);
    [...timers.values()].find((timer) => timer.delay === 5000).callback();
    assert.deepEqual(children[1].commands[0].mappings, []);
    reply(1, children[1].commands[0]);
    const querying = monitor.listWindows();
    const timeoutRejected = assert.rejects(querying, /超时/);
    [...timers.values()].find((timer) => timer.delay === 10000).callback();
    await timeoutRejected;
    readers[1].emit('line', JSON.stringify({ requestId: children[1].commands.at(-1).requestId, windows: [] }));
  } finally { monitor.stop(); }
});

test('并发新配置胜出，旧确认不能改变新配置；重复活动不广播', async () => {
  const { monitor, children, activities, reply, activity } = fixture();
  try {
    const old = monitor.configure([{ executable: 'c:\\old.exe', name: '旧' }]);
    const oldCommand = children[0].commands.at(-1);
    const rejected = assert.rejects(old, /新的操作替换/);
    const current = monitor.configure([{ executable: 'c:\\new.exe', name: '新' }]);
    reply(0, oldCommand);
    reply(0, children[0].commands.at(-1));
    await rejected;
    await current;
    activity(0, '新');
    const count = activities.length;
    activity(0, '新');
    assert.equal(activities.length, count);
  } finally { monitor.stop(); }
});

test('非 Windows 明确不支持，不生成子进程', async () => {
  const { monitor, children } = fixture(false);
  await assert.rejects(monitor.listWindows(), /仅支持 Windows/);
  await assert.rejects(monitor.configure([]), /仅支持 Windows/);
  assert.equal(children.length, 0);
});

test('活动与名称设置仅允许有界合法字段', () => {
  const event = { activityType: 'MUSIC', activityName: '歌曲', startedAtEpochSeconds: Math.floor(Date.now() / 1000) };
  assert.equal(normalizeActivity(event).type, 'MUSIC');
  assert.equal(normalizeActivity({ ...event, activityType: 'OTHER' }), undefined);
  assert.equal(normalizeActivity({ ...event, activityName: 'x'.repeat(81) }), undefined);
  assert.equal(normalizeActivity({ ...event, startedAtEpochSeconds: 0 }), undefined);
  assert.deepEqual(normalizeMappings([{ executable: 'C:/Game/App.exe', name: ' 名称 ' }]), [{ executable: 'c:\\game\\app.exe', name: '名称' }]);
  assert.throws(() => normalizeMappings([{ executable: 'c:\\game.exe', name: '' }]), /设置无效/);
  assert.throws(() => normalizeMappings([{ executable: 'game.exe', name: '游戏' }]), /设置无效/);
});

test('窗口/名称 IPC 仅接受启动完成后的可信页面，preload 不开放通用进程操作', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('activity:current'");
  const end = main.indexOf("ipcMain.handle('media:capabilities'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const calls = [];
  const state = { closing: false, startupReady: false, currentActivity: null,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    trustedSender: (event) => event.trusted,
    activityMonitor: { listWindows: async () => { calls.push('windows'); return []; },
      configure: async (mappings) => { calls.push(mappings); } } };
  runInNewContext(main.slice(start, end), state);
  for (const channel of ['activity:windows', 'activity:configure']) {
    const callback = handlers.get(channel);
    assert.throws(() => callback({ trusted: true }, []), /请求来源无效/);
    state.startupReady = true;
    assert.throws(() => callback({ trusted: false }, []), /请求来源无效/);
    state.startupReady = false;
  }
  assert.deepEqual(calls, []);
  state.startupReady = true;
  await handlers.get('activity:windows')({ trusted: true });
  await handlers.get('activity:configure')({ trusted: true }, []);
  assert.deepEqual(calls, ['windows', []]);
  state.closing = true;
  assert.throws(() => handlers.get('activity:windows')({ trusted: true }), /请求来源无效/);
  const preload = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  assert.ok(preload.includes("listActivityWindows: () => ipcRenderer.invoke('activity:windows')"));
  assert.ok(preload.includes("configureActivityMappings: (mappings) => ipcRenderer.invoke('activity:configure', mappings)"));
});

test('旧账号清理失败不能中断新账号已确认的配置', async () => {
  const { monitor, children, activities, reply, activity } = fixture();
  try {
    monitor.clearMappings();
    const clearing = children[0].commands.at(-1);
    const configuring = monitor.configure([{ executable: 'c:\\new.exe', name: '新账号' }]);
    reply(0, clearing, { error: '旧清理失败' });
    reply(0, children[0].commands.at(-1));
    await configuring;
    await Promise.resolve();
    activity(0, '新账号');
    assert.equal(activities.at(-1).name, '新账号');
    assert.equal(children.length, 1);
  } finally { monitor.stop(); }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { leagueCaptureApplication, createLeagueCaptureFollow } = require('./league-capture.cjs');

const target = (windowId, executable) => ({ kind: 'window', windowId, executable, processId: Number(windowId),
  processCreationTime: windowId, lifetimeName: `Local\\LycanSync.WindowLifetime.1.2.3.${windowId}` });

test('新增主进程模块同时进入安装包白名单与安装包读取校验', () => {
  const builder = readFileSync(join(__dirname, '../electron-builder.cjs'), 'utf8');
  const packaging = readFileSync(join(__dirname, 'package-desktop.cjs'), 'utf8');
  assert.ok(builder.includes("'electron/league-capture.cjs'"));
  assert.ok(packaging.includes("'electron/league-capture.cjs'"));
});

function fixture() {
  let state = { alive: true, closed: false };
  let next = 0;
  let inspections = 0;
  const windows = new Map();
  const minimized = new Map();
  const lobby = target('1', 'D:\\Games\\League\\LeagueClientUx.exe');
  windows.set('window:1:0', lobby);
  const follow = createLeagueCaptureFollow({ discoveryState: () => state, createId: () => `follow-${++next}`,
    listSources: async () => ({ sources: [...windows.keys()].map(sourceId => ({ kind: 'window', sourceId })) }),
    inspectSource: async sourceId => {
      inspections++;
      const selected = windows.get(sourceId) ?? minimized.get(sourceId);
      if (!selected) throw new Error('videoSourceExpired');
      return selected;
    } });
  const id = follow.begin('window:1:0', lobby);
  return { follow, id, windows, minimized, lobby, inspections: () => inspections, restart: () => { state = { alive: true, closed: false }; } };
}

test('只识别大厅及其 Game 子目录中的对局，不扩大到 Riot、WeGame 或任意同名游戏', () => {
  assert.deepEqual(leagueCaptureApplication('D:/Games/League/LeagueClientUx.exe'), { root: 'd:\\games\\league', phase: 'lobby' });
  assert.deepEqual(leagueCaptureApplication('d:\\GAMES\\League\\Game\\League of Legends.exe'), { root: 'd:\\games\\league', phase: 'match' });
  for (const executable of ['C:\\Riot\\RiotClientServices.exe', 'C:\\WeGame.exe',
    'D:\\Games\\League of Legends.exe', 'LeagueClient.exe', null]) assert.equal(leagueCaptureApplication(executable), null);
});

test('同一安装的对局优先，大厅一直存在也能切换；对局退出后返回原大厅', async () => {
  const f = fixture();
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:1:0' });
  const game = target('2', 'D:\\Games\\League\\Game\\League of Legends.exe');
  f.windows.set('window:2:0', game);
  f.windows.set('window:2:1', target('3', 'E:\\OtherLeague\\Game\\League of Legends.exe'));
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:2:0' });
  f.follow.bind(f.id, 'window:2:0', game);
  f.windows.delete('window:2:0');
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:1:0' });
  assert.throws(() => f.follow.bind(f.id, 'window:2:1', f.windows.get('window:2:1')), /TargetInvalid/);
});

test('同一窗口恢复后来源 ID 改变不重采，同名新实例必须重新绑定', async () => {
  const f = fixture();
  f.windows.delete('window:1:0');
  f.windows.set('window:3:0', { ...f.lobby });
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:1:0' });
  f.windows.clear();
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: null });
  f.windows.set('window:4:0', { ...f.lobby, lifetimeName: f.lobby.lifetimeName + '9' });
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:4:0' });
});

test('对局切后台或最小化后保留原实例，只有关闭后才返回仍存在的大厅', async () => {
  const f = fixture();
  const game = target('2', 'D:\\Games\\League\\Game\\League of Legends.exe');
  f.follow.bind(f.id, 'window:2:0', game);
  f.minimized.set('window:2:0', game);
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:2:0' });
  f.minimized.clear();
  assert.deepEqual(await f.follow.findSource(f.id), { sourceId: 'window:1:0' });
});

test('取消、helper 重启和多实例歧义不会继续选择或接管其他来源', async () => {
  const f = fixture();
  f.windows.set('window:2:0', target('2', 'D:\\Games\\League\\Game\\League of Legends.exe'));
  f.windows.set('window:2:1', target('3', 'D:\\Games\\League\\Game\\League of Legends.exe'));
  await assert.rejects(f.follow.findSource(f.id), /TargetAmbiguous/);
  f.follow.end(f.id);
  await assert.rejects(f.follow.findSource(f.id), /Unavailable/);
  const id = f.follow.begin('window:1:0', f.lobby);
  f.restart();
  await assert.rejects(f.follow.findSource(id), /Unavailable/);
});

test('重复扫描只检查新实例；取消后的迟到枚举不返回目标', async () => {
  const f = fixture();
  await f.follow.findSource(f.id);
  await f.follow.findSource(f.id);
  assert.equal(f.inspections(), 3);
  const pending = assert.rejects(f.follow.findSource(f.id), /Cancelled/);
  f.follow.end(f.id);
  await pending;
});

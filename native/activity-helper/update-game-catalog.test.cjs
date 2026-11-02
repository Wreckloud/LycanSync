const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog } = require('./update-game-catalog.cjs');

function application(executables = [{ os: 'win32', name: 'Game.exe', is_launcher: false }]) {
  return { id: '123', name: 'Game', executables,
    third_party_skus: [{ distributor: 'steam', id: '456' }] };
}

test('仅导入 Windows，保留参数条件并由数据修正客户端角色与中文名', () => {
  const games = buildCatalog([application([
    { os: 'darwin', name: 'Game.app' },
    { os: 'win32', name: 'Client.exe', is_launcher: true },
    { os: 'win32', name: '>Javaw.exe', arguments: 'game.Main' },
  ])], { 123: { nameZhCn: '中文游戏', executables: [
    { name: 'client.exe', role: 'client' },
    { name: 'Game/Game.exe', role: 'game' },
  ] } });
  assert.equal(games.length, 1);
  assert.equal(games[0].name_zh_cn, '中文游戏');
  assert.deepEqual(games[0].install_keys, ['steam:456']);
  assert.deepEqual(games[0].executables, [
    { path: 'client.exe', role: 'client' },
    { path: 'game\\game.exe', role: 'game' },
    { path: 'javaw.exe', role: 'game', arguments: 'game.Main' },
  ]);
});

test('拒绝无效路径、重复 ID 和已失去上游身份的修正', () => {
  for (const name of ['../game.exe', 'C:/game.exe', 'folder//game.exe', '*.exe']) {
    assert.throws(() => buildCatalog([application([{ os: 'win32', name }])], {}), /无效/);
  }
  assert.throws(() => buildCatalog([application(), application()], {}), /重复/);
  assert.throws(() => buildCatalog([application()], { 999: { nameZhCn: '错配游戏' } }), /不在上游/);
  assert.throws(() => buildCatalog([], {}), /非空/);
});

test('保留上游启动器角色，不把缺失参数条件变成无条件规则', () => {
  const [game] = buildCatalog([application([
    { os: 'win32', name: 'Launcher.exe', is_launcher: true },
    { os: 'win32', name: '>Javaw.exe', arguments: 'game.Main' },
  ])], {});
  assert.equal(game.executables.find((rule) => rule.path === 'launcher.exe').role, 'launcher');
  assert.equal(game.executables.find((rule) => rule.path === 'javaw.exe').arguments, 'game.Main');
  assert.throws(() => buildCatalog([application([
    { os: 'win32', name: '>Javaw.exe', arguments: '' },
  ])], {}), /参数条件/);
});

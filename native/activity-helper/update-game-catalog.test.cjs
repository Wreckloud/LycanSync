const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, applyNames, compactName, installDisplayNames } = require('./update-game-catalog.cjs');

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

test('普通应用修正保留动态规则，后续更新不重新标为游戏程序', () => {
  const source = application([{ os: 'win32', name: 'bin/krita.exe' }]);
  const [game] = buildCatalog([source], { 123: { executables: [{ name: 'bin/krita.exe', role: 'application' }] } });
  assert.deepEqual(game.executables, [{ path: 'bin\\krita.exe', role: 'application' }]);
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

test('通过稳定标识关联中文，人工修正优先；刷新移除失效翻译而不保留旧值', () => {
  const names = { 'steam:456': { name: '批量中文' } };
  const games = buildCatalog([application()], {}, names);
  assert.equal(games[0].name_zh_cn, '批量中文');
  assert.equal(buildCatalog([application()], { 123: { nameZhCn: '人工修正' } }, names)[0].name_zh_cn, '人工修正');
  assert.equal(applyNames(games, {}, {})[0].name_zh_cn, undefined);
  const unrelated = { ...application(), id: '999', name: 'Game', third_party_skus: [] };
  assert.equal(buildCatalog([unrelated], {}, names)[0].name_zh_cn, undefined);
});

test('一个条目的多个商店标识指向不同中文名时不猜版本', () => {
  const game = application();
  game.third_party_skus.push({ distributor: 'steam', id: '789' });
  const [result] = buildCatalog([game], {}, {
    'steam:456': { name: '本体' }, 'steam:789': { name: '另一版本' },
  });
  assert.equal(result.name_zh_cn, undefined);
});

test('紧凑展示仅去掉完整重复的英文，保留版本、编号及通行英文名', () => {
  assert.equal(compactName('中文游戏 Game Name', 'Game Name'), '中文游戏');
  assert.equal(compactName('Game Name 中文游戏', 'Game Name'), '中文游戏');
  assert.equal(compactName('中文游戏 - Game Name', 'Game Name'), '中文游戏');
  assert.equal(compactName('Game Name / 中文游戏', 'Game Name'), '中文游戏');
  assert.equal(compactName('中文游戏 / Game Name 试玩版', 'Game Name'), '中文游戏 试玩版');
  assert.equal(compactName('中文游戏 Game Name 试玩版', 'Game Name'), '中文游戏 试玩版');
  assert.equal(compactName('中文重制版（Game Name Remake）', 'Game Name Remake'), '中文重制版');
  assert.equal(compactName('中文 III S 2023 决定版', 'Game'), '中文 III S 2023 决定版');
  assert.equal(compactName('PEAK', 'PEAK'), 'PEAK');
  assert.equal(compactName('中文 Game+', 'Game+'), '中文');
});

test('显式英文展示名可以优先于中文名，名称来源与错误安装关联由数据校正', () => {
  const source = application();
  source.third_party_skus.push({ distributor: 'steam', id: '789' });
  const [game] = buildCatalog([source], { 123: { installKeys: ['steam:456'], displayName: 'PEAK' } }, {
    'steam:456': { name: '某个中文别称' }, 'steam:789': { name: '无关游戏' },
  });
  assert.deepEqual(game.install_keys, ['steam:456']);
  assert.equal(game.display_name, 'PEAK');
  assert.throws(() => buildCatalog([source], { 123: { nameInstallKey: 'steam:999' } }), /不属于/);
});

test('按已核对的主条目取名，安装版试玩名称不被本篇短名覆盖', () => {
  const source = { ...application(), name: 'Game Name', third_party_skus: [
    { distributor: 'steam', id: '456' }, { distributor: 'steam', id: '789' },
  ] };
  const names = { 'steam:456': { name: '中文 Game Name' }, 'steam:789': { name: '中文 Game Name 试玩版' } };
  const overrides = { 123: { nameInstallKey: 'steam:456', displayName: '中文短名' } };
  const games = buildCatalog([source], overrides, names);
  const displays = installDisplayNames(games, overrides, names);
  assert.equal(games[0].display_name, '中文短名');
  assert.equal(displays['steam:456'], '中文短名');
  assert.equal(displays['steam:789'], '中文 试玩版');
  assert.equal(names['steam:789'].name, '中文 Game Name 试玩版');
});

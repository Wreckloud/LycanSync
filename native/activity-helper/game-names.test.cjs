const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNames } = require('./game-names.cjs');

function wiki(id, name, language = 'zh-hans', entity = 'Q1') {
  return { steam: { value: String(id) }, item: { value: `http://www.wikidata.org/entity/${entity}` },
    name: { value: name, 'xml:lang': language } };
}

test('Steam 简体商店名称优先，原名仍为英文时使用明确关联的中文标签', () => {
  const snapshot = buildNames([
    { appid: 1, success: 1, name: '商店中文' },
    { appid: 2, success: 1, name: 'English Title' },
  ], [wiki(1, '社区中文'), wiki(2, '繁體標籤', 'zh'), wiki(2, '简体标签')]);
  assert.equal(snapshot.names['steam:1'].name, '商店中文');
  assert.equal(snapshot.names['steam:1'].source, 'steam');
  assert.equal(snapshot.names['steam:2'].name, '简体标签');
  assert.equal(snapshot.names['steam:2'].source, 'wikidata');
});

test('相同 AppID 的实体冲突不猜测，查询不到商店条目时仍保留可靠中文', () => {
  const snapshot = buildNames([{ appid: 3, success: 2 }], [
    wiki(1, '原版', 'zh-hans', 'Q1'), wiki(1, '重制版', 'zh-hans', 'Q2'),
    wiki(3, '下架游戏', 'zh-hans', 'Q3'),
  ]);
  assert.equal(snapshot.names['steam:1'], undefined);
  assert.equal(snapshot.names['steam:3'].name, '下架游戏');
  assert.equal(snapshot.sources.wikidata.conflicting_appids, 1);
});

test('不把英文、控制字符或超长名称冒充中文；错误身份响应明确失败', () => {
  const rows = [wiki(1, '可靠中文')];
  const snapshot = buildNames([
    { appid: 1, success: 1, name: 'English' }, { appid: 2, success: 1, name: '错误\n名称' },
    { appid: 3, success: 1, name: '长'.repeat(81) }, { appid: 4, success: 1, name: '信長の野望' },
  ], rows);
  assert.equal(snapshot.names['steam:1'].name, '可靠中文');
  assert.equal(snapshot.names['steam:2'], undefined);
  assert.equal(snapshot.names['steam:3'], undefined);
  assert.equal(snapshot.names['steam:4'], undefined);
  assert.throws(() => buildNames([{ appid: 1, success: 1 }, { appid: 1, success: 1 }], rows), /AppID/);
  assert.throws(() => buildNames([], rows), /为空/);
});

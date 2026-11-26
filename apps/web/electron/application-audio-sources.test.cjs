const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationAudioSources } = require('./application-audio-sources.cjs');

test('未开窗口的自定义程序不列出，进程重启后撤销旧选择', () => {
  const chrome = { executable: 'chrome.exe', pid: 9, creation: '1234', windowTitle: '测试窗口' };
  let snapshot = [chrome, { executable: 'unlisted.exe', pid: 3, creation: '2345' }];
  const sources = createApplicationAudioSources(() => snapshot);
  const [first] = sources.list();
  assert.deepEqual(sources.list(), [first]);
  assert.deepEqual(Object.keys(first).sort(), ['application', 'id', 'name']);
  assert.equal(sources.resolve(first.id), chrome);
  snapshot = [{ ...chrome, creation: '3456' }];
  const [next] = sources.list();
  assert.notEqual(next.id, first.id);
  assert.throws(() => sources.resolve(first.id), /applicationAudioSourceExpired/);
  assert.throws(() => sources.resolve('9'), /applicationAudioSourceExpired/);
});

test('更多音源允许有窗口的自定义程序，只把通用标识用于发布', () => {
  const player = { executable: 'my-player.exe', pid: 37, creation: '440', windowTitle: '我的歌单' };
  let snapshot = [player];
  const sources = createApplicationAudioSources(() => snapshot);
  const [choice] = sources.list();
  assert.deepEqual(choice, { id: choice.id, application: 'other', name: 'my-player · 我的歌单' });
  assert.equal(sources.resolve(choice.id), player);
  snapshot = [];
  assert.deepEqual(sources.list(), []);
  assert.throws(() => sources.resolve(choice.id), /applicationAudioSourceExpired/);
});

test('浏览器隐藏后台实例，同名窗口在本地可区分', () => {
  const chrome = { executable: 'chrome.exe', pid: 1, creation: '10', windowTitle: '窗口 A' };
  const sources = createApplicationAudioSources(() => [chrome, { ...chrome, pid: 2, windowTitle: '窗口 B' },
    { ...chrome, pid: 3, windowTitle: undefined }, { executable: 'vlc.exe', pid: 4, creation: '40' }]);
  assert.deepEqual(sources.list().map(source => source.name), ['Google Chrome · 窗口 A', 'Google Chrome · 窗口 B', 'VLC']);
});

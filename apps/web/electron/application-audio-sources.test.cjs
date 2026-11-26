const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationAudioSources } = require('./application-audio-sources.cjs');

test('仅允许播放器和浏览器，进程重启后撤销旧选择', () => {
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

test('浏览器隐藏后台实例，同名窗口在本地可区分', () => {
  const chrome = { executable: 'chrome.exe', pid: 1, creation: '10', windowTitle: '窗口 A' };
  const sources = createApplicationAudioSources(() => [chrome, { ...chrome, pid: 2, windowTitle: '窗口 B' },
    { ...chrome, pid: 3, windowTitle: undefined }, { executable: 'vlc.exe', pid: 4, creation: '40' }]);
  assert.deepEqual(sources.list().map(source => source.name), ['Google Chrome · 窗口 A', 'Google Chrome · 窗口 B', 'VLC']);
});

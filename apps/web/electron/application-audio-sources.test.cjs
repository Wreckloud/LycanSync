const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationAudioSources } = require('./application-audio-sources.cjs');

test('仅允许播放器和浏览器，进程重启后撤销旧选择', () => {
  const chrome = { executable: 'chrome.exe', pid: 9, creation: '1234' };
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNativeThumbnailCache } = require('./native-video-thumbnails.cjs');

test('复用整批预览，过期、窗口改变、helper 重启后重新抓取', async () => {
  let time = 0, calls = 0;
  const load = createNativeThumbnailCache(() => time);
  const state = {};
  const sources = ['10', '20'].map(windowId => ({ sourceId: `window:${windowId}:1`, windowId, kind: 'window', title: 'game' }));
  const capture = async () => {
    calls++;
    return sources.map(source => ({ id: `window:${source.windowId}:0`, type: 'window',
      thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/jpeg;base64,YQ==' } }));
  };
  const [first, second] = await Promise.all([load(state, 'window', sources, capture), load(state, 'window', sources, capture)]);
  assert.equal(calls, 1);
  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
  time = 9_999;
  await load(state, 'window', sources, capture);
  assert.equal(calls, 1);
  time = 10_000;
  await load(state, 'window', sources, capture);
  assert.equal(calls, 2);
  await load(state, 'window', [{ ...sources[0], title: 'changed' }], capture);
  assert.equal(calls, 3);
  await load({}, 'window', sources, capture);
  assert.equal(calls, 4);
});

test('失败可重试，旧 helper 的迟到结果不能恢复缓存', async () => {
  const load = createNativeThumbnailCache();
  const state = {};
  await assert.rejects(load(state, 'window', [], async () => { throw new Error('capture failed'); }));
  let finish;
  const pending = load(state, 'window', [], () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await load({}, 'window', [], async () => []);
  finish([]);
  assert.deepEqual(await pending, []);
});

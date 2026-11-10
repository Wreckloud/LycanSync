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
  await new Promise(setImmediate);
  await load(state, 'window', [{ ...sources[0], title: 'changed' }], capture);
  assert.equal(calls, 3);
  await load({}, 'window', sources, capture);
  assert.equal(calls, 4);
});

test('无关窗口变化不阻挡可见预览，短期旧图先显示且刷新合并，过久的预览不复用', async () => {
  let time = 0, calls = 0, finish;
  const load = createNativeThumbnailCache(() => time);
  const state = {};
  const sources = ['10', '20'].map(windowId => ({ sourceId: `window:${windowId}:1`, windowId, kind: 'window', title: 'app' }));
  const images = value => sources.map(source => ({ id: `window:${source.windowId}:0`, type: 'window',
    thumbnail: { isEmpty: () => false, toDataURL: () => `data:image/jpeg;base64,${value}` } }));
  await load(state, 'window', sources, async () => images('old'));
  const capture = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  time = 1_000;
  const changed = [sources[0], { ...sources[1], title: 'changed' }];
  const visible = new Set([sources[0].sourceId]);
  assert.equal((await load(state, 'window', changed, capture, visible)).length, 1);
  assert.equal(calls, 0);
  time = 10_000;
  const stale = await load(state, 'window', changed, capture, visible);
  assert.equal(stale[0].thumbnail, 'data:image/jpeg;base64,old');
  await load(state, 'window', changed, capture, visible);
  assert.equal(calls, 1);
  finish(images('new'));
  await new Promise(setImmediate);
  assert.equal((await load(state, 'window', changed, capture, visible))[0].thumbnail, 'data:image/jpeg;base64,new');
  time = 70_001;
  let resolved = false;
  const expired = load(state, 'window', changed, capture, visible).then(value => { resolved = true; return value; });
  await new Promise(setImmediate);
  assert.equal(resolved, false);
  finish(images('fresh'));
  assert.equal((await expired)[0].thumbnail, 'data:image/jpeg;base64,fresh');
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

test('新窗口慢预览不阻挡已缓存窗口，缺图后续共用原请求补齐', async () => {
  const load = createNativeThumbnailCache();
  const state = {};
  const sources = ['10', '20'].map(windowId => ({ sourceId: `window:${windowId}:1`, windowId, kind: 'window', title: 'app' }));
  const images = sources.map(source => ({ id: `window:${source.windowId}:0`, type: 'window',
    thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/jpeg;base64,YQ==' } }));
  await load(state, 'window', sources.slice(0, 1), async () => images.slice(0, 1));
  let finish, calls = 0;
  const capture = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const cached = await load(state, 'window', sources, capture);
  assert.deepEqual(cached.map(entry => entry.sourceId), [sources[0].sourceId]);
  const missing = load(state, 'window', sources, capture, new Set([sources[1].sourceId]));
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  finish(images);
  assert.deepEqual((await missing).map(entry => entry.sourceId), [sources[1].sourceId]);
});

test('预览总量受限时优先保留当前请求中的窗口', async () => {
  const load = createNativeThumbnailCache();
  const state = {};
  const sources = Array.from({ length: 20 }, (_, index) => ({ sourceId: `window:${index + 1}:1`, windowId: String(index + 1), kind: 'window', title: 'app' }));
  const images = sources.map(source => ({ id: `window:${source.windowId}:0`, type: 'window',
    thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/jpeg;base64,' + 'Y'.repeat(60 * 1024) } }));
  const last = sources.at(-1).sourceId;
  const preview = await load(state, 'window', sources, async () => images, new Set([last]));
  assert.deepEqual(preview.map(entry => entry.sourceId), [last]);
  // 上次因预算未缓存的后台窗口滚入视口时，不能被十秒缓存命中挡住。
  const newlyVisible = sources[17].sourceId;
  let calls = 0;
  const next = await load(state, 'window', sources, async () => { calls++; return images; }, new Set([newlyVisible]));
  assert.equal(calls, 1);
  assert.deepEqual(next.map(entry => entry.sourceId), [newlyVisible]);
});

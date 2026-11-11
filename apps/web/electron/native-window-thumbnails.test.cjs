const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { captureWindowThumbnail, createWindowThumbnailLoader } = require('./native-window-thumbnails.cjs');

const source = index => ({ sourceId: `window:1:${index}`, windowId: String(index + 1), title: 'window' });
const tick = () => new Promise(setImmediate);
function fixture() {
  let time = 0;
  const captures = [], events = [];
  const loader = createWindowThumbnailLoader({ executablePath: () => 'helper', now: () => time,
    inspectSource: async id => ({ id }), encode: () => 'data:image/jpeg;base64,YQ==',
    onTiming: event => events.push(event), capture: (_path, target) => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      captures.push({ target, resolve, reject });
      return { promise, cancel: () => reject(new Error('thumbnailCancelled')) };
    } });
  return { loader, captures, events, setTime: value => { time = value; } };
}

test('两个窗口独立出图，慢任务不阻挡另一槽位，重复请求合并且总并发有界', async () => {
  const f = fixture(), owner = {};
  const slow = f.loader.load(owner, source(0));
  const fast = f.loader.load(owner, source(1));
  const third = f.loader.load(owner, source(2));
  const duplicate = f.loader.load(owner, source(0));
  await tick(); assert.equal(f.captures.length, 2);
  f.captures[1].resolve({});
  assert.equal((await fast)[0].sourceId, source(1).sourceId);
  await tick(); assert.equal(f.captures.length, 3);
  f.captures[2].resolve({}); await third;
  f.captures[0].resolve({});
  assert.deepEqual(await slow, await duplicate);
  f.loader.dispose();
});

test('缓存立即返回，过期后台更新，失败不阻挡十秒，重启不接受旧预览', async () => {
  const f = fixture(), owner = {};
  const first = f.loader.load(owner, source(0)); await tick(); f.captures[0].resolve({}); await first;
  assert.equal((await f.loader.load(owner, source(0))).length, 1);
  assert.equal(f.captures.length, 1);
  f.setTime(10_001);
  assert.equal((await f.loader.load(owner, source(0))).length, 1); await tick();
  f.captures[1].reject(new Error('thumbnailTimeout')); await tick();
  assert.deepEqual(await f.loader.load(owner, source(0)), []);
  f.setTime(11_502);
  const retry = f.loader.load(owner, source(0)); await tick();
  const replacement = f.loader.load({}, source(0)); await tick();
  assert.deepEqual(await retry, []);
  f.captures.at(-1).resolve({}); assert.equal((await replacement).length, 1);
  assert.ok(f.events.some(event => event.outcome === 'timeout'));
  assert.ok(f.events.every(event => !('windowId' in event) && !('title' in event)));
  f.loader.dispose();
});

test('退出取消活动和排队任务，之后不能重新创建截图进程', async () => {
  const f = fixture(), owner = {};
  const tasks = Array.from({ length: 8 }, (_, index) => f.loader.load(owner, source(index)));
  await tick(); f.loader.dispose();
  assert.ok((await Promise.all(tasks)).every(value => value.length === 0));
  assert.equal(f.captures.length, 2);
  assert.deepEqual(await f.loader.load(owner, source(9)), []);
});

test('窗口改名不能得到旧任务的预览，排队总量限制为32', async () => {
  const f = fixture(), owner = {};
  const tasks = Array.from({ length: 32 }, (_, index) => f.loader.load(owner, source(index)));
  assert.deepEqual(await f.loader.load(owner, source(33)), []);
  assert.deepEqual(await f.loader.load(owner, { ...source(0), title: 'renamed' }), []);
  f.loader.dispose(); await Promise.all(tasks);
});

test('截图任务超时杀死自身进程并等待退出，畸形位图不能进入预览', async () => {
  let child;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
    return child;
  };
  const timeout = captureWindowThumbnail('helper', {}, { spawnProcess, timeoutMs: 5 });
  await assert.rejects(timeout.promise, /thumbnailTimeout/);
  const malformed = captureWindowThumbnail('helper', {}, { spawnProcess });
  child.stdout.write(Buffer.alloc(8)); child.emit('close', 0);
  await assert.rejects(malformed.promise, /thumbnailOutputInvalid/);
  const valid = captureWindowThumbnail('helper', {}, { spawnProcess });
  const bytes = Buffer.alloc(12); bytes.writeUInt32LE(1, 0); bytes.writeUInt32LE(1, 4);
  child.stdout.write(bytes); child.emit('close', 0);
  assert.equal((await valid.promise).bitmap.length, 4);
});

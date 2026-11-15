const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, rename } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRecordingLibrary } = require('./recording-library.cjs');
const { serveRecordingMedia } = require('./recording-media.cjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lycan-recording-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID();
  const path = join(root, `LycanSync-${id}.mkv`);
  await writeFile(path, '0123456789');
  let active = false;
  const library = createRecordingLibrary({ dataDirectory: root, isActive: () => active });
  await library.register({ id, librarySessionId: id, path });
  await library.finish({ id, saved: true });
  const request = (headers = {}, method = 'GET', suffix = id) => serveRecordingMedia(new Request(`lycan://app/recordings/${suffix}`, { headers, method }), library);
  return { request, path, active: value => { active = value; } };
}

test('录像预览支持完整读取、前后范围与 HEAD，进度跳转只返回所需字节', async t => {
  const f = await fixture(t);
  for (const [range, status, expected, contentRange] of [
    ['', 200, '0123456789', null], ['bytes=2-4', 206, '234', 'bytes 2-4/10'],
    ['bytes=7-', 206, '789', 'bytes 7-9/10'], ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=8-99', 206, '89', 'bytes 8-9/10'],
  ]) {
    const result = await f.request(range ? { Range: range } : {});
    assert.equal(result.status, status);
    assert.equal(result.headers.get('Content-Range'), contentRange);
    assert.equal(result.headers.get('Content-Length'), String(expected.length));
    assert.equal(await result.text(), expected);
  }
  const head = await f.request({}, 'HEAD');
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(await head.text(), '');
});

test('非法范围、未知记录、正在写入或被替换的文件不能预览', async t => {
  const f = await fixture(t);
  for (const range of ['bytes=20-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) {
    assert.equal((await f.request({ Range: range })).status, 416);
  }
  assert.equal((await f.request({}, 'POST')).status, 405);
  assert.equal((await f.request({}, 'GET', randomUUID())).status, 404);
  assert.equal((await f.request({}, 'GET', 'unregistered.mkv')).status, 404);
  f.active(true);
  assert.equal((await f.request()).status, 404);
  f.active(false);
  await rename(f.path, f.path + '.old');
  await writeFile(f.path, 'replacement');
  assert.equal((await f.request()).status, 404);
});

test('关闭预览取消读取后释放文件句柄', async t => {
  const f = await fixture(t);
  await writeFile(f.path, Buffer.alloc(8 * 1024 * 1024));
  const response = await f.request();
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.byteLength <= 64 * 1024);
  await reader.cancel();
  // Windows 上仍持有读取句柄时，删除或改名会失败。
  await rename(f.path, f.path + '.closed');
});

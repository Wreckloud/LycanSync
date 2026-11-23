const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { saveChatDownload } = require('./chat-download.cjs');

test('保存聊天文件时校验完整字节，失败或取消保留原文件', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lycan-download-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const target = join(directory, '诊断.json');
  const original = Buffer.from('previous file');
  await writeFile(target, original);
  const chunks = [Buffer.alloc(64 * 1024, 65), Buffer.from([0, 255, 4])];
  const expected = Buffer.concat(chunks);
  const response = () => new Response(Readable.toWeb(Readable.from(chunks)));
  for (const size of [expected.length + 1, expected.length - 1]) {
    await assert.rejects(saveChatDownload(target, response(), size, new AbortController().signal, () => {}), /完整下载/);
    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(await readdir(directory), ['诊断.json']);
  }
  const controller = new AbortController();
  await assert.rejects(saveChatDownload(target, response(), expected.length, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.deepEqual(await readFile(target), original);
  const progress = [];
  await saveChatDownload(target, response(), expected.length, new AbortController().signal, bytes => progress.push(bytes));
  assert.equal(progress.at(-1), expected.length);
  assert.deepEqual(await readFile(target), expected);
  assert.deepEqual(await readdir(directory), ['诊断.json']);
});

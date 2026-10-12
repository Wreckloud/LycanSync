const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseAccessLink, accessLinkFromArguments } = require('./access-links.cjs');
const token = 'a'.repeat(43);

function clipboardHandler(trusted = true, closing = false, writeText = async () => {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('clipboard:write-text'");
  const end = source.indexOf('ipcMain.handle(', start + 1);
  let handler;
  vm.runInNewContext(source.slice(start, end), { ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    trustedSender: () => trusted, closing, clipboard: { writeText } });
  return handler;
}

test('clipboard bridge writes only bounded text from the trusted application', async () => {
  const copied = [];
  const handler = clipboardHandler(true, false, async (text) => { copied.push(text); });
  await handler({}, 'https://example.com/access#token=private');
  assert.deepEqual(copied, ['https://example.com/access#token=private']);
  for (const text of [null, {}, '', 'a'.repeat(16_385)]) await assert.rejects(handler({}, text), /复制内容无效/);
  await assert.rejects(clipboardHandler(false)({}, 'text'), /请求来源无效/);
  await assert.rejects(clipboardHandler(true, true)({}, 'text'), /请求来源无效/);
});

test('clipboard bridge waits for the write and reports system failure', async () => {
  let finish;
  let done = false;
  const operation = clipboardHandler(true, false, () => new Promise((resolve) => { finish = resolve; }))({}, 'text');
  operation.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  finish();
  await operation;
  await assert.rejects(clipboardHandler(true, false, async () => { throw new Error('write denied'); })({}, 'text'), /write denied/);
});

test('invitation selects only HTTPS server and an exact credential', () => {
  const offer = parseAccessLink(`lycansync://access?server=https%3A%2F%2Fexample.com#token=${token}`);
  assert.deepEqual(offer, { server: 'https://example.com', token });
  assert.deepEqual(accessLinkFromArguments(['app.exe', `lycansync://access?server=https%3A%2F%2Fexample.com#token=${token}`]), offer);
  assert.deepEqual(accessLinkFromArguments(['app.exe', `lycansync://access/?server=https%3A%2F%2Fexample.com#token=${token}`]), offer);
});
test('rejects host, credentials, duplicate fields, paths and insecure servers', () => {
  for (const link of [
    `lycansync://other?server=https://example.com#token=${token}`,
    `lycansync://access/other?server=https://example.com#token=${token}`,
    `lycansync://access?server=http://example.com#token=${token}`,
    `lycansync://access?server=https://example.com/api#token=${token}`,
    `lycansync://access?server=https://user:password@example.com#token=${token}`,
    `lycansync://access?server=https://example.com&server=https://other.com#token=${token}`,
    `lycansync://access?server=https://example.com#token=${token}&token=${token}`,
    `lycansync://access?server=https://example.com&extra=1#token=${token}`,
    `lycansync://access?server=https://example.com#token=short`,
  ]) assert.throws(() => parseAccessLink(link));
  assert.equal(accessLinkFromArguments(['lycansync://broken']), null);
});

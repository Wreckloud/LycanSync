const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createMediaDiagnostics } = require('./media-diagnostics.cjs');

test('故障日志串行写入并轮转，保留最近一份历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-diagnostics-'));
  try {
    const path = join(directory, 'nested', 'screen-share-error.log');
    const write = createMediaDiagnostics(path, 200);
    await Promise.all([write({ stage: 'first', message: 'a'.repeat(80) }),
      write({ stage: 'second', message: 'b'.repeat(80) }),
      write({ stage: 'third', message: 'c'.repeat(80) })]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).stage, 'third');
    assert.equal(JSON.parse(await readFile(`${path}.previous`, 'utf8')).stage, 'second');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

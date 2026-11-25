const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRecording } = require('./recording.cjs');
const { createSaveDirectories } = require('./save-directories.cjs');

test('两种保存位置分别持久化，打开所选文件夹，恢复默认后保留旧文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lycan-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const restart = () => createSaveDirectories(root, createRecording({ dataDirectory: root }));
  const directories = restart();
  const chosen = kind => join(root, 'custom', kind);
  for (const kind of ['recording', 'diagnostics']) {
    const initial = await directories.operate(kind, 'read', { allowed: () => true });
    assert.equal(initial.path, join(root, kind === 'recording' ? 'recordings' : 'exports'));
    const actions = { allowed: () => true, choose: async path => {
      assert.equal(path, initial.path);
      return chosen(kind);
    }, open: async path => { assert.equal(path, chosen(kind)); return ''; } };
    assert.equal((await directories.operate(kind, 'choose', actions)).isDefault, false);
    await directories.operate(kind, 'open', actions);
    await writeFile(join(chosen(kind), 'existing.txt'), 'existing');
  }
  const reopened = restart();
  assert.equal(await reopened.exportDirectory(), chosen('diagnostics'));
  for (const kind of ['recording', 'diagnostics']) {
    const allowed = () => true;
    assert.equal((await reopened.operate(kind, 'choose', { allowed, choose: async () => null })).path, chosen(kind));
    const restored = await reopened.operate(kind, 'reset', { allowed });
    assert.equal(restored.isDefault, true);
    assert.equal((await restart().operate(kind, 'read', { allowed })).path, restored.defaultPath);
    assert.equal(await readFile(join(chosen(kind), 'existing.txt'), 'utf8'), 'existing');
  }
});

test('失去授权的迟到选址不会写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lycan-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = createSaveDirectories(root, createRecording({ dataDirectory: root }));
  let active = true;
  await assert.rejects(directories.operate('diagnostics', 'choose', { allowed: () => active,
    choose: async () => { active = false; return join(root, 'custom'); } }), /已结束/);
  assert.equal(await directories.exportDirectory(), join(root, 'exports'));
});

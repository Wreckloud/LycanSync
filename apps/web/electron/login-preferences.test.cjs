const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { createLoginPreferences } = require('./login-preferences.cjs');

test('自动登录默认开启，选择按服务器和账号保存，不保存凭据', async () => {
  const directory = await mkdtemp(resolve(__dirname, '../../../release/test-cache/login-'));
  try {
    const file = resolve(directory, 'login-settings.json');
    const preferences = createLoginPreferences(file, 'https://one.example');
    assert.deepEqual(await preferences.get('member'), { enabled: true, manualEntryRequired: false });
    await preferences.set('member', false, false);
    assert.deepEqual(await createLoginPreferences(file, 'https://one.example').get('member'), { enabled: false, manualEntryRequired: false });
    assert.deepEqual(await preferences.get('another'), { enabled: true, manualEntryRequired: false });
    assert.deepEqual(await createLoginPreferences(file, 'https://two.example').get('member'), { enabled: true, manualEntryRequired: false });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      server: 'https://one.example', accountId: 'member', autoLogin: false, manualEntryRequired: false,
    });
    await Promise.all([preferences.set('member', true, false), preferences.set('member', false, false)]);
    assert.deepEqual(await preferences.get('member'), { enabled: false, manualEntryRequired: false });
    await writeFile(file, '{broken', 'utf8');
    await assert.rejects(preferences.get('member'), /无法读取/);
    await preferences.set('member', false, false);
    assert.deepEqual(await preferences.get('member'), { enabled: false, manualEntryRequired: false });
    assert.throws(() => preferences.set('member', 'false', false), /无效/);
    assert.throws(() => preferences.get({}), /无效/);
    await preferences.set('member', true, true);
    assert.deepEqual(await preferences.get('member'), { enabled: true, manualEntryRequired: true });
    await preferences.clear();
    await preferences.clear();
    assert.deepEqual(await preferences.get('member'), { enabled: true, manualEntryRequired: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

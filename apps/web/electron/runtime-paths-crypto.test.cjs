const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const { migrateOwnedData } = require('./runtime-paths.cjs');

test('Windows 真实 safeStorage 在目录迁移及误迁移修复后均可解密，不启动业务客户端',
  { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'lycansync-crypto-migration-'));
    const old = join(root, 'old'), fresh = join(root, 'fresh'), broken = join(root, 'broken');
    const probe = (profile, mode, expectedCode = 0) => {
      mkdirSync(profile, { recursive: true });
      const result = spawnSync(require('electron'), [`--user-data-dir=${profile}`,
        resolve(__dirname, 'runtime-paths-crypto/main.cjs'), mode],
      { encoding: 'utf8', windowsHide: true, timeout: 12000 });
      if (result.error) throw result.error;
      assert.equal(result.status, expectedCode, result.stderr);
      const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('{'));
      assert.ok(line, '加密验证必须返回固定结果');
      return JSON.parse(line);
    };
    try {
      probe(old, 'seed');
      mkdirSync(fresh);
      migrateOwnedData(old, fresh);
      assert.equal(probe(fresh, 'check').fixtureMatches, true);
      probe(broken, 'seed');
      const previousState = readFileSync(join(broken, 'Local State'));
      copyFileSync(join(old, 'session.bin'), join(broken, 'session.bin'));
      assert.deepEqual(probe(broken, 'check', 1), { decrypted: false });
      migrateOwnedData(old, broken);
      assert.equal(probe(broken, 'check').fixtureMatches, true);
      const backup = JSON.parse(readFileSync(join(broken, 'Local State.before-legacy-migration')));
      assert.equal(backup.os_crypt.encrypted_key, JSON.parse(previousState).os_crypt.encrypted_key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

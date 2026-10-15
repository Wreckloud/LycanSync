const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { serverUrl, loadServerSettings, saveServerSettings } = require('./server-settings.cjs');

test('服务器地址拒绝外部 HTTP、凭据、路径和非法输入', () => {
  for (const url of ['http://192.168.150.108', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?key=1', '', null]) {
    assert.throws(() => serverUrl(url));
  }
  assert.equal(serverUrl(' https://example.com/ '), 'https://example.com');
  assert.equal(serverUrl('http://127.0.0.1:18080'), 'http://127.0.0.1:18080');
});

test('用户服务器地址在安装版和开发版一致保留，显式测试地址可覆盖', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lycansync-server-'));
  const userDirectory = join(directory, 'user');
  try {
    writeFileSync(join(directory, 'server-config.json'), JSON.stringify({ apiUrl: 'https://default.example' }));
    const options = { packaged: true, userDirectory, resourcesDirectory: directory };
    assert.equal(loadServerSettings(options), 'https://default.example');
    await saveServerSettings(userDirectory, 'https://192.168.150.108/');
    writeFileSync(join(directory, 'server-config.json'), JSON.stringify({ apiUrl: 'https://updated.example' }));
    assert.equal(loadServerSettings(options), 'https://192.168.150.108');
    assert.equal(loadServerSettings({ ...options, packaged: false }), 'https://192.168.150.108');
    assert.equal(loadServerSettings({ ...options, packaged: false, developmentUrl: 'http://127.0.0.1:18080' }), 'http://127.0.0.1:18080');
    await assert.rejects(saveServerSettings(userDirectory, 'http://external.example'));
    assert.equal(loadServerSettings(options), 'https://192.168.150.108');
    writeFileSync(join(userDirectory, 'server-config.json'), '{broken');
    assert.throws(() => loadServerSettings(options));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('显式开发地址不读取损坏或缺失的配置，安装版仍拒绝损坏配置', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lycansync-server-'));
  try {
    const options = { packaged: false, userDirectory: directory, resourcesDirectory: directory,
      developmentUrl: 'http://127.0.0.1:18080' };
    assert.equal(loadServerSettings(options), 'http://127.0.0.1:18080');
    writeFileSync(join(directory, 'server-config.json'), '{broken');
    assert.equal(loadServerSettings(options), 'http://127.0.0.1:18080');
    assert.throws(() => loadServerSettings({ ...options, packaged: true }));
    assert.throws(() => loadServerSettings({ ...options, developmentUrl: 'http://external.example' }), /HTTPS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

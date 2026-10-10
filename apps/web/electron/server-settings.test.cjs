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

test('用户服务器地址在默认配置更新后保留，开发环境仍使用开发地址', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lycansync-server-'));
  const userDirectory = join(directory, 'user');
  try {
    writeFileSync(join(directory, 'server-config.json'), JSON.stringify({ apiUrl: 'https://default.example' }));
    const options = { packaged: true, userDirectory, resourcesDirectory: directory };
    assert.equal(loadServerSettings(options), 'https://default.example');
    await saveServerSettings(userDirectory, 'https://192.168.150.108/');
    writeFileSync(join(directory, 'server-config.json'), JSON.stringify({ apiUrl: 'https://updated.example' }));
    assert.equal(loadServerSettings(options), 'https://192.168.150.108');
    assert.equal(loadServerSettings({ ...options, packaged: false, developmentUrl: 'http://127.0.0.1:18080' }), 'http://127.0.0.1:18080');
    await assert.rejects(saveServerSettings(userDirectory, 'http://external.example'));
    assert.equal(loadServerSettings(options), 'https://192.168.150.108');
    writeFileSync(join(userDirectory, 'server-config.json'), '{broken');
    assert.throws(() => loadServerSettings(options));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

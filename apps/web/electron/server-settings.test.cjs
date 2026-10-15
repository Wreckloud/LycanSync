const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { serverUrl, loadServerSettings, saveServerSettings } = require('./server-settings.cjs');
const { parseAccessLink, parseManualAccessLink } = require('./access-links.cjs');

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

function desktopSettingsFixture() {
  const handlers = new Map();
  const calls = [];
  const context = {
    closing: false, trusted: true,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    trustedSender: () => context.trusted,
    loadSession: async () => undefined,
    saveServerSettings: async () => { calls.push('save'); },
    parseAccessLink, parseManualAccessLink,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value) },
    mkdir: async () => {}, writeFile: async () => {}, accessLinkFile: 'pending-access.bin',
    app: { getPath: () => 'test-profile', relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') },
  };
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('auth:clear'");
  assert.ok(start > 0);
  // 执行主进程正式设置回调；替代文件写入和退出，不启动 Electron 或访问真实用户目录。
  runInNewContext(main.slice(start), context);
  return { handlers, context, calls };
}

const offer = { server: 'https://example.test', token: 'a'.repeat(43) };
const settingsInputs = new Map([
  ['settings:server:set', offer.server],
  ['auth:access:prepare', offer],
]);

for (const [name, input] of settingsInputs) {
  test(`${name}：正常保存后才安排重启`, async () => {
    const { handlers, calls } = desktopSettingsFixture();
    await handlers.get(name)({}, input);
    assert.deepEqual(calls, ['save', 'relaunch', 'quit']);
  });

  test(`${name}：保存期间关窗或失去来源时不再重启`, async () => {
    for (const change of ['closing', 'sender']) {
      const { handlers, context, calls } = desktopSettingsFixture();
      let complete;
      let started;
      const entered = new Promise((resolve) => { started = resolve; });
      context.saveServerSettings = async () => {
        calls.push('save'); started();
        await new Promise((resolve) => { complete = resolve; });
      };
      const saving = handlers.get(name)({}, input);
      await entered;
      if (change === 'closing') context.closing = true;
      else context.trusted = false;
      complete();
      await saving;
      assert.deepEqual(calls, ['save']);
    }
  });

  test(`${name}：保存失败保留错误且不重启`, async () => {
    const { handlers, context, calls } = desktopSettingsFixture();
    context.saveServerSettings = async () => { throw new Error('write failed'); };
    await assert.rejects(handlers.get(name)({}, input), /write failed/);
    assert.deepEqual(calls, []);
  });
}

for (const [name, input] of [...settingsInputs,
  ['auth:access:parse', `https://example.test/join#token=${offer.token}`]]) {
  test(`${name}：等待读取凭据后再次校验窗口归属`, async () => {
    const { handlers, context, calls } = desktopSettingsFixture();
    let complete;
    context.loadSession = () => new Promise((resolve) => { complete = resolve; });
    const pending = handlers.get(name)({}, input);
    context.closing = true;
    complete();
    await assert.rejects(pending, /当前不能/);
    assert.deepEqual(calls, []);
  });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const filesystem = require('node:fs');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } = filesystem;
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { applyRuntimePaths, migrateOwnedData, runtimeLayout } = require('./runtime-paths.cjs');

test('运行目录不可写时展示可操作说明并退出，不再抛出主进程异常', () => {
  const { runInNewContext } = require('node:vm');
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const failure = new Error('无法在运行目录保存数据（EPERM）：C:\\Program Files\\LycanSync\\data');
  const exited = new Error('controlled exit');
  const messages = [];
  const sandbox = { applyRuntimePaths: () => { throw failure; }, app: { commandLine: { hasSwitch: () => false } },
    process: { env: {}, exit: code => { assert.equal(code, 1); throw exited; } },
    resolve: () => 'test-project', __dirname, dialog: { showErrorBox: (...args) => messages.push(args) } };
  assert.throws(() => runInNewContext(main.slice(main.indexOf('const runtimeLayout ='), main.indexOf('const backend =')), sandbox), error => error === exited);
  assert.equal(messages.length, 1);
  assert.match(messages[0][1], /EPERM/);
  assert.match(messages[0][1], /请保留/);
});

function layoutInput(overrides = {}) {
  return {
    packaged: true,
    execPath: join('D:', 'Games', 'LycanSync', 'LycanSync.exe'),
    projectDirectory: join('D:', 'repo', 'lycan-sync'),
    appName: 'LycanSync',
    legacyRoot: join('C:', 'Users', 'someone', 'AppData', 'Roaming'),
    ...overrides,
  };
}

test('安装版运行数据放在可执行文件旁边，更新缓存也在其中', () => {
  const input = layoutInput();
  const layout = runtimeLayout(input);
  const root = join(dirname(input.execPath), 'data');
  assert.equal(layout.userData, root);
  assert.equal(layout.sessionData, root);
  assert.equal(layout.crashDumps, join(root, 'crashDumps'));
  assert.equal(layout.logs, join(root, 'logs'));
  assert.equal(layout.temp, join(root, 'tmp'));
  assert.equal(layout.updaterCachePath, join(root, 'updater'));
  assert.equal(layout.legacyUserData, join(input.legacyRoot, 'LycanSync'));
});

test('源码运行使用仓库 data/desktop，显式目录不再读取旧的用户配置', () => {
  const source = runtimeLayout(layoutInput({ packaged: false }));
  assert.equal(source.userData, join('D:', 'repo', 'lycan-sync', 'data', 'desktop'));
  const explicit = runtimeLayout(layoutInput({ packaged: false, explicitUserDataDir: join('D:', 'profiles', 'second') }));
  assert.equal(explicit.userData, resolve(join('D:', 'profiles', 'second')));
  assert.equal(explicit.legacyUserData, undefined);
  assert.equal(explicit.updaterCachePath, join(explicit.userData, 'updater'));
});

test('安装版拒绝越出安装目录的显式数据路径，允许安装目录内的隔离目录', () => {
  assert.throws(() => runtimeLayout(layoutInput({ explicitUserDataDir: join('D:', 'profiles', 'second') })), /必须位于/);
  const input = layoutInput();
  const explicit = runtimeLayout({ ...input, explicitUserDataDir: join(dirname(input.execPath), 'profiles', 'second') });
  assert.equal(explicit.userData, resolve(join(dirname(input.execPath), 'profiles', 'second')));
});

test('迁入自有配置但不覆盖已有登录，不混入旧邀请、服务器和缓存', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-runtime-'));
  const legacy = join(root, 'Roaming', 'LycanSync');
  const destination = join(root, 'install', 'data');
  try {
    mkdirSync(join(legacy, 'Cache'), { recursive: true });
    mkdirSync(join(legacy, 'obs-capture', '32.2.2'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(legacy, 'session.bin'), 'old-session');
    writeFileSync(join(legacy, 'server-config.json'), '{"apiUrl":"https://old.example"}');
    writeFileSync(join(legacy, 'pending-access.bin'), 'invite');
    writeFileSync(join(legacy, 'screen-share-error.log'), 'log');
    writeFileSync(join(legacy, 'screen-share-error.log.previous'), 'previous');
    writeFileSync(join(legacy, 'Cache', 'junk'), 'cache');
    writeFileSync(join(legacy, 'obs-capture', '32.2.2', 'basic.ini'), 'obs');
    writeFileSync(join(destination, 'session.bin'), 'kept-session');
    migrateOwnedData(legacy, destination);
    assert.equal(readFileSync(join(destination, 'session.bin'), 'utf8'), 'kept-session');
    assert.equal(existsSync(join(destination, 'server-config.json')), false);
    assert.equal(existsSync(join(destination, 'pending-access.bin')), false);
    assert.equal(readFileSync(join(destination, 'screen-share-error.log'), 'utf8'), 'log');
    assert.equal(readFileSync(join(destination, 'screen-share-error.log.previous'), 'utf8'), 'previous');
    assert.equal(readFileSync(join(destination, 'obs-capture', '32.2.2', 'basic.ini'), 'utf8'), 'obs');
    assert.equal(statSync(join(legacy, 'Cache', 'junk')).isFile(), true);
    assert.throws(() => statSync(join(destination, 'Cache')));
    migrateOwnedData(destination, destination);
    migrateOwnedData(join(root, 'missing'), destination);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 凭据迁移同时保留配套密钥，完成后退出登录不再搬回旧凭据', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-encrypted-migration-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    mkdirSync(join(legacy, 'Local Storage', 'leveldb'), { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(legacy, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'old-protected-key' } }));
    writeFileSync(join(legacy, 'session.bin'), 'old-ciphertext');
    writeFileSync(join(legacy, 'Local Storage', 'leveldb', 'fixture'), 'preferences');
    migrateOwnedData(legacy, destination);
    assert.equal(JSON.parse(readFileSync(join(destination, 'Local State'))).os_crypt.encrypted_key, 'old-protected-key');
    assert.equal(readFileSync(join(destination, 'session.bin'), 'utf8'), 'old-ciphertext');
    assert.equal(readFileSync(join(destination, 'Local Storage', 'leveldb', 'fixture'), 'utf8'), 'preferences');
    rmSync(join(destination, 'session.bin'));
    migrateOwnedData(legacy, destination, { existsSync: (path) => {
      assert.ok(path.startsWith(destination), '已完成迁移后不再访问旧目录');
      return existsSync(path);
    } });
    assert.equal(existsSync(join(destination, 'session.bin')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('已复制旧密文但生成了新密钥时，仅恢复旧密钥并备份，不覆盖其他状态', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-copied-session-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    mkdirSync(legacy); mkdirSync(destination);
    writeFileSync(join(legacy, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'old-protected-key' } }));
    const newState = JSON.stringify({ os_crypt: { encrypted_key: 'new-protected-key', retained: true }, keep: 'settings' });
    writeFileSync(join(destination, 'Local State'), newState);
    for (const directory of [legacy, destination]) writeFileSync(join(directory, 'session.bin'), 'same-ciphertext');
    migrateOwnedData(legacy, destination);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, 'Local State'))),
      { os_crypt: { encrypted_key: 'old-protected-key', retained: true }, keep: 'settings' });
    assert.equal(readFileSync(join(destination, 'Local State.before-legacy-migration'), 'utf8'), newState);
    assert.equal(readFileSync(join(destination, 'session.bin'), 'utf8'), 'same-ciphertext');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('新账号的凭据和密钥不被旧目录覆盖，现有偏好也不覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-new-session-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    for (const directory of [legacy, destination]) mkdirSync(join(directory, 'Local Storage'), { recursive: true });
    writeFileSync(join(legacy, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'old-key' } }));
    const newState = JSON.stringify({ os_crypt: { encrypted_key: 'new-key' } });
    writeFileSync(join(destination, 'Local State'), newState);
    writeFileSync(join(legacy, 'session.bin'), 'old-ciphertext');
    writeFileSync(join(legacy, 'pending-access.bin'), 'old-invite');
    writeFileSync(join(destination, 'session.bin'), 'new-ciphertext');
    writeFileSync(join(destination, 'Local Storage', 'fixture'), 'new-preferences');
    migrateOwnedData(legacy, destination);
    assert.equal(readFileSync(join(destination, 'session.bin'), 'utf8'), 'new-ciphertext');
    assert.equal(readFileSync(join(destination, 'Local State'), 'utf8'), newState);
    assert.equal(existsSync(join(destination, 'pending-access.bin')), false);
    assert.equal(readFileSync(join(destination, 'Local Storage', 'fixture'), 'utf8'), 'new-preferences');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('旧加密状态缺失或解析失败时保留原文件，不迁入无法解密的凭据，不标记完成', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-migration-failure-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    mkdirSync(legacy); mkdirSync(destination);
    writeFileSync(join(legacy, 'session.bin'), 'original-ciphertext');
    assert.throws(() => migrateOwnedData(legacy, destination), /缺少解密所需的数据/);
    writeFileSync(join(legacy, 'Local State'), 'invalid-private-state');
    assert.throws(() => migrateOwnedData(legacy, destination), /无法读取登录信息的加密数据/);
    assert.equal(existsSync(join(destination, '.legacy-migration-complete')), false);
    assert.equal(existsSync(join(destination, 'session.bin')), false);
    assert.equal(readFileSync(join(legacy, 'session.bin'), 'utf8'), 'original-ciphertext');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('目录复制失败不标记迁移完成，重试可继续且凭据与密钥保持配对', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-migration-retry-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    mkdirSync(join(legacy, 'Local Storage'), { recursive: true }); mkdirSync(destination);
    writeFileSync(join(legacy, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'old-key' } }));
    writeFileSync(join(legacy, 'session.bin'), 'old-ciphertext');
    writeFileSync(join(legacy, 'Local Storage', 'fixture'), 'preferences');
    assert.throws(() => migrateOwnedData(legacy, destination, { ...filesystem,
      cpSync: () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); } }), /EACCES/);
    assert.equal(existsSync(join(destination, '.legacy-migration-complete')), false);
    migrateOwnedData(legacy, destination);
    assert.equal(readFileSync(join(destination, 'session.bin'), 'utf8'), 'old-ciphertext');
    assert.equal(JSON.parse(readFileSync(join(destination, 'Local State'))).os_crypt.encrypted_key, 'old-key');
    assert.equal(readFileSync(join(destination, 'Local Storage', 'fixture'), 'utf8'), 'preferences');
    assert.equal(existsSync(join(destination, '.legacy-migration-complete')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('启动时创建运行目录并切换 Electron 路径，目录不可写时不改路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-apply-'));
  const legacyRoot = join(root, 'Roaming');
  const install = join(root, 'LycanSync');
  const calls = [];
  const environment = { TEMP: 'old-temp', TMP: 'old-temp' };
  const app = {
    getName: () => 'LycanSync',
    getPath: (name) => {
      if (name !== 'appData') throw new Error(`过早读取 ${name}`);
      return legacyRoot;
    },
    setPath: (name, value) => calls.push(['setPath', name, value]),
    setAppLogsPath: (value) => calls.push(['logs', value]),
  };
  try {
    mkdirSync(join(legacyRoot, 'LycanSync'), { recursive: true });
    writeFileSync(join(legacyRoot, 'LycanSync', 'server-config.json'), '{"apiUrl":"https://kept.example"}');
    const layout = applyRuntimePaths({
      app, packaged: true, execPath: join(install, 'LycanSync.exe'), projectDirectory: join(root, 'repo'),
      environment,
    });
    assert.equal(layout.userData, join(install, 'data'));
    assert.equal(readFileSync(join(layout.userData, 'server-config.json'), 'utf8'), '{"apiUrl":"https://kept.example"}');
    assert.equal(existsSync(join(layout.userData, '.write-probe')), false);
    assert.deepEqual(calls, [
      ['setPath', 'userData', layout.userData],
      ['setPath', 'sessionData', layout.userData],
      ['setPath', 'crashDumps', layout.crashDumps],
      ['setPath', 'temp', layout.temp],
      ['logs', layout.logs],
    ]);
    assert.equal(environment.TEMP, layout.temp);
    assert.equal(environment.TMP, layout.temp);
    assert.equal(environment.TMPDIR, layout.temp);
    const blocked = join(root, 'blocked.exe');
    writeFileSync(blocked, '');
    const untouched = { ...app, setPath: () => { throw new Error('不应切换路径'); }, setAppLogsPath: () => { throw new Error('不应切换日志'); } };
    assert.throws(() => applyRuntimePaths({
      app: untouched, packaged: true, execPath: join(blocked, 'LycanSync.exe'), projectDirectory: root,
    }), /无法在此目录保存数据/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('首次迁移包含登录、托盘、录像设置和录像索引', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-settings-first-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  const files = ['login-settings.json', 'desktop-settings.json', 'recording-settings.json', 'recording-library.json'];
  try {
    mkdirSync(legacy); mkdirSync(destination);
    for (const name of files) writeFileSync(join(legacy, name), JSON.stringify({ file: name }));
    migrateOwnedData(legacy, destination);
    for (const name of files) assert.equal(readFileSync(join(destination, name), 'utf8'), readFileSync(join(legacy, name), 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('已完成旧迁移时只补缺失设置，复制失败可重试且不恢复旧凭据', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-settings-repair-'));
  const legacy = join(root, 'legacy'), destination = join(root, 'data');
  try {
    mkdirSync(legacy); mkdirSync(destination);
    writeFileSync(join(destination, '.legacy-migration-complete'), '');
    for (const name of ['login-settings.json', 'desktop-settings.json', 'recording-settings.json', 'recording-library.json']) writeFileSync(join(legacy, name), 'legacy-' + name);
    writeFileSync(join(legacy, 'session.bin'), 'old-secret');
    writeFileSync(join(legacy, 'pending-access.bin'), 'old-offer');
    writeFileSync(join(destination, 'recording-settings.json'), 'current-settings');
    assert.throws(() => migrateOwnedData(legacy, destination, { ...filesystem, copyFileSync: (source, target) => {
      if (source.endsWith('recording-library.json')) { writeFileSync(target, 'partial'); throw new Error('copy failed'); }
      filesystem.copyFileSync(source, target);
    } }), /copy failed/);
    assert.equal(existsSync(join(destination, '.legacy-settings-migration-complete')), false);
    assert.equal(existsSync(join(destination, 'recording-library.json')), false);
    writeFileSync(join(destination, 'desktop-settings.json'), 'new-choice');
    migrateOwnedData(legacy, destination);
    assert.equal(readFileSync(join(destination, 'desktop-settings.json'), 'utf8'), 'new-choice');
    assert.equal(readFileSync(join(destination, 'recording-settings.json'), 'utf8'), 'current-settings');
    assert.equal(readFileSync(join(destination, 'recording-library.json'), 'utf8'), 'legacy-recording-library.json');
    assert.equal(existsSync(join(destination, 'session.bin')), false);
    assert.equal(existsSync(join(destination, 'pending-access.bin')), false);
    rmSync(join(destination, 'login-settings.json'));
    migrateOwnedData(legacy, destination, { existsSync: path => {
      assert.ok(path.startsWith(destination), '补迁完成后不再访问旧目录'); return existsSync(path);
    } });
    assert.equal(existsSync(join(destination, 'login-settings.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

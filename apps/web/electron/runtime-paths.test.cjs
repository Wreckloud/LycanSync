const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { applyRuntimePaths, migrateOwnedData, runtimeLayout } = require('./runtime-paths.cjs');

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
  assert.equal(layout.updaterCachePath, join(root, 'updater'));
  assert.equal(layout.legacyUserData, join(input.legacyRoot, 'LycanSync'));
});

test('源码运行使用仓库 data/desktop，显式目录不再读取旧的用户配置', () => {
  const source = runtimeLayout(layoutInput({ packaged: false }));
  assert.equal(source.userData, join('D:', 'repo', 'lycan-sync', 'data', 'desktop'));
  const explicit = runtimeLayout(layoutInput({ explicitUserDataDir: join('D:', 'profiles', 'second') }));
  assert.equal(explicit.userData, resolve(join('D:', 'profiles', 'second')));
  assert.equal(explicit.legacyUserData, undefined);
  assert.equal(explicit.updaterCachePath, join(explicit.userData, 'updater'));
});

test('只迁入登录、服务器、邀请、诊断和 OBS 配置，不覆盖已有文件，不复制缓存', () => {
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
    assert.equal(readFileSync(join(destination, 'server-config.json'), 'utf8'), '{"apiUrl":"https://old.example"}');
    assert.equal(readFileSync(join(destination, 'pending-access.bin'), 'utf8'), 'invite');
    assert.equal(readFileSync(join(destination, 'screen-share-error.log'), 'utf8'), 'log');
    assert.equal(readFileSync(join(destination, 'screen-share-error.log.previous'), 'utf8'), 'previous');
    assert.equal(readFileSync(join(destination, 'obs-capture', '32.2.2', 'basic.ini'), 'utf8'), 'obs');
    assert.equal(statSync(join(legacy, 'Cache', 'junk')).isFile(), true);
    assert.throws(() => statSync(join(destination, 'Cache')));
    migrateOwnedData(destination, destination);
    migrateOwnedData(join(root, 'missing'), destination);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('启动时创建运行目录并切换 Electron 路径，目录不可写时不改路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-apply-'));
  const legacyRoot = join(root, 'Roaming');
  const install = join(root, 'LycanSync');
  const calls = [];
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
    });
    assert.equal(layout.userData, join(install, 'data'));
    assert.equal(readFileSync(join(layout.userData, 'server-config.json'), 'utf8'), '{"apiUrl":"https://kept.example"}');
    assert.equal(existsSync(join(layout.userData, '.write-probe')), false);
    assert.deepEqual(calls, [
      ['setPath', 'userData', layout.userData],
      ['setPath', 'sessionData', layout.userData],
      ['setPath', 'crashDumps', layout.crashDumps],
      ['logs', layout.logs],
    ]);
    const blocked = join(root, 'blocked.exe');
    writeFileSync(blocked, '');
    const untouched = { ...app, setPath: () => { throw new Error('不应切换路径'); }, setAppLogsPath: () => { throw new Error('不应切换日志'); } };
    assert.throws(() => applyRuntimePaths({
      app: untouched, packaged: true, execPath: join(blocked, 'LycanSync.exe'), projectDirectory: root,
    }), /无法在运行目录保存数据/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

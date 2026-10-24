const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createStartupUpdate, updateFeedUrl } = require('./startup-update.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const updater = new EventEmitter();
  const checks = deferred();
  const downloads = deferred();
  const installs = [];
  const states = [];
  let checkCount = 0;
  let downloadCount = 0;
  let cancelled = 0;
  let prepared = 0;
  let restored = 0;
  const token = { cancel: () => { cancelled += 1; } };
  updater.checkForUpdates = () => { checkCount += 1; return checks.promise; };
  updater.downloadUpdate = (receivedToken) => {
    assert.equal(receivedToken, token);
    downloadCount += 1;
    return downloads.promise;
  };
  updater.quitAndInstall = (...args) => { installs.push(args); };
  const startup = createStartupUpdate({
    enabled: true, version: '0.0.3', createUpdater: () => updater,
    onChange: (state) => states.push(state),
    beforeInstall: async () => { prepared += 1; },
    onInstallFailure: () => { restored += 1; },
    ...options,
  });
  const available = () => checks.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.0.4' }, cancellationToken: token });
  return { startup, updater, checks, downloads, installs, states, available,
    counts: () => ({ checkCount, downloadCount, cancelled, prepared, restored }) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('更新缓存固定在运行目录，不读取系统本地应用数据目录', async () => {
  const cachePath = join('D:', 'LycanSync', 'data', 'updater');
  const f = fixture({ updaterCachePath: cachePath });
  let reads = 0;
  f.updater.app = {};
  Object.defineProperty(f.updater.app, 'baseCachePath', {
    configurable: true,
    get: () => { reads += 1; return join('C:', 'Users', 'someone', 'AppData', 'Local'); },
  });
  const started = f.startup.start();
  f.checks.resolve({ isUpdateAvailable: false });
  assert.equal((await started).phase, 'ready');
  assert.equal(f.updater.app.baseCachePath, cachePath);
  assert.equal(reads, 0);
});

test('更新源只接受无凭据的 HTTPS 目录，不接受业务服务器输入的 HTTP 地址', () => {
  assert.equal(updateFeedUrl('https://updates.example.test/downloads'), 'https://updates.example.test/downloads/');
  for (const url of ['', 'http://127.0.0.1/', 'file:///test', 'https://user:password@example.test/',
    'https://example.test/?token=secret', 'https://example.test/#token']) assert.throws(() => updateFeedUrl(url));
});

test('启动检查只运行一次，没有新版不下载或安装', async () => {
  const f = fixture();
  const first = f.startup.start();
  assert.equal(f.startup.start(), first);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.disableWebInstaller, true);
  f.checks.resolve({ isUpdateAvailable: false });
  assert.equal((await first).phase, 'ready');
  await f.startup.start();
  assert.deepEqual(f.counts(), { checkCount: 1, downloadCount: 0, cancelled: 0, prepared: 0, restored: 0 });
});

test('开发模式不加载更新库或连接更新源', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.startup.start()).supported, false);
  assert.equal(f.counts().checkCount, 0);
  assert.equal((await f.startup.checkOnly()).supported, false);
  assert.equal(f.counts().checkCount, 0);
});

test('启动尚未结束时禁止设置页检查；手动检查不会重跑启动任务', async () => {
  const f = fixture();
  await assert.rejects(f.startup.checkOnly(), /启动更新尚未结束/);
  const started = f.startup.start();
  f.checks.resolve({ isUpdateAvailable: false });
  const initial = await started;
  const checked = await f.startup.checkOnly();
  assert.equal(checked.message, '当前已是最新版本');
  assert.equal(await f.startup.start(), initial);
  assert.deepEqual(f.counts(), { checkCount: 2, downloadCount: 0, cancelled: 0, prepared: 0, restored: 0 });
});

test('跳过启动后手动发现新版只报告版本，不下载、安装或准备退出', async () => {
  const f = fixture();
  f.startup.cancel();
  f.available();
  const state = await f.startup.checkOnly();
  assert.equal(state.phase, 'ready');
  assert.equal(state.nextVersion, '0.0.4');
  assert.match(state.message, /可重启应用更新/);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.deepEqual(f.counts(), { checkCount: 1, downloadCount: 0, cancelled: 0, prepared: 0, restored: 0 });
  assert.equal(f.installs.length, 0);
});

test('手动检查并发共用任务，结束后可以再次检查', async () => {
  const f = fixture();
  f.startup.cancel();
  const first = f.startup.checkOnly();
  assert.equal(f.startup.checkOnly(), first);
  f.checks.resolve({ isUpdateAvailable: false });
  await first;
  await f.startup.checkOnly();
  assert.equal(f.counts().checkCount, 2);
  assert.equal(f.counts().downloadCount, 0);
});

test('手动检查超时后 SDK 迟到的新版不覆盖提示、不下载或安装', async () => {
  const f = fixture({ checkTimeoutMs: 10 });
  f.startup.cancel();
  const state = await f.startup.checkOnly();
  assert.equal(state.error, true);
  f.available();
  await flush();
  assert.deepEqual(f.startup.getState(), state);
  assert.equal(f.counts().downloadCount, 0);
  assert.equal(f.installs.length, 0);
});

test('手动检查失败可重试，SDK error 事件不会重新进入启动安装链路', async () => {
  const f = fixture();
  f.startup.cancel();
  const first = f.startup.checkOnly();
  f.updater.emit('error', new Error('certificate invalid'));
  f.checks.reject(new Error('certificate invalid'));
  assert.equal((await first).error, true);
  f.updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  const retried = await f.startup.checkOnly();
  assert.equal(retried.error, false);
  assert.equal(retried.message, '当前已是最新版本');
  assert.equal(f.counts().downloadCount, 0);
  assert.equal(f.installs.length, 0);
});

test('主进程手动检查仅接受启动完成后的可信页面，不启动 helper 或退出客户端', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('update:check'");
  const end = main.indexOf("ipcMain.handle('update:restart'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let checks = 0;
  const context = { ipcMain: { handle: (_, value) => { handler = value; } },
    trustedSender: event => event.trusted, closing: false, startupReady: false,
    startupUpdate: { checkOnly: () => { checks++; return Promise.resolve({ phase: 'ready' }); } } };
  runInNewContext(main.slice(start, end), context);
  assert.throws(() => handler({ trusted: true }), /当前不能检查/);
  context.startupReady = true;
  assert.throws(() => handler({ trusted: false }), /当前不能检查/);
  await handler({ trusted: true });
  assert.equal(checks, 1);
  context.closing = true;
  assert.throws(() => handler({ trusted: true }), /当前不能检查/);
});

test('确认重启只接受已发现新版的可信安装版页面，沿正常关窗而不直接调用安装器', () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('update:restart'");
  const end = main.indexOf("ipcMain.handle('update:skip'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const calls = [];
  let state = { supported: true, phase: 'ready', error: false, nextVersion: '0.0.10' };
  const context = {
    ipcMain: { handle: (_, value) => { handler = value; } },
    trustedSender: event => event.trusted, closing: false, startupReady: true,
    startupUpdate: { getState: () => state },
    app: { relaunch: () => calls.push('relaunch') },
    mainWindow: { close: () => { calls.push('close'); context.closing = true; } },
  };
  runInNewContext(main.slice(start, end), context);
  assert.throws(() => handler({ trusted: false }), /当前不能重启/);
  context.startupReady = false;
  assert.throws(() => handler({ trusted: true }), /当前不能重启/);
  context.startupReady = true;
  const available = { ...state };
  for (const changes of [{ supported: false }, { phase: 'checking' }, { error: true }, { nextVersion: undefined }]) {
    state = { ...available, ...changes };
    assert.throws(() => handler({ trusted: true }), /请先检查/);
  }
  assert.deepEqual(calls, []);
  state = available;
  handler({ trusted: true });
  assert.deepEqual(calls, ['relaunch', 'close']);
  assert.throws(() => handler({ trusted: true }), /当前不能重启/);
  assert.deepEqual(calls, ['relaunch', 'close']);
});

test('设置重启更新桥接是无参数固定 IPC，不接受下载源或安装路径', () => {
  const preload = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  assert.match(preload, /restartForUpdate: \(\) => ipcRenderer\.invoke\('update:restart'\)/);
});

test('下载完成并通过 SDK 校验后才准备退出及调用静默安装重启', async () => {
  const f = fixture();
  void f.startup.start();
  f.available();
  await flush();
  assert.equal(f.startup.getState().phase, 'downloading');
  f.updater.emit('download-progress', { percent: 42.9 });
  assert.equal(f.startup.getState().percent, 42);
  assert.equal(f.counts().prepared, 0);
  assert.equal(f.installs.length, 0);
  f.downloads.resolve(['verified-installer.exe']);
  await flush();
  assert.equal(f.startup.getState().phase, 'installing');
  assert.equal(f.counts().prepared, 1);
  assert.deepEqual(f.installs, [[true, true]]);
});

test('检查超时允许使用旧版，迟到的新版结果不下载或安装', async () => {
  const f = fixture({ checkTimeoutMs: 10 });
  const state = await f.startup.start();
  assert.equal(state.error, true);
  assert.match(state.message, /超时/);
  f.available();
  await flush();
  assert.equal(f.counts().downloadCount, 0);
  assert.equal(f.installs.length, 0);
});

test('检查或下载失败明确报告，不安装；迟到的错误不会覆写已结束状态', async () => {
  for (const download of [false, true]) {
    const f = fixture();
    const started = f.startup.start();
    if (download) {
      f.available();
      await flush();
      f.downloads.reject(Object.assign(new Error('checksum mismatch'), { code: 'ERR_UPDATER_CHECKSUM_MISMATCH' }));
    } else f.checks.reject(new Error('certificate invalid'));
    const state = await started;
    assert.equal(state.error, true);
    assert.equal(f.counts().prepared, 0);
    assert.equal(f.installs.length, 0);
    f.updater.emit('error', new Error('late failure'));
    assert.deepEqual(f.startup.getState(), state);
  }
});

test('跳过或关闭取消下载，迟到下载成功不打断业务界面', async () => {
  const f = fixture();
  const started = f.startup.start();
  f.available();
  await flush();
  f.startup.cancel();
  assert.equal((await started).error, false);
  assert.equal(f.counts().cancelled, 1);
  f.downloads.resolve(['verified-installer.exe']);
  f.updater.emit('download-progress', { percent: 99 });
  await flush();
  assert.equal(f.startup.getState().phase, 'ready');
  assert.equal(f.installs.length, 0);
  assert.equal(f.updater.listenerCount('download-progress'), 0);
});

test('启动前取消也会结束等待，不重新检查', async () => {
  const f = fixture();
  f.startup.cancel();
  assert.equal((await f.startup.start()).phase, 'ready');
  assert.equal(f.counts().checkCount, 0);
});

test('保存邀请期间关闭不会安装，退出授权恢复', async () => {
  const prepared = deferred();
  const f = fixture({ beforeInstall: () => prepared.promise });
  const started = f.startup.start();
  f.available();
  await flush();
  f.downloads.resolve(['verified-installer.exe']);
  await flush();
  f.startup.cancel();
  await started;
  prepared.resolve();
  await flush();
  assert.equal(f.installs.length, 0);
  assert.equal(f.counts().restored, 1);
});

test('邀请保存或安装调用失败，报告失败并恢复普通退出流程', async () => {
  for (const prepareFailure of [false, true]) {
    const f = fixture(prepareFailure ? { beforeInstall: async () => { throw new Error('credential store unavailable'); } } : {});
    if (!prepareFailure) f.updater.quitAndInstall = () => { f.updater.emit('error', new Error('installer unavailable')); };
    const started = f.startup.start();
    f.available();
    await flush();
    f.downloads.resolve(['verified-installer.exe']);
    assert.equal((await started).error, true);
    assert.equal(f.counts().restored, 1);
  }
});

test('真实主进程更新入口等检查结束再启动活动 helper，重复调用不再启动', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('update:startup'");
  const end = main.indexOf("ipcMain.on('window:minimize'", start);
  assert.ok(start >= 0 && end > start);
  const completion = deferred();
  const handlers = new Map();
  let activityStarts = 0;
  const context = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedSender: (event) => event.trusted,
    closing: false, startupReady: false,
    startupUpdate: { start: () => completion.promise, getState: () => ({ phase: 'checking' }), cancel: () => {} },
    startActivityHelper: () => { activityStarts += 1; },
  };
  runInNewContext(main.slice(start, end), context);
  const handler = handlers.get('update:startup');
  await assert.rejects(handler({ trusted: false }), /当前不能检查/);
  const first = handler({ trusted: true });
  const second = handler({ trusted: true });
  assert.equal(activityStarts, 0);
  completion.resolve({ phase: 'ready' });
  await Promise.all([first, second]);
  assert.equal(activityStarts, 1);
  context.closing = true;
  await assert.rejects(handler({ trusted: true }), /当前不能检查/);
});

test('真实主进程安装前加密保留邀请并允许直接退出，不传给安装器或日志', async () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('const startupUpdate = createStartupUpdate(');
  const end = main.indexOf('function recordSourceTiming(', start);
  assert.ok(start >= 0 && end > start);
  const f = fixture();
  const order = [];
  const context = {
    app: { isPackaged: true, getVersion: () => '0.0.3', getPath: () => 'test-user-directory' },
    process: { platform: 'win32' }, createStartupUpdate,
    require: (name) => { assert.equal(name, 'electron-updater'); return { autoUpdater: f.updater }; },
    mainWindow: undefined, closing: false, startupReady: false, canClose: false, allowQuitAfterMediaHelper: false,
    pendingAccessLink: { server: 'https://example.test', token: 'test-invitation' }, accessLinkFile: 'pending-access.bin',
    runtimeLayout: { updaterCachePath: join('D:', 'LycanSync', 'data', 'updater') },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (link) => {
      assert.equal(link, 'lycansync://access?server=https%3A%2F%2Fexample.test#token=test-invitation');
      order.push('encrypt');
      return Buffer.from('encrypted-test-offer');
    } },
    mkdir: async () => { order.push('mkdir'); },
    writeFile: async (file, contents) => {
      assert.equal(file, 'pending-access.bin');
      assert.equal(contents.toString(), 'encrypted-test-offer');
      order.push('write');
    },
  };
  const startup = runInNewContext(`${main.slice(start, end)}; startupUpdate`, context);
  f.updater.quitAndInstall = (...args) => { assert.deepEqual(args, [true, true]); order.push('install'); };
  void startup.start();
  f.available();
  await flush();
  f.downloads.resolve(['verified-installer.exe']);
  await flush();
  assert.deepEqual(order, ['mkdir', 'encrypt', 'write', 'install']);
  assert.equal(context.canClose, true);
  assert.equal(context.allowQuitAfterMediaHelper, true);
});

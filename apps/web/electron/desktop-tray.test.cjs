const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createDesktopTray } = require('./desktop-tray.cjs');

function fixture(context, saved) {
  const root = resolve(__dirname, '../../../release/test-cache');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'tray-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = resolve(directory, 'desktop-settings.json');
  if (saved !== undefined) writeFileSync(settingsPath, saved);
  const icons = [], calls = [];
  let window = {
    destroyed: false, minimized: false, visible: true, focused: true,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    isVisible() { return this.visible; }, isFocused() { return this.focused; },
    restore() { this.minimized = false; calls.push('restore'); },
    show() { this.visible = true; calls.push('show'); },
    focus() { this.focused = true; calls.push('focus'); },
    hide() { this.visible = false; this.focused = false; calls.push('hide'); },
  };
  class Tray extends EventEmitter {
    constructor(path) { super(); this.path = path; icons.push(this); }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    displayBalloon(value) { calls.push(value); }
  }
  const options = { Tray, Menu: { buildFromTemplate: menu => menu }, iconPath: resolve(__dirname, 'tray.ico'),
    settingsPath, getWindow: () => window, onQuit: () => calls.push('quit'), platform: 'win32' };
  const manager = createDesktopTray(options);
  return { manager, options, icons, calls, window, settingsPath,
    loseWindow: () => { window = undefined; }, close: () => {
      let prevented = false;
      const hidden = manager.handleClose({ preventDefault: () => { prevented = true; } });
      return { hidden, prevented };
    } };
}

test('托盘仅有显示与退出，默认关窗驻留；初始化不抢焦点', context => {
  const f = fixture(context);
  f.manager.initialize(); f.manager.initialize();
  assert.equal(f.icons.length, 1);
  assert.deepEqual(f.icons[0].menu.map(item => item.label), ['显示主界面', '退出']);
  assert.equal(f.icons[0].tooltip, 'LycanSync');
  assert.deepEqual(f.manager.settings(), { supported: true, enabled: true, error: '' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.close(), { hidden: true, prevented: true });
});

test('已保存的关闭托盘偏好不被新默认值覆盖', context => {
  const f = fixture(context, '{"closeToTray":false}');
  f.manager.initialize();
  assert.equal(f.manager.settings().enabled, false);
  assert.deepEqual(f.close(), { hidden: false, prevented: false });
});

test('开启后只隐藏窗口，一次无声提示；保存后重启恢复偏好', async context => {
  const f = fixture(context);
  f.manager.initialize();
  await f.manager.setEnabled(true);
  assert.deepEqual(JSON.parse(readFileSync(f.settingsPath, 'utf8')), { closeToTray: true });
  assert.deepEqual(f.close(), { hidden: true, prevented: true });
  f.close();
  assert.deepEqual(f.calls.filter(call => typeof call === 'string'), ['hide', 'hide']);
  const notifications = f.calls.filter(call => typeof call === 'object');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].noSound, true);
  const restarted = createDesktopTray(f.options);
  restarted.initialize();
  assert.equal(restarted.settings().enabled, true);
  await restarted.setEnabled(false);
  assert.equal(restarted.handleClose({ preventDefault() { assert.fail('不应阻止退出'); } }), false);
});

test('隐藏和最小化均可恢复，重复点击可见主窗不反复 show 或抢焦点', context => {
  const f = fixture(context);
  f.manager.initialize();
  f.window.minimized = true; f.window.visible = false; f.window.focused = false;
  f.icons[0].emit('click'); f.icons[0].emit('click');
  assert.deepEqual(f.calls, ['restore', 'show', 'focus']);
  f.window.visible = false;
  f.icons[0].menu[0].click();
  assert.equal(f.window.visible, true);
  f.loseWindow();
  assert.doesNotThrow(() => f.manager.show());
});

test('托盘退出只请求一次现有退出链路，此后关窗不再隐藏', context => {
  const f = fixture(context, '{"closeToTray":true}');
  f.manager.initialize();
  f.icons[0].menu[1].click(); f.manager.quit();
  assert.deepEqual(f.calls, ['quit']);
  assert.deepEqual(f.close(), { hidden: false, prevented: false });
  f.manager.show();
  assert.deepEqual(f.calls, ['quit']);
  f.manager.dispose(); f.manager.dispose();
  assert.equal(f.icons[0].isDestroyed(), true);
  assert.equal(f.manager.settings().supported, false);
});

test('系统结束会话绕过驻留；保存失败保留旧值并允许重试', async context => {
  const f = fixture(context);
  f.manager.initialize();
  mkdirSync(f.settingsPath);
  await assert.rejects(f.manager.setEnabled(false), /无法保存托盘设置/);
  assert.equal(f.manager.settings().enabled, true);
  rmSync(f.settingsPath, { recursive: true });
  await f.manager.setEnabled(true);
  f.manager.prepareToQuit();
  assert.deepEqual(f.close(), { hidden: false, prevented: false });
  await assert.rejects(f.manager.setEnabled(false), /当前无法使用托盘/);
});

test('保存中拒绝并发及非法参数，成功写入之前不改变关窗行为', async context => {
  const f = fixture(context, '{"closeToTray":false}');
  f.manager.initialize();
  await assert.rejects(f.manager.setEnabled('true'), /托盘设置无效/);
  const saving = f.manager.setEnabled(true);
  assert.deepEqual(f.close(), { hidden: false, prevented: false });
  await assert.rejects(f.manager.setEnabled(false), /正在保存/);
  await saving;
  assert.equal(f.manager.settings().enabled, true);
});

test('配置损坏明确报告且默认退出，重新保存可修正', async context => {
  context.mock.method(console, 'error', () => {});
  const f = fixture(context, '{"closeToTray":"yes"}');
  f.manager.initialize();
  assert.match(f.manager.settings().error, /无法读取/);
  assert.deepEqual(f.close(), { hidden: false, prevented: false });
  await f.manager.setEnabled(true);
  assert.equal(f.manager.settings().error, '');
});

test('托盘创建失败或平台不支持时绝不隐藏窗口', async context => {
  context.mock.method(console, 'error', () => {});
  const f = fixture(context, '{"closeToTray":true}');
  const broken = createDesktopTray({ ...f.options, Tray: class { constructor() { throw new Error('missingIcon'); } } });
  broken.initialize();
  assert.match(broken.settings().error, /无法创建托盘/);
  assert.equal(broken.handleClose({ preventDefault() { assert.fail(); } }), false);
  await assert.rejects(broken.setEnabled(true), /当前无法使用托盘/);
  const unsupported = createDesktopTray({ ...f.options, platform: 'linux' });
  unsupported.initialize();
  assert.equal(unsupported.settings().supported, false);
  assert.equal(f.icons.length, 0);
});

test('真实关窗入口：驻留不触发媒体清理，退出仍发出 release-media', context => {
  const f = fixture(context, '{"closeToTray":true}');
  f.manager.initialize();
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("mainWindow.on('close'");
  const end = source.indexOf("mainWindow.on('maximize'", start);
  let close;
  const cleanups = [];
  const scope = { mainWindow: { on: (_name, callback) => { close = callback; }, webContents: { send: name => cleanups.push(name) } },
    desktopTray: f.manager, canClose: false, allowQuitAfterMediaHelper: false, closing: false,
    audioShortcuts: { clear: () => cleanups.push('shortcuts') }, screenShareWindows: { closeAll: () => cleanups.push('viewers') },
    voiceOverlay: { clear: () => {} }, startupUpdate: { cancel: () => {} },
    setTimeout: () => 1, finishClose() {}, closeTimer: undefined };
  runInNewContext(source.slice(start, end), scope);
  close({ preventDefault() {} });
  assert.deepEqual(cleanups, []);
  f.manager.prepareToQuit();
  close({ preventDefault() {} });
  assert.equal(scope.closing, true);
  assert.deepEqual(cleanups, ['shortcuts', 'viewers', 'window:release-media']);
});

test('开启驻留时更新仍由安装器退出，不先重启或收起到托盘', async context => {
  const f = fixture(context, '{"closeToTray":true}');
  const calls = [];
  const manager = createDesktopTray({ ...f.options, onQuit: () => assert.fail('下载准备不应退出到托盘') });
  manager.initialize();
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('update:restart'");
  const end = source.indexOf("ipcMain.on('app:startup-timing'", start);
  let restart;
  runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { restart = callback; } },
    trustedSender: () => true, closing: false, startupReady: true, desktopTray: manager,
    startupUpdate: { getState: () => ({ supported: true, phase: 'ready', nextVersion: 'next' }),
      install: async () => { calls.push('install'); return { error: false }; } },
  });
  await restart({});
  assert.deepEqual(calls, ['install']);
  assert.deepEqual(f.calls, []);
});

test('托盘 IPC 只允许主窗口且校验布尔值；preload 不暴露任意托盘命令', () => {
  const handlers = new Map();
  let enabled = false;
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('settings:tray:get'");
  const end = source.indexOf("ipcMain.handle('activity:current'", start);
  const scope = { closing: false, trustedSender: event => event.trusted,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    desktopTray: { settings: () => ({ enabled }), setEnabled: value => { enabled = value; } } };
  runInNewContext(source.slice(start, end), scope);
  assert.throws(() => handlers.get('settings:tray:get')({ trusted: false }), /无法读取/);
  assert.throws(() => handlers.get('settings:tray:set')({ trusted: true }, 'true'), /参数无效/);
  assert.throws(() => handlers.get('settings:tray:set')({ trusted: false }, true), /参数无效/);
  handlers.get('settings:tray:set')({ trusted: true }, true);
  assert.equal(handlers.get('settings:tray:get')({ trusted: true }).enabled, true);
  scope.closing = true;
  assert.throws(() => handlers.get('settings:tray:set')({ trusted: true }, false), /参数无效/);
  let bridge;
  const calls = [];
  runInNewContext(readFileSync(resolve(__dirname, 'preload.cjs'), 'utf8'), {
    process: { platform: 'win32' }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, invoke: (...args) => calls.push(args) },
    }),
  });
  bridge.getTraySettings(); bridge.setCloseToTray(true);
  assert.deepEqual(calls, [['settings:tray:get'], ['settings:tray:set', true]]);
});


test('自启读取系统实际启用状态，保存后核对；开发版和非法来源不写系统', () => {
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const handlers = new Map();
  let login = { openAtLogin: true, executableWillLaunchAtLogin: false };
  const writes = [];
  const app = { isPackaged: true,
    getLoginItemSettings: options => {
      assert.equal(options.path, 'D:/LycanSync/LycanSync.exe');
      assert.equal(options.args.length, 0);
      return login;
    },
    setLoginItemSettings: options => {
      writes.push(JSON.parse(JSON.stringify(options)));
      login = { openAtLogin: options.openAtLogin, executableWillLaunchAtLogin: options.enabled };
    } };
  const scope = { app, process: { platform: 'win32', execPath: 'D:/LycanSync/LycanSync.exe' },
    trustedSender: event => event.trusted, ipcMain: { handle: (name, callback) => handlers.set(name, callback) } };
  runInNewContext(source.slice(source.indexOf('function autoStartSettings()'), source.indexOf('function externalHttpUrl(')), scope);
  runInNewContext(source.slice(source.indexOf("ipcMain.handle('settings:auto-start:get'"),
    source.indexOf("ipcMain.handle('settings:tray:get'")), scope);
  const read = handlers.get('settings:auto-start:get');
  const save = handlers.get('settings:auto-start:set');
  const event = { trusted: true };
  assert.equal(read(event).enabled, false);
  assert.throws(() => read({ trusted: false }), /来源无效/);
  assert.throws(() => save(event, 'true'), /参数无效/);
  assert.throws(() => save({ trusted: false }, true), /参数无效/);
  assert.equal(save(event, true).enabled, true);
  assert.deepEqual(writes[0], { openAtLogin: true, enabled: true, path: 'D:/LycanSync/LycanSync.exe', args: [] });
  assert.equal(save(event, false).enabled, false);
  app.setLoginItemSettings = () => {};
  assert.throws(() => save(event, true), /无法确认/);
  app.isPackaged = false;
  assert.equal(save(event, true).supported, false);
  assert.equal(writes.length, 2);
});

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createScreenShareWindows } = require('./screen-share-windows.cjs');

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const details = (id = firstId) => ({ url: `lycan://app/viewer.html#${id}`, frameName: `lycan-viewer-${id}`, disposition: 'new-window' });

function fixture() {
  class Window extends EventEmitter {
    visible = true;
    minimized = false;
    focused = true;
    pinned = false;
    destroyed = false;
    messages = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'lycan://app/' },
      isDestroyed: () => this.destroyed,
      send: (channel, payload) => this.messages.push({ channel, payload }),
      setWindowOpenHandler: (callback) => { this.open = callback; },
    });
    setMenu() {}
    show() { this.visible = true; this.emit('show'); }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isFocused() { return this.focused; }
    focus() { this.focused = true; }
    restore() { this.minimized = false; this.emit('restore'); }
    isFullScreen() { return this.fullscreen === true; }
    setFullScreen(value) { this.fullscreen = value; }
    isAlwaysOnTop() { return this.pinned; }
    setAlwaysOnTop(value) { this.pinned = value; this.emit('always-on-top-changed'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const main = new Window();
  const manager = createScreenShareWindows();
  manager.attach(main);
  const event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  function create(id = firstId) {
    const request = details(id);
    const result = main.open(request);
    assert.equal(result.action, 'allow');
    const child = new Window();
    child.visible = false;
    child.webContents.mainFrame.url = request.url;
    main.webContents.emit('did-create-window', child, request);
    return { child, options: result.overrideBrowserWindowOptions, ready: () => manager.ready(event(child)) };
  }
  return { manager, main, create, event, Window };
}

test('仅允许固定观看页和对应匿名窗口名，覆盖安全配置并拒绝重复、查询、外站及提交表单', () => {
  const f = fixture();
  for (const request of [
    { ...details(), url: 'https://example.invalid/viewer.html#' + firstId },
    { ...details(), url: 'lycan://app/viewer.html?next=/api#' + firstId },
    { ...details(), frameName: 'viewer' }, { ...details(), postBody: {} },
    { ...details(), disposition: 'background-tab' }, details('not-an-id'),
  ]) assert.deepEqual(f.main.open(request), { action: 'deny' });
  const first = f.create();
  assert.equal(first.child.visible, false);
  assert.equal(first.options.frame, true);
  assert.equal(first.options.alwaysOnTop, false);
  assert.equal(first.options.parent, undefined);
  assert.equal(first.options.webPreferences.preload, resolve(__dirname, 'viewer-preload.cjs'));
  assert.deepEqual(first.options.webPreferences, { preload: resolve(__dirname, 'viewer-preload.cjs'), sandbox: true,
    contextIsolation: true, nodeIntegration: false, webSecurity: true });
  assert.deepEqual(f.main.open(details()), { action: 'deny' });
  assert.deepEqual(first.child.open(details(secondId)), { action: 'deny' });
  const foreign = { sender: first.child.webContents, senderFrame: { url: first.child.webContents.mainFrame.url } };
  assert.throws(() => f.manager.ready(foreign), /来源无效/);
  assert.throws(() => f.manager.ready(f.event(f.main)), /来源无效/);
  assert.throws(() => f.manager.pin(f.event(first.child), true), /无效/);
  assert.deepEqual(first.ready(), { visible: true, focused: true, pinned: false });
  assert.deepEqual(f.manager.pin(f.event(first.child), true), { visible: true, focused: true, pinned: true });
  assert.throws(() => f.manager.pin(f.event(first.child), 'true'), /无效/);
  first.child.setAlwaysOnTop = () => {};
  assert.throws(() => f.manager.pin(f.event(first.child), false), /系统未能确认/);
  first.child.webContents.mainFrame.url = 'lycan://app/';
  assert.throws(first.ready, /来源无效/);
  f.manager.closeAll();
});

test('原生显隐逐窗同步，失焦、移动和缩放只发释放信号，不自动重新激活输入', () => {
  const f = fixture(), first = f.create(), second = f.create(secondId);
  first.ready(); second.ready();
  first.child.messages.length = 0; second.child.messages.length = 0;
  f.main.visible = false; f.main.emit('hide');
  assert.equal(f.manager.mainVisible(), false);
  assert.deepEqual(f.main.messages.at(-1), { channel: 'window:visibility', payload: false });
  assert.equal(first.child.messages.length, 0);
  first.child.minimized = true; first.child.emit('minimize');
  assert.deepEqual(first.child.messages[0], { channel: 'viewer:state', payload: { visible: false, focused: true, pinned: false } });
  assert.equal(first.child.messages.at(-1).channel, 'viewer:disarm');
  assert.equal(second.child.messages.length, 0);
  for (const name of ['blur', 'will-move', 'will-resize']) {
    first.child.emit(name);
    assert.equal(first.child.messages.at(-1).channel, 'viewer:disarm');
  }
  first.child.minimized = false; first.child.emit('restore');
  assert.deepEqual(first.child.messages.at(-1), { channel: 'viewer:state', payload: { visible: true, focused: true, pinned: false } });
  f.manager.closeAll();
});

test('唤回已显示窗口只聚焦，不重复显示；最小化和隐藏时才恢复可见性', () => {
  const f = fixture(), first = f.create();
  first.ready();
  const calls = [];
  for (const method of ['restore', 'show', 'focus']) {
    const original = first.child[method].bind(first.child);
    first.child[method] = () => { calls.push(method); original(); };
  }
  first.child.focused = false;
  f.manager.focus(firstId);
  assert.deepEqual(calls, ['focus']);
  calls.length = 0;
  f.manager.focus(firstId);
  assert.deepEqual(calls, []);
  first.child.visible = false; first.child.focused = false;
  f.manager.focus(firstId);
  assert.deepEqual(calls, ['show', 'focus']);
  calls.length = 0;
  first.child.visible = true; first.child.minimized = true; first.child.focused = false;
  f.manager.focus(firstId);
  assert.deepEqual(calls, ['restore', 'focus']);
  f.manager.closeAll();
});

test('单窗关闭不影响其他观看位置；全部关闭先使登记失效，旧就绪或旧关闭不能销毁新窗', () => {
  const f = fixture(), first = f.create(), second = f.create(secondId);
  first.ready(); second.ready();
  first.child.destroy();
  assert.equal(second.child.destroyed, false);
  assert.deepEqual(f.main.messages.at(-1), { channel: 'viewer:closed', payload: { id: firstId, failed: false } });
  f.manager.closeAll();
  assert.throws(first.ready, /来源无效/);
  const next = f.create(); next.ready();
  first.child.emit('closed');
  assert.equal(next.child.destroyed, false);
  f.main.destroy();
  assert.equal(next.child.destroyed, true);
  assert.equal(f.manager.mainVisible(), false);
});

test('就绪超时、加载失败、渲染崩溃均回收并明确通知；关闭期间才创建的窗口不能接回', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), first = f.create();
  t.mock.timers.tick(8000);
  assert.equal(first.child.destroyed, true);
  assert.deepEqual(f.main.messages.at(-1).payload, { id: firstId, failed: true });
  const second = f.create(); second.ready();
  second.child.webContents.emit('render-process-gone');
  assert.equal(second.child.destroyed, true);
  const third = f.create();
  third.child.webContents.emit('did-fail-load', {}, -2, 'failed', details().url, true);
  assert.equal(third.child.destroyed, true);
  f.main.open(details()); f.manager.closeAll();
  const late = new f.Window();
  f.main.webContents.emit('did-create-window', late, details());
  assert.equal(late.destroyed, true);
  assert.throws(third.ready, /来源无效/);
});

test('只允许初次固定页导航，拒绝后续导航、重定向与 webview', () => {
  const f = fixture(), { child, ready } = f.create();
  let denied = 0;
  const event = { preventDefault: () => denied++ };
  child.webContents.emit('will-navigate', event, details().url);
  assert.equal(denied, 0);
  child.webContents.emit('will-navigate', event, 'lycan://app/');
  ready();
  child.webContents.emit('will-navigate', event, details().url);
  child.webContents.emit('will-redirect', event, details().url);
  child.webContents.emit('will-attach-webview', event);
  assert.equal(denied, 4);
  f.manager.closeAll();
});

test('观看 preload 只暴露固定窗口能力，监听可以注销，不暴露业务或设备桥', async () => {
  const emitter = new EventEmitter(), calls = [], exposed = {};
  emitter.invoke = async (...args) => { calls.push(args); return {}; };
  runInNewContext(readFileSync(resolve(__dirname, 'viewer-preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer: emitter }),
  });
  assert.deepEqual(Object.keys(exposed), ['lycanViewerWindow']);
  const bridge = exposed.lycanViewerWindow;
  assert.deepEqual(Object.keys(bridge).sort(), ['exitFullscreen', 'onDisarm', 'onState', 'ready', 'setPinned', 'toggleFullscreen']);
  const states = [], disarms = [];
  const stopState = bridge.onState((state) => states.push(state));
  const stopDisarm = bridge.onDisarm(() => disarms.push(true));
  await bridge.ready(); await bridge.setPinned(true); await bridge.toggleFullscreen(); await bridge.exitFullscreen();
  emitter.emit('viewer:state', {}, { visible: false }); emitter.emit('viewer:disarm', {});
  stopState(); stopDisarm();
  emitter.emit('viewer:state', {}, { visible: true }); emitter.emit('viewer:disarm', {});
  assert.deepEqual(calls, [['viewer:ready'], ['viewer:pin', true], ['viewer:fullscreen'], ['viewer:fullscreen', false]]);
  assert.deepEqual(states, [{ visible: false }]); assert.deepEqual(disarms, [true]);
});

test('正式 IPC 仅主页面可唤回窗口，就绪／置顶／全屏仍交由对应窗口校验，退出期间拒绝操作', () => {
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('window:visibility'");
  const end = source.indexOf("ipcMain.handle('window:layout'", start);
  const handlers = new Map(), calls = [];
  const mainEvent = {};
  const realm = {
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    trustedSender: (event) => event === mainEvent,
    closing: false,
    screenShareWindows: {
      mainVisible: () => true,
      ready: (event) => calls.push(['ready', event]),
      pin: (event, enabled) => calls.push(['pin', event, enabled]),
      focus: (id) => calls.push(['focus', id]),
      fullscreen: (event) => calls.push(['fullscreen', event]),
    },
  };
  runInNewContext(source.slice(start, end), realm);
  assert.equal(handlers.get('window:visibility')(mainEvent), true);
  assert.throws(() => handlers.get('window:visibility')({}), /来源无效/);
  assert.throws(() => handlers.get('viewer:focus')({}, firstId), /来源无效/);
  assert.deepEqual(calls, []);
  handlers.get('viewer:focus')(mainEvent, firstId);
  const childEvent = {};
  handlers.get('viewer:ready')(childEvent); handlers.get('viewer:pin')(childEvent, true);
  handlers.get('viewer:fullscreen')(childEvent);
  assert.deepEqual(calls, [['focus', firstId], ['ready', childEvent], ['pin', childEvent, true], ['fullscreen', childEvent]]);
  realm.closing = true;
  assert.throws(() => handlers.get('viewer:ready')(childEvent), /正在关闭/);
  assert.throws(() => handlers.get('viewer:pin')(childEvent, true), /正在关闭/);
  assert.throws(() => handlers.get('viewer:fullscreen')(childEvent), /正在关闭/);
  assert.throws(() => handlers.get('viewer:focus')(mainEvent, firstId), /来源无效/);
  assert.equal(calls.length, 4);
});

test('唤回恢复最小化窗口，准备中不提前闪出；全屏由本窗操作并先解除输入', () => {
  const f = fixture(), first = f.create();
  f.manager.focus(firstId);
  assert.equal(first.child.visible, false);
  first.ready();
  first.child.minimized = true; first.child.visible = false;
  f.manager.focus(firstId);
  assert.equal(first.child.minimized, false); assert.equal(first.child.visible, true);
  assert.throws(() => f.manager.focus('unknown'), /已失效/);
  f.manager.fullscreen(f.event(first.child));
  assert.equal(first.child.fullscreen, true);
  assert.equal(first.child.messages.at(-1).channel, 'viewer:disarm');
  f.manager.fullscreen(f.event(first.child));
  assert.equal(first.child.fullscreen, false);
  assert.throws(() => f.manager.fullscreen(f.event(f.main)), /来源无效/);
  f.manager.closeAll();
});

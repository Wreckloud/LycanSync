const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createVoiceOverlay, createOverlayPage, validateSettings, validateSnapshot, DEFAULT_SETTINGS } = require('./voice-overlay.cjs');

const member = { identity: 'one', name: '成员一', microphone: true, listening: true, speaking: true };
const portrait = { identity: 'one', avatar: 'data:image/png;base64,AA==' };

function fixture() {
  const windows = [];
  const failures = [];
  const placements = [];
  const editChanges = [];
  const diagnostics = [];
  const handlers = {};
  const displays = [{ id: 1, workArea: { x: -1280, y: 0, width: 1280, height: 900 } },
    { id: 2, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  class MockWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.operations = [];
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: 'lycan://overlay/overlay.html' };
      this.webContents.setWindowOpenHandler = (handler) => { this.open = handler; };
      this.webContents.send = (channel, payload) => { this.message = { channel, payload }; };
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      windows.push(this);
    }
    setContentProtection(value) { this.protected = value; this.operations.push('protection'); }
    setAlwaysOnTop(value, level) { this.topmost = value; this.level = level; }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value; }
    setFocusable(value) { this.focusable = value; }
    setMenu() {}
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; this.emit('moved'); }
    async loadURL(url) { this.url = url; }
    showInactive() { this.visible = true; this.operations.push('showInactive'); }
    hide() { this.visible = false; }
    isDestroyed() { return this.destroyed === true; }
    isVisible() { return this.visible; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const overlaySession = new EventEmitter();
  overlaySession.protocol = { handle: (scheme, handler) => { handlers.protocol = { scheme, handler }; } };
  overlaySession.webRequest = { onBeforeRequest: (handler) => { handlers.request = handler; } };
  overlaySession.setPermissionCheckHandler = (handler) => { handlers.permission = handler; };
  overlaySession.setPermissionRequestHandler = (handler) => { handlers.permissionRequest = handler; };
  overlaySession.setDisplayMediaRequestHandler = (handler) => { handlers.capture = handler; };
  const manager = createVoiceOverlay({ BrowserWindow: MockWindow,
    session: { fromPartition: (partition) => { assert.equal(partition, 'voice-overlay'); return overlaySession; } },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0], getDisplayMatching: () => displays[0] },
    defaultDisplay: () => 2, net: { fetch: async () => new Response('static') }, rendererRoot: resolve('dist'),
    onError: (message) => failures.push(message), onPlacement: (settings) => placements.push(settings),
    onEditingChange: (editing) => editChanges.push(editing), onDiagnostic: (entry) => diagnostics.push(entry),
  });
  manager.initialize();
  const owner = manager.begin();
  function configure(patch) { return manager.configure(owner, { ...DEFAULT_SETTINGS, enabled: true, ...patch }); }
  function update(sequence = 0, patch = {}) { manager.update(owner, { sequence, roomId: 'room-a', status: 'connected', members: [member], ...patch }); }
  function ready(window = windows.at(-1)) {
    manager.ready({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    return window;
  }
  return { manager, owner, configure, update, ready, windows, failures, placements, handlers, displays, editChanges, diagnostics };
}

test('默认关闭且无房间不建窗口；已开启且加入语音后才显示，先排除捕获再显示', () => {
  const f = fixture();
  f.update();
  assert.equal(f.windows.length, 0);
  f.configure({});
  assert.equal(f.windows.length, 0);
  f.update(1, { portraits: [portrait] });
  const window = f.ready();
  assert.equal(window.options.parent, undefined);
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.backgroundThrottling, false);
  assert.equal(window.ignoresMouse, true);
  assert.equal(window.topmost, true);
  assert.equal(window.protected, true);
  assert.ok(window.operations.indexOf('protection') < window.operations.indexOf('showInactive'));
  assert.equal(window.bounds.x, 1680);
  assert.equal(window.message.payload.portraits[0].avatar, portrait.avatar);
  f.manager.clear();
});

test('只说话者支持多人，停说保留500ms，禁麦/停止收听立即消失，头像不随说话重复发送', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = fixture();
  f.configure({ mode: 'speaking' });
  f.update(0, { portraits: [portrait] });
  const window = f.ready();
  f.update(1, { members: [{ ...member, speaking: false }] });
  assert.equal(window.message.payload.members[0].visible, true);
  assert.equal(window.message.payload.members[0].speaking, false);
  assert.equal(window.message.payload.portraits, undefined);
  t.mock.timers.tick(499);
  assert.equal(window.visible, true);
  t.mock.timers.tick(1);
  assert.equal(window.visible, false);
  f.update(2, { members: [member, { ...member, identity: 'two' }] });
  assert.equal(window.message.payload.members.filter((item) => item.visible).length, 2);
  f.update(3, { members: [{ ...member, microphone: false }, { ...member, identity: 'two', listening: false }] });
  assert.equal(window.visible, false);
  f.manager.clear();
});

test('重连清除高亮；离房销毁，旧序号与旧owner不能恢复，新房间无旧头像', () => {
  const f = fixture();
  f.configure({}); f.update(1, { portraits: [portrait] });
  const window = f.ready();
  f.update(2, { status: 'reconnecting' });
  assert.equal(window.message.payload.members[0].speaking, false);
  f.update(3, { roomId: null, status: 'hidden', members: [] });
  assert.equal(window.destroyed, true);
  f.update(1);
  assert.equal(f.windows.length, 1);
  f.update(4, { roomId: 'room-b' });
  const next = f.ready();
  assert.equal(next.message.payload.portraits[0].avatar, '');
  f.manager.begin();
  assert.equal(next.destroyed, true);
  assert.throws(() => f.update(5), /会话已结束/);
  f.manager.clear();
});

test('编辑结束恢复穿透，无通话仅在显式编辑时预览；禁用后清除预览', () => {
  const f = fixture(); f.configure({});
  f.manager.edit(f.owner, true);
  const window = f.ready();
  assert.equal(window.options.focusable, true);
  assert.equal(window.ignoresMouse, false);
  assert.equal(window.message.payload.editing, true);
  f.manager.edit(f.owner, false);
  assert.equal(window.destroyed, true);
  f.update();
  const active = f.ready();
  f.manager.edit(f.owner, true);
  assert.equal(active.ignoresMouse, false);
  f.manager.edit(f.owner, false);
  assert.equal(active.ignoresMouse, true);
  assert.equal(active.focusable, false);
  f.configure({ enabled: false });
  assert.equal(active.destroyed, true);
  f.manager.clear();
});

test('跨屏拖动只保存用户操作，断屏临时回主屏，缩放及负坐标边界仍在工作区内', () => {
  const f = fixture(); f.configure({ displayId: 2, width: 300, scale: 150 }); f.update(); f.ready();
  f.manager.edit(f.owner, true);
  assert.equal(f.placements.length, 0);
  const window = f.windows[0];
  window.bounds = { ...window.bounds, x: -1000, y: 80 };
  window.emit('will-move');
  window.emit('moved');
  assert.equal(f.placements[0].displayId, 1);
  f.configure({ displayId: 2, x: 1, y: 1 });
  f.displays.splice(1, 1);
  f.manager.correctPlacement();
  assert.ok(window.bounds.x < 0);
  assert.ok(window.bounds.y + window.bounds.height <= 900);
  assert.equal(f.placements.length, 1);
  f.manager.clear();
});

test('系统移动或显示器断开不会冒充用户拖动覆盖原偏好，编辑状态同步退出', () => {
  const f = fixture(); f.configure({ displayId: 2 }); f.update(); const window = f.ready();
  f.manager.edit(f.owner, true);
  window.bounds = { ...window.bounds, x: 0 };
  window.emit('moved');
  assert.equal(f.placements.length, 0);
  f.displays.splice(1, 1);
  window.emit('will-move'); window.emit('moved');
  assert.equal(f.placements.length, 0);
  assert.deepEqual(f.editChanges, [false]);
  f.manager.clear();
});

test('覆盖页崩溃只报告覆盖错误，不自动重建；关闭再开启可恢复', () => {
  const f = fixture(); f.configure({}); f.update();
  const window = f.ready();
  window.webContents.emit('render-process-gone');
  assert.equal(window.destroyed, true);
  assert.equal(f.failures.length, 1);
  f.update(1);
  assert.equal(f.windows.length, 1);
  f.configure({ enabled: false }); f.configure({}); f.update(2); f.ready();
  assert.equal(f.windows.length, 2);
  f.manager.clear();
});

test('页面子模块加载失败未就绪时有界超时报错，不留无声的空白窗口', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.configure({}); f.update();
  t.mock.timers.tick(10_000);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.failures.length, 1);
  assert.equal(f.diagnostics.at(-1).stage, 'voiceOverlayReadyTimeout');
  f.manager.clear();
});

test('只允许覆盖本页主frame确认就绪，禁止外跳、设备权限、下载和外网请求', () => {
  const f = fixture(); f.configure({}); f.update();
  const window = f.windows[0];
  assert.throws(() => f.manager.ready({ sender: {}, senderFrame: {} }), /来源无效/);
  assert.deepEqual(window.open({ url: 'https://example.test' }), { action: 'deny' });
  assert.equal(f.handlers.permission(), false);
  for (const url of ['lycan://app/api/auth/me', 'https://example.test/', 'file:///secret']) {
    let result;
    f.handlers.request({ url }, (value) => { result = value; });
    assert.deepEqual(result, { cancel: true });
  }
  f.manager.clear();
});

test('独立静态协议拒绝业务API、任意路径与写请求，不调用业务代理', async () => {
  const fetched = [];
  const serve = createOverlayPage({ rendererRoot: resolve('dist'), fetch: async (url) => {
    fetched.push(url); return new Response('static');
  } });
  for (const url of ['lycan://app/api/auth/me', 'lycan://overlay/api/auth/me', 'lycan://overlay/electron/main.cjs',
    'lycan://overlay/src/main.ts', 'lycan://overlay/@fs/C:/secret']) {
    assert.ok((await serve(new Request(url))).status >= 400);
  }
  assert.equal((await serve(new Request('lycan://overlay/overlay.html', { method: 'POST' }))).status, 403);
  const response = await serve(new Request('lycan://overlay/overlay.html'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  assert.equal(fetched.length, 1);
});

test('只接受有界设置与纯头像数据，不接收可执行图片URL或伪造静音说话状态', () => {
  for (const patch of [{ scale: 0 }, { width: 9999 }, { x: -1 }, { displayId: '1' }, { mode: 'other' }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...patch }));
  }
  assert.throws(() => validateSnapshot({ sequence: 1, roomId: 'r', status: 'connected', members: [member],
    portraits: [{ identity: 'one', avatar: 'https://external.test/avatar.png' }] }));
  assert.equal(validateSnapshot({ sequence: 1, roomId: 'r', status: 'connected',
    members: [{ ...member, microphone: false }] }).members[0].speaking, false);
});

test('正式IPC隔离主页面与覆盖页面，结束旧owner不会清除新会话', () => {
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const handlers = new Map();
  const calls = [];
  const methods = ['begin', 'configure', 'update', 'edit', 'end', 'displays', 'ready'];
  const voiceOverlay = Object.fromEntries(methods.map((name) => [name, (...args) => calls.push({ name, args })]));
  const start = source.indexOf("ipcMain.handle('voice-overlay:begin'");
  const end = source.indexOf("ipcMain.handle('auth:clear'", start);
  runInNewContext(source.slice(start, end), { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedSender: (event) => event.trusted, closing: false, voiceOverlay });
  for (const [name, handler] of handlers) {
    if (name !== 'voice-overlay:ready') assert.throws(() => handler({ trusted: false }), /来源无效/);
  }
  assert.equal(calls.length, 0);
  handlers.get('voice-overlay:configure')({ trusted: true }, 'owner', DEFAULT_SETTINGS);
  assert.equal(calls[0].name, 'configure');
  const f = fixture(); const second = f.manager.begin();
  f.manager.end(f.owner);
  assert.doesNotThrow(() => f.manager.configure(second, DEFAULT_SETTINGS));
  f.manager.clear();
});

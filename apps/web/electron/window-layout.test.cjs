const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { initialWindowBounds, createWindowLayout } = require('./window-layout.cjs');

function fixture(area = { x: 0, y: 0, width: 1920, height: 1080 }) {
  let bounds = initialWindowBounds(area);
  let maximized = false;
  let changes = 0;
  const flags = {};
  const window = {
    getBounds: () => ({ ...bounds }), getNormalBounds: () => ({ ...bounds }),
    isDestroyed: () => false, isMaximized: () => maximized,
    setBounds: (next) => { bounds = next; changes++; },
    setResizable: (enabled) => { flags.resizable = enabled; },
    setMaximizable: (enabled) => { flags.maximizable = enabled; },
    setMinimumSize: (width, height) => { flags.minimum = [width, height]; },
    maximize: () => { maximized = true; }, unmaximize: () => { maximized = false; },
  };
  const layout = createWindowLayout(window, { getDisplayMatching: () => ({ workArea: area }) });
  return { window, layout, area, flags, bounds: () => bounds, changes: () => changes };
}

test('首次窗口即420宽；更新、登录、邀请、资料各按内容高度紧凑展示', () => {
  const f = fixture();
  assert.equal(f.bounds().width, 420);
  for (const [mode, width] of [['startup', 420], ['account', 440], ['invitation', 480], ['profile', 680]]) {
    f.layout.apply(mode, 380);
    assert.equal(f.bounds().width, width);
    assert.equal(f.bounds().height, 380);
    assert.equal(f.flags.resizable, false);
    assert.equal(f.flags.maximizable, false);
  }
});

test('展开内容只改高度，重复尺寸不重排；小屏和负坐标都裁剪在工作区', () => {
  const f = fixture({ x: -1024, y: -100, width: 1024, height: 700 });
  f.layout.apply('account', 300);
  const before = f.bounds();
  f.layout.apply('account', 600);
  assert.equal(f.bounds().x, before.x);
  assert.equal(f.bounds().y + f.bounds().height, 600);
  const changes = f.changes();
  f.layout.apply('account', 600);
  assert.equal(f.changes(), changes);
  f.layout.apply('profile', 1400);
  assert.equal(f.bounds().height, 668);
  assert.ok(f.bounds().x >= -1024 && f.bounds().x + f.bounds().width <= 0);
});

test('进入主界面恢复正常大小，重复主界面请求不覆盖用户调整；退出再进恢复原位置与最大化', () => {
  const f = fixture();
  f.layout.apply('main', 0);
  assert.equal(f.bounds().width, 1280);
  assert.equal(f.bounds().height, 820);
  assert.deepEqual(f.flags.minimum, [920, 640]);
  assert.equal(f.flags.resizable, true);
  const chosen = { x: 300, y: 200, width: 1000, height: 700 };
  f.window.setBounds(chosen);
  f.layout.apply('main', 0);
  assert.deepEqual(f.bounds(), chosen);
  f.window.maximize();
  f.layout.apply('account', 330);
  assert.equal(f.window.isMaximized(), false);
  f.layout.apply('main', 0);
  assert.deepEqual(f.bounds(), chosen);
  assert.equal(f.window.isMaximized(), true);
});

test('窗口布局仅允许固定模式与有界高度；不可信IPC不触达窗口', () => {
  const f = fixture();
  for (const [mode, height] of [['unknown', 200], ['__proto__', 300], ['account', -1], ['account', NaN], ['account', 9000]]) {
    assert.throws(() => f.layout.apply(mode, height));
  }
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('window:layout'");
  const end = source.indexOf("ipcMain.handle('window:is-maximized'", start);
  let handler;
  let calls = 0;
  runInNewContext(source.slice(start, end), { ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: (event) => event.trusted, closing: false, windowLayout: { apply: () => { calls++; } } });
  assert.throws(() => handler({ trusted: false }, 'main', 0), /来源无效/);
  assert.equal(calls, 0);
  handler({ trusted: true }, 'account', 300);
  assert.equal(calls, 1);
});

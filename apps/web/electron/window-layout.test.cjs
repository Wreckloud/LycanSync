const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { initialWindowBounds } = require('./window-layout.cjs');

test('首次打开即使用主界面尺寸', () => {
  assert.deepEqual(initialWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }),
    { x: 320, y: 130, width: 1280, height: 820 });
});

test('小屏幕、负坐标和高缩放工作区保留窗口边距', () => {
  for (const area of [{ x: -1024, y: -100, width: 1024, height: 700 },
    { x: 0, y: 0, width: 800, height: 600 }]) {
    const bounds = initialWindowBounds(area);
    assert.ok(bounds.x >= area.x + 16 && bounds.y >= area.y + 16);
    assert.ok(bounds.x + bounds.width <= area.x + area.width - 16);
    assert.ok(bounds.y + bounds.height <= area.y + area.height - 16);
  }
});

test('采集预备独立于窗口布局，仅可信主页面可调用，关闭期间拒绝预热', () => {
  const source = readFileSync(resolve(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('capture:prepare'");
  const end = source.indexOf("ipcMain.handle('window:is-maximized'", start);
  let handler;
  const calls = [];
  const realm = { ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: (event) => event.trusted, closing: false, prepareObsCapture: (graphics) => calls.push(graphics) };
  runInNewContext(source.slice(start, end), realm);
  assert.throws(() => handler({ trusted: false }), /来源无效/);
  assert.deepEqual(calls, []);
  handler({ trusted: true });
  assert.deepEqual(calls, [false]);
  handler({ trusted: true }, true);
  assert.deepEqual(calls, [false, true]);
  assert.throws(() => handler({ trusted: true }, 'true'), /来源无效/);
  realm.closing = true;
  assert.throws(() => handler({ trusted: true }), /来源无效/);
  assert.deepEqual(calls, [false, true]);
});

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

test('桌面误调用 Chromium 共享时明确拒绝，不枚举来源或启动采集', () => {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const deny = main.slice(main.indexOf('function denyCapture('), main.indexOf('function finishClose('));
  const configure = main.slice(main.indexOf('function configurePermissions('), main.indexOf('if (!app.requestSingleInstanceLock('));
  let handler;
  const callbacks = [];
  const desktopSession = {
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
    setDisplayMediaRequestHandler(value) { handler = value; },
  };
  const realm = runInNewContext(`${deny}\n${configure}\nconfigurePermissions(); ({ TypeError });`, {
    session: { defaultSession: desktopSession },
  });
  handler({ videoRequested: true, audioRequested: false }, (response) => callbacks.push(response));
  handler({ videoRequested: true, audioRequested: true }, (response) => callbacks.push(response));
  assert.equal(callbacks.length, 2);
  callbacks.forEach((response) => assert.equal(Object.keys(response).length, 0));
  // Electron 的已知取消异常仍限于这一种；其他调用错误必须显式传播。
  assert.doesNotThrow(() => handler({}, () => {
    throw new realm.TypeError('Video was requested, but no video stream was provided');
  }));
  const failure = new Error('unexpected failure');
  assert.throws(() => handler({}, () => { throw failure; }), (error) => error === failure);
});

test('preload 仅提供原生共享接口，不再暴露旧来源选择 IPC', () => {
  let bridge;
  runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: {} }),
  });
  assert.equal(typeof bridge.startNativeVideo, 'function');
  assert.equal(typeof bridge.listNativeVideoSources, 'function');
  assert.equal('selectSource' in bridge, false);
  assert.equal('onSources' in bridge, false);
});

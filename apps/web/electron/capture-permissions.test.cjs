const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { matchNativeVideoSourceThumbnails, monitorDisplayId } = require('./native-video-thumbnails.cjs');

test('缩略图 IPC 保留窗口句柄，同标题的分离窗口分别匹配并校验字段', async () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('media:video-source-thumbnails'");
  const end = source.indexOf("ipcMain.handle('media:capture-probe:start'", start);
  let handler;
  let calls = 0;
  runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    trustedSender: () => true, closing: false, performance, Buffer, screen: {},
    recordSourceTiming() {}, writeMediaDiagnostic: async () => {},
    captureSourceType: source => source.id.startsWith('window:') ? 'window' : 'screen',
    matchNativeVideoSourceThumbnails, monitorDisplayId,
    desktopCapturer: { getSources: async () => {
      calls++;
      return ['10', '20'].map(id => ({ id: `window:${id}:0`, name: 'Same browser title', display_id: '',
        thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from(id) } }));
    } },
  });
  const sources = ['10', '20'].map((windowId, index) => ({ sourceId: `window:1:${index}`,
    kind: 'window', title: 'Same browser title', windowId }));
  assert.deepEqual(await handler({}, sources), [
    { sourceId: 'window:1:0', thumbnail: 'data:image/jpeg;base64,MTA=' },
    { sourceId: 'window:1:1', thumbnail: 'data:image/jpeg;base64,MjA=' },
  ]);
  await assert.rejects(handler({}, [{ ...sources[0], windowId: '-1' }]), /请求参数无效/);
  assert.equal(calls, 1);
});

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

test('退出尚未完成媒体清理时阻止关闭，完成后允许 app.quit 关闭窗口', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("mainWindow.on('close'");
  const end = source.indexOf("mainWindow.on('maximize'", start);
  for (const completed of [false, true]) {
    let close;
    let prevented = false;
    runInNewContext(source.slice(start, end), {
      mainWindow: { on: (_name, callback) => { close = callback; } },
      canClose: false, closing: true, allowQuitAfterMediaHelper: completed,
    });
    close({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, !completed);
  }
});

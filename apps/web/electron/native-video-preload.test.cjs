const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function fixture() {
  const listeners = new Map(), bridges = new Map();
  const canvases = [], copies = [], posts = [], errors = [], invocations = [];
  let receive;
  const options = { contextMissing: false, drawFails: false, copyFails: false, postFails: false,
    invoke: async () => ({ changed: true }) };
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() {
      if (options.contextMissing) return null;
      return { drawImage: (...args) => { if (options.drawFails) throw new Error('drawFailed'); this.draw = args; } };
    }
  }
  class CopiedFrame {
    constructor(canvas, init) {
      if (options.copyFails) throw new Error('copyFailed');
      this.canvas = canvas; this.timestamp = init.timestamp; this.closed = 0;
      copies.push(this);
    }
    close() { this.closed++; }
  }
  runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    OffscreenCanvas: Canvas, VideoFrame: CopiedFrame,
    window: { postMessage: (...args) => { if (options.postFails) throw new Error('postFailed'); posts.push(args); } },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, bridge) => bridges.set(name, bridge) },
      sharedTexture: { setSharedTextureReceiver: (callback) => { receive = callback; } },
      ipcRenderer: {
        on: (name, callback) => listeners.set(name, callback),
        send: (...args) => errors.push(args),
        invoke: (...args) => { invocations.push(args); return options.invoke(...args); },
      },
    }),
  });
  async function deliver(sessionId = 'session-a', token = 'native-screen-frame', size = { width: 1920, height: 1080 }) {
    const frame = { displayWidth: 2048, displayHeight: 1152, visibleRect: size, timestamp: 123456, closed: 0,
      close() { this.closed++; } };
    const imported = { reads: 0, releases: 0,
      getVideoFrame() { this.reads++; return frame; }, release() { this.releases++; } };
    await receive({ importedSharedTexture: imported }, token, sessionId);
    return { frame, imported };
  }
  return { deliver, options, canvases, copies, posts, errors, listeners, invocations, bridge: bridges.get('lycanDesktop') };
}

test('共享纹理先复制为独立画面帧，保留内容尺寸和时间戳，只转交副本', async () => {
  const f = fixture();
  const { frame, imported } = await f.deliver();
  assert.equal(frame.closed, 1);
  assert.equal(imported.releases, 1);
  assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [1920, 1080]);
  assert.equal(f.canvases[0].draw[0], frame);
  assert.equal(f.posts[0][0].frame, f.copies[0]);
  assert.equal(f.posts[0][2][0], f.copies[0]);
  assert.equal(f.copies[0].timestamp, frame.timestamp);
  assert.equal(f.copies[0].closed, 0, '已转交的副本由页面持有');
  await f.deliver('session-a', 'native-screen-frame', { width: 1280, height: 720 });
  assert.equal(f.canvases.length, 1, '同一会话复用一份画布，不逐帧分配画布');
  assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [1280, 720]);
});

test('无效标记不读取或复制纹理，但仍归还导入引用', async () => {
  const f = fixture();
  const { frame, imported } = await f.deliver('session-a', 'unexpected');
  assert.equal(imported.reads, 0);
  assert.equal(imported.releases, 1);
  assert.equal(frame.closed, 0);
  assert.equal(f.canvases.length, 0);
});

test('复制或转交失败释放持有的资源并明确报错，下一次能重新建立画布', async (context) => {
  for (const failure of ['contextMissing', 'drawFails', 'copyFails', 'postFails']) {
    await context.test(failure, async () => {
      const f = fixture();
      f.options[failure] = true;
      const { frame, imported } = await f.deliver();
      assert.equal(frame.closed, 1);
      assert.equal(imported.releases, 1);
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0][0], 'media:native-video:receiver-error');
      assert.equal(f.posts.length, 0);
      if (failure === 'postFails') assert.equal(f.copies[0].closed, 1);
      f.options[failure] = false;
      await f.deliver();
      assert.equal(f.posts.length, 1);
    });
  }
});

test('停止在异步等待前释放画布，迟到停止不清空新会话，错误和暂停同样回收', async () => {
  const f = fixture();
  await f.deliver();
  let finishStop;
  f.options.invoke = () => new Promise((resolve) => { finishStop = resolve; });
  const stopped = f.bridge.stopNativeVideo('session-a');
  assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [0, 0]);
  await f.deliver('session-b');
  finishStop({ changed: true });
  await stopped;
  assert.equal(f.canvases[1].width, 1920);
  f.listeners.get('media:native-video-error')({}, { sessionId: 'session-a' });
  assert.equal(f.canvases[1].width, 1920);
  f.listeners.get('media:native-video-suspended')({}, { sessionId: 'session-b', suspended: true });
  assert.equal(f.canvases[1].width, 0);
  await f.deliver('session-b');
  f.listeners.get('media:native-video-error')({}, { sessionId: 'session-b' });
  assert.equal(f.canvases[2].width, 0);
});

test('停止失败仍释放画布且不伪报成功，停止期间的迟到帧最终也被清理', async () => {
  const f = fixture();
  await f.deliver();
  let rejectStop;
  f.options.invoke = () => new Promise((_resolve, reject) => { rejectStop = reject; });
  const stopped = f.bridge.stopNativeVideo('session-a');
  const rejected = assert.rejects(stopped, /controlledStopFailure/);
  await f.deliver('session-a');
  rejectStop(new Error('controlledStopFailure'));
  await rejected;
  assert.equal(f.canvases[0].width, 0);
  assert.equal(f.canvases[1].width, 0);
});

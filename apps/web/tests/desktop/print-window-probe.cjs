// 从仓库根目录运行 node apps/web/tests/desktop/print-window-probe.cjs --check。
// --run win32 / --run webgl 打开测试窗口；--run krita <十进制 HWND> 仅用于已准备好双色动画的 Krita。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { accessSync } = require('node:fs');
const { basename, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { MediaHelperManager } = require('../../electron/media-helper.cjs');
const { captureWindowThumbnail } = require('../../electron/native-window-thumbnails.cjs');

const root = resolve(__dirname, '../../../..');
const helperPath = resolve(root, 'native/media-helper/target/release/lycansync-media.exe');
const fixturePath = resolve(root, 'release/build-cache/obs-32.2.2/cmake-build/test-tools/lycansync-obs-test-windows.exe');
const browserPage = resolve(root, 'apps/web/electron/obs-capture-smoke/browser-source.html');
const palette = { green: [16, 200, 80], cyan: [16, 200, 220], blue: [32, 64, 220], cover: [220, 16, 200] };

function sampleColor({ width, height, bitmap }) {
  // 中央三处都应在测试画布内，避开边框、工具栏和浏览器夹具底部的移动标记。
  const labels = [0.45, 0.5, 0.55].map(x => {
    const offset = 4 * (Math.floor(height / 2) * width + Math.floor(width * x));
    const rgb = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    return Object.keys(palette).find(key => rgb.every((value, i) => Math.abs(value - palette[key][i]) <= 25));
  });
  if (labels.includes('cover')) throw new Error('occluderPixelsCaptured');
  if (!labels[0] || !labels.every(label => label === labels[0])) throw new Error('unexpectedCanvasPixels');
  return labels[0];
}

function preflight() {
  assert.equal(process.platform, 'win32', 'requiresWindows');
  for (const path of [helperPath, fixturePath, browserPage]) accessSync(path);
  require.resolve('playwright');
}

async function within(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function run(mode, windowId) {
  const helper = new MediaHelperManager({ executablePath: helperPath, onDiagnostic: () => {} });
  const fixture = spawn(fixturePath, mode === 'win32' ? [] : ['--cover-only'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolveClose => fixture.once('close', resolveClose));
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  const readEvent = async name => {
    const line = await within(lines.next(), 5000, 'fixtureResponseTimeout');
    assert(!line.done, 'fixtureExited');
    const event = JSON.parse(line.value);
    assert.equal(event.event, name, 'fixtureProtocolMismatch');
    return event;
  };
  let pipeError;
  fixture.stdin.on('error', error => { pipeError = error; });
  let browser;
  let page;
  let phase = 'start';
  try {
    await once(fixture, 'spawn');
    const ready = await readEvent('ready');
    let title;
    if (mode === 'win32') windowId = ready.windowId;
    if (mode === 'webgl') {
      const { chromium } = require('playwright');
      browser = await chromium.launch({ channel: 'chrome', headless: false,
        args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
      page = await browser.newPage({ viewport: { width: 560, height: 430 } });
      await page.goto(pathToFileURL(browserPage).href);
      await page.waitForFunction(() => window.fixtureInfo?.webgl && window.fixtureInfo.frames > 1);
      title = 'LycanSync PrintWindow ' + randomUUID();
      await page.evaluate(value => { document.title = value; }, title);
    }
    // 网页标题改完后，Chrome 的顶层窗口标题稍晚才会刷新。
    let matches;
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await helper.listVideoSources();
      matches = snapshot.sources.filter(source => source.kind === 'window'
        && (title ? source.title.includes(title) : source.windowId === windowId));
      if (!title || matches.length || attempt === 19) break;
      await delay(150);
    }
    assert.equal(matches.length, 1, 'targetNotUniquelyIdentified');
    const target = await helper.inspectVideoSource(matches[0].sourceId);
    if (mode === 'win32') assert.equal(target.processId, fixture.pid, 'fixtureProcessMismatch');
    if (mode === 'webgl') assert.equal(basename(target.executable).toLowerCase(), 'chrome.exe');
    if (mode === 'krita') assert.equal(basename(target.executable).toLowerCase(), 'krita.exe');
    const frames = () => page.evaluate(() => window.fixtureInfo.frames);
    const checkCover = async command => {
      fixture.stdin.write(command + ':' + target.windowId + '\n');
      assert((await readEvent('fullCoverChecked')).covered, 'fullOcclusionUnconfirmed');
    };
    let win32Color = 'green';
    for (phase of ['baseline', 'covered']) {
      if (phase === 'covered') await checkCover('place-cover');
      console.log(JSON.stringify({ mode, phase, sampling: true }));
      const initialFrames = page && await frames();
      const colors = [];
      for (let index = 0; index < (mode === 'win32' ? 4 : 16); index++) {
        if (mode === 'win32' && index > 0) {
          fixture.stdin.write('toggle-color\n');
          await readEvent('colorChanged');
          win32Color = win32Color === 'green' ? 'cyan' : 'green';
        }
        await delay(220);
        if (phase === 'baseline') {
          fixture.stdin.write('check-visible:' + target.windowId + '\n');
          assert((await readEvent('targetVisibilityChecked')).visible, 'baselineTargetCenterObscured');
        }
        // 每次直接启动有超时的单次工作进程，绕开缩略图缓存和 JPEG 编码。
        const color = sampleColor(await captureWindowThumbnail(helperPath, target).promise);
        if (mode === 'win32') assert.equal(color, win32Color, 'staleOrWrongWindow');
        else assert(['green', 'blue'].includes(color), 'wrongAnimationColor');
        colors.push(color);
        if (phase === 'covered') await checkCover('verify-cover');
      }
      if (page) assert(await frames() > initialFrames + 1, 'webglSourceStoppedDrawing');
      const changes = colors.filter((color, i) => i > 0 && color !== colors[i - 1]).length;
      console.log(JSON.stringify({ mode, phase, samples: colors.length, changes }));
      assert(changes >= 2, 'canvasDidNotKeepChanging');
    }
  } catch (error) {
    console.error(JSON.stringify({ mode, phase, error: error.message }));
    process.exitCode = 1;
  } finally {
    fixture.stdin.end('quit\n');
    try {
      assert.equal(await within(closed, 3000, 'fixtureStopTimeout'), 0, 'fixtureExitFailed');
      if (pipeError) throw pipeError;
    } catch (error) {
      fixture.kill();
      await within(closed, 3000, 'fixtureExitUnconfirmed');
      throw error;
    } finally {
      try { await browser?.close(); } finally { await helper.shutdown(); }
    }
  }
}

async function main(args) {
  preflight();
  if (args.length === 1 && args[0] === '--check') {
    console.log('就绪：已找到窗口夹具、媒体 helper、WebGL 页面和 Playwright。');
    return;
  }
  const [action, mode, windowId] = args;
  assert(action === '--run' && ((args.length === 2 && ['win32', 'webgl'].includes(mode))
    || (args.length === 3 && mode === 'krita' && /^[1-9]\d{0,19}$/.test(windowId))),
  '使用 --check、--run win32、--run webgl 或 --run krita <十进制 HWND>');
  await run(mode, windowId);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { sampleColor };

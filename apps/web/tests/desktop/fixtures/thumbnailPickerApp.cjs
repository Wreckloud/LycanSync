const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage } = require('electron');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { MediaHelperManager } = require('../../../electron/media-helper.cjs');
const { captureWindowThumbnail, createWindowThumbnailLoader } = require('../../../electron/native-window-thumbnails.cjs');

process.on('uncaughtException', error => { console.error(error.message); app.exit(1); });
app.setPath('userData', resolve(process.argv[2]));
const helper = new MediaHelperManager({ executablePath: resolve('../../native/media-helper/target/release/lycansync-media.exe') });
let loader, snapshot;
const measurements = [], timings = [];
const previewChildren = new Set();
function resources() {
  return { previewChildren: previewChildren.size, helperChildren: helper.children.size };
}
function reset() {
  loader?.dispose();
  loader = createWindowThumbnailLoader({ executablePath: () => helper.executablePath,
    capture: (executablePath, target) => captureWindowThumbnail(executablePath, target, {
      spawnProcess: (...args) => {
        const child = spawn(...args);
        previewChildren.add(child);
        child.once('close', () => previewChildren.delete(child));
        return child;
      },
    }),
    inspectSource: sourceId => helper.inspectVideoSource(sourceId),
    encode: ({ bitmap, width, height }) => {
      // 只保存内容统计，不将截图、窗口标题或句柄写入测试产物。
      let different = 0;
      for (let offset = 0; offset < bitmap.length; offset += 4) {
        if (bitmap[offset] !== bitmap[0] || bitmap[offset + 1] !== bitmap[1] || bitmap[offset + 2] !== bitmap[2]) different++;
      }
      measurements.push({ width, height, variedPixels: different, pixelCount: bitmap.length / 4 });
      return 'data:image/jpeg;base64,' + nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(80).toString('base64');
    }, onTiming: event => timings.push(event) });
}
global.thumbnailTest = { reset, timings, measurements, resources,
  async finish() { loader.dispose(); await helper.shutdown(); },
  async baseline() {
    const started = performance.now();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 256, height: 144 } });
    const windows = snapshot.sources.filter(source => source.kind === 'window');
    return { durationMs: performance.now() - started, enumeratedCount: sources.length, sourceCount: windows.length,
      readyCount: windows.filter(source => sources.some(image => image.id.split(':')[1] === source.windowId && !image.thumbnail.isEmpty())).length };
  } };
ipcMain.handle('thumbnail-test:sources', async () => {
  snapshot = await helper.listVideoSources();
  return { ...snapshot, sources: snapshot.sources.filter(source => source.kind === 'window')
    .map((source, index) => ({ ...source, title: `测试来源 ${index + 1}` })) };
});
ipcMain.handle('thumbnail-test:images', async (_event, sources) => {
  const owner = helper.videoSourceSnapshot?.state;
  return (await Promise.all(sources.map(source => {
    const current = snapshot.sources.find(item => item.sourceId === source.sourceId);
    return current ? loader.load(owner, current) : [];
  }))).flat();
});
app.whenReady().then(async () => {
  reset();
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { preload: resolve(__dirname, 'thumbnailPickerPreload.cjs'), contextIsolation: true, sandbox: true } });
  await window.loadURL('about:blank');
});
app.on('will-quit', () => { loader?.dispose(); void helper.shutdown(); });

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { join, resolve, basename } = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRecordingLibrary, recordingFileName } = require('./recording-library.cjs');
const { createRecordingEditor } = require('./recording-editor.cjs');

async function fixture(context) {
  const cache = resolve(__dirname, '../../../release/test-cache/recording-editor');
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(join(cache, 'case-'));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const id = randomUUID();
  const path = join(root, recordingFileName('Krita', 'recording', id));
  await fs.writeFile(path, 'source');
  const library = createRecordingLibrary({ dataDirectory: root, isActive: () => false });
  await library.register({ id, librarySessionId: id, path, applicationName: 'Krita', kind: 'recording' });
  await library.finish({ id, saved: true, durationMs: 5000, width: 640, height: 360 });
  return { root, id, path, library };
}
test('输出重建后记录最终文件身份，重启仍可预览；旧记录重新关联不会删除原片', async context => {
  const f = await fixture(context);
  await fs.rename(f.path, f.path + '.old'); await fs.writeFile(f.path, 'recreated');
  assert.equal((await f.library.list()).items[0].availability, 'changed');
  await f.library.finish({ id: f.id, saved: true });
  const next = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false });
  assert.equal(await next.filePath(f.id), f.path);
  await fs.rename(f.path, f.path + '.again'); await fs.writeFile(f.path, 'replaced');
  await next.relink(f.id);
  assert.equal(await next.filePath(f.id), f.path);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'replaced');
});
test('按类型过滤、清理失效记录只影响索引，旧版回放前缀仍可识别', async context => {
  const f = await fixture(context);
  const id = randomUUID(), path = join(f.root, `LycanSync-Replay-${id}.mkv`);
  await fs.writeFile(path, 'old replay');
  const index = JSON.parse(await fs.readFile(join(f.root, 'recording-library.json'), 'utf8'));
  const stat = await fs.stat(path);
  index.entries.push({ ...index.entries[0], id, path, kind: undefined, fileIdentity: `${stat.dev}:${stat.ino}` });
  await fs.writeFile(join(f.root, 'recording-library.json'), JSON.stringify(index));
  const library = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false });
  assert.equal((await library.list(0, 'replay')).items[0].id, id);
  await fs.rename(f.path, f.path + '.changed'); await fs.writeFile(f.path, 'keep me');
  await library.clearUnavailable();
  assert.deepEqual((await library.list()).items.map(entry => entry.id), [id]);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'keep me');
});
test('默认命名包含来源、种类和本地日期，文件名清理 Windows 保留字符', () => {
  const name = recordingFileName('Krita:/画布?', 'replay', 'id', new Date(2026, 10, 15, 12, 34, 56).getTime());
  assert.equal(name, 'Krita__画布_ · 回放 · 2026-11-15 12-34-56-id.mkv');
  assert.match(recordingFileName('', 'clip', 'id'), /^窗口 · 剪辑 · .*\.mp4$/);
});
test('拒绝越界和并发剪辑，取消停止进程并清理半成品，原片保持不变', async context => {
  const f = await fixture(context); let started;
  const ready = new Promise(yes => { started = yes; });
  const editor = createRecordingEditor({ library: f.library, executablePath: 'isolated.exe', onProgress() {},
    spawnProcess() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
      started(); return child;
    } });
  await assert.rejects(editor.exportClip(randomUUID(), f.id, 10, 6000), /超出了录像/);
  const requestId = randomUUID(); const task = editor.exportClip(requestId, f.id, 100, 2000);
  const rejected = assert.rejects(task, /已取消/);
  await ready;
  await assert.rejects(editor.exportClip(randomUUID(), f.id, 100, 2000), /正在保存/);
  await editor.cancel(requestId); await rejected;
  assert.equal(await fs.readFile(f.path, 'utf8'), 'source');
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith('.partial')).length, 0);
  assert.equal((await f.library.list()).items.length, 1);
});

test('独占预留失败不删除已有半成品或目标文件，也不启动剪辑进程', async context => {
  const f = await fixture(context);
  const originalOpen = fs.open;
  let temporary, destination;
  context.mock.method(fs, 'open', async (path, flags) => {
    temporary = path; destination = path.slice(0, -'.partial'.length);
    await fs.writeFile(temporary, 'existing partial');
    await fs.writeFile(destination, 'existing destination');
    return originalOpen(path, flags);
  });
  let spawned = false;
  const editor = createRecordingEditor({ library: f.library, executablePath: 'isolated.exe', onProgress() {},
    spawnProcess() { spawned = true; throw new Error('must not spawn'); } });
  await assert.rejects(editor.exportClip(randomUUID(), f.id, 100, 2000), { code: 'EEXIST' });
  assert.equal(spawned, false);
  assert.equal(await fs.readFile(temporary, 'utf8'), 'existing partial');
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing destination');
  assert.equal(await fs.readFile(f.path, 'utf8'), 'source');
});

test('进度到 100 后登记成品失败，重开列表仍只有原片且无残留视频', async context => {
  const f = await fixture(context);
  const library = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false, io: { ...fs,
    async rename(from, to) {
      const pending = JSON.parse(await fs.readFile(from, 'utf8'));
      if (pending.entries.some(entry => entry.kind === 'clip' && entry.state === 'saved')) throw new Error('index write failed');
      return fs.rename(from, to);
    },
  } });
  const progress = [];
  const editor = createRecordingEditor({ library, executablePath: 'isolated.exe', onProgress: event => progress.push(event.percent),
    spawnProcess(_exe, args) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      void fs.writeFile(args[1], 'completed video').then(() => { child.stdout.write('100\n'); child.emit('close', 0); });
      return child;
    } });
  await assert.rejects(editor.exportClip(randomUUID(), f.id, 100, 2000), /录像列表未能保存/);
  assert.deepEqual(progress, [100]);
  const reopened = createRecordingLibrary({ dataDirectory: f.root, isActive: () => false });
  assert.deepEqual((await reopened.list()).items.map(entry => entry.id), [f.id]);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.endsWith('.partial') || name.endsWith('.mp4')), []);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'source');
});
test('磁盘空间不足时报告写入原因并清理临时片段', async context => {
  const f = await fixture(context);
  context.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const editor = createRecordingEditor({ library: f.library, executablePath: 'isolated.exe', onProgress() {}, spawnProcess() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => child.emit('close', 0)); return child;
  } });
  await assert.rejects(editor.exportClip(randomUUID(), f.id, 100, 1000), /空间与写入权限/);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [basename(f.path), 'recording-library.json'].sort());
});
test('原生 FFmpeg 截取合成画面和 AAC，保存新 MP4 并可再次剪辑', { skip: !process.env.LYCANSYNC_TEST_CLIP }, async context => {
  const f = await fixture(context);
  const ffmpeg = process.env.LYCANSYNC_TEST_FFMPEG;
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', f.path], { windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const hash = async () => createHash('sha256').update(await fs.readFile(f.path)).digest('hex');
  const original = await hash();
  const progress = [];
  const editor = createRecordingEditor({ library: f.library, executablePath: process.env.LYCANSYNC_TEST_CLIP, onProgress: event => progress.push(event.percent) });
  const clip = await editor.exportClip(randomUUID(), f.id, 1230, 3620);
  assert.equal(clip.kind, 'clip'); assert.equal(clip.applicationName, 'Krita');
  assert.equal(clip.durationMs, 2390); assert.ok(clip.bytes > 1000);
  assert.match(clip.fileName, /Krita · 剪辑/); assert.equal(progress.at(-1), 100);
  const output = await f.library.filePath(clip.id);
  const decode = spawnSync(ffmpeg, ['-hide_banner', '-i', output, '-map', '0', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(decode.status, 0, decode.stderr);
  assert.match(decode.stderr, /Video: h264/); assert.match(decode.stderr, /Audio: aac/);
  assert.match(decode.stderr, /frame=\s*72/);
  assert.equal(await hash(), original);
  const second = await editor.exportClip(randomUUID(), clip.id, 200, 1200);
  assert.equal(second.kind, 'clip'); assert.equal(second.durationMs, 1000);
  assert.equal((await f.library.list(0, 'clip')).items.length, 2);
  assert.equal(basename(output), clip.fileName);
});

test('无声音的竖屏高帧率录像可从非关键帧截取，保持比例与帧率', { skip: !process.env.LYCANSYNC_TEST_CLIP }, async context => {
  const f = await fixture(context);
  const ffmpeg = process.env.LYCANSYNC_TEST_FFMPEG;
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=60:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '180', '-y', f.path], { windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  await f.library.finish({ id: f.id, saved: true, durationMs: 4000, width: 360, height: 640 });
  const editor = createRecordingEditor({ library: f.library, executablePath: process.env.LYCANSYNC_TEST_CLIP, onProgress() {} });
  assert.equal(await editor.frameRate(f.id), 60);
  const clip = await editor.exportClip(randomUUID(), f.id, 500, 2000);
  const decode = spawnSync(ffmpeg, ['-hide_banner', '-i', await f.library.filePath(clip.id), '-map', '0', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(decode.status, 0, decode.stderr);
  assert.match(decode.stderr, /360x640/); assert.match(decode.stderr, /60 fps/); assert.match(decode.stderr, /frame=\s*90/);
  assert.doesNotMatch(decode.stderr, /Audio:/);
});

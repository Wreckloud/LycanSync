import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';

const script = parse(readFileSync(new URL('./ChatFileMedia.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('media.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function setup(name = 'test.gif', cached: Blob | null = null) {
  const scope = effectScope();
  let mount!: () => void;
  let resolve!: (blob: Blob | null) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(done => { started = done; });
  const pending = () => new Promise<Blob | null>(done => { resolve = done; started(); });
  const fetchFilePreview = vi.fn(pending);
  const fetchVideoThumbnail = vi.fn(pending);
  const cache = { revision: 0, read: vi.fn(async () => cached), write: vi.fn(), discard: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:media');
  const revokeObjectURL = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const disconnect = vi.fn();
  const media = scope.run(() => runInNewContext(`${compiled}\n({frame,source,failed,load,release,decodeFailed})`, {
    ref, computed, onScopeDispose, onMounted: (callback: () => void) => { mount = callback; },
    inject: () => cache, ACCOUNT_CACHE: Symbol(), Blob,
    defineProps: () => ({ groupId: 'group', attachment: { id: 'file', fileName: name, contentType: 'application/octet-stream', byteSize: 4 } }),
    defineEmits: () => vi.fn(), chatMediaFormat, chatMediaFrameStyle, fetchFilePreview, fetchVideoThumbnail, AbortController,
    URL: { createObjectURL, revokeObjectURL },
    IntersectionObserver: class { constructor(callback: typeof callbacks[number]) { callbacks.push(callback); } observe() {} disconnect = disconnect; },
  })) as { frame: {value: unknown}; source: {value: string}; failed: {value: boolean}; load(): Promise<void>; release(): void; decodeFailed(): void };
  media.frame.value = { closest: () => null }; mount();
  return { scope, media, cache, requestStarted, callbacks, fetchFilePreview, fetchVideoThumbnail, createObjectURL, revokeObjectURL, resolve: (blob: Blob | null) => resolve(blob), disconnect };
}
it('离开区域取消读取，迟到内容不能创建 URL 或写入缓存', async () => {
  const f = setup();
  const loading = f.media.load(); await f.requestStarted;
  f.callbacks[0]([{ isIntersecting: false }]);
  f.resolve(new Blob(['gif'])); await loading;
  expect(f.createObjectURL).not.toHaveBeenCalled();
  expect(f.cache.write).not.toHaveBeenCalled();
  f.scope.stop(); expect(f.disconnect).toHaveBeenCalledOnce();
});
it('视频列表只加载封面，不下载或解码原视频', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted;
  expect(f.fetchVideoThumbnail).toHaveBeenCalledOnce();
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  expect(f.cache.write).toHaveBeenCalledWith('image', 'group', expect.any(Blob), 'cover:file');
  expect(f.createObjectURL.mock.calls[0][0].type).toBe('image/jpeg');
  f.scope.stop(); expect(f.revokeObjectURL).toHaveBeenCalledOnce();
});
it('GIF 原内容与封面分别缓存，缓存命中不重复下载', async () => {
  for (const name of ['test.gif', 'test.mp4']) {
    const f = setup(name, new Blob(['cached']));
    await f.media.load();
    expect(f.fetchFilePreview).not.toHaveBeenCalled();
    expect(f.fetchVideoThumbnail).not.toHaveBeenCalled();
    expect(f.media.source.value).toBe('blob:media');
    f.media.release(); await f.media.load();
    expect(f.cache.read).toHaveBeenCalledTimes(2);
    expect(f.createObjectURL).toHaveBeenCalledTimes(2);
    f.scope.stop();
  }
});
it('没有封面时保留文件入口，不转而自动下载原视频', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted; f.resolve(null); await loading;
  expect(f.media.failed.value).toBe(true);
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  expect(f.createObjectURL).not.toHaveBeenCalled();
  f.scope.stop();
});
it('音频和普通文件不在浏览消息时自动加载，图片解码失败丢弃缓存', async () => {
  for (const name of ['test.mp3', 'test.zip']) {
    const f = setup(name); await f.media.load();
    expect(f.callbacks).toHaveLength(0);
    expect(f.fetchFilePreview).not.toHaveBeenCalled();
    f.scope.stop();
  }
  const f = setup(); f.media.decodeFailed();
  expect(f.cache.discard).toHaveBeenCalledWith('image', 'group', 'file:file'); f.scope.stop();
});
it('清理缓存期间的迟到预览可显示，但不重新写入缓存', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted; f.cache.revision++;
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  expect(f.cache.write).not.toHaveBeenCalled(); f.scope.stop();
});

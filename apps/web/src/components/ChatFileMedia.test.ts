import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';

const { descriptor } = parse(readFileSync(new URL('./ChatFileMedia.vue', import.meta.url), 'utf8'));
const script = descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('media.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function setup(name = 'test.mp4', cached: Blob | null = null, uploading = false) {
  const scope = effectScope();
  let mount!: () => void;
  let resolve!: (blob: Blob | null) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(done => { started = done; });
  const pending = () => new Promise<Blob | null>(done => { resolve = done; started(); });
  const fetchFilePreview = vi.fn(pending);
  const fetchChatThumbnail = vi.fn(pending);
  const cache = { revision: 0, read: vi.fn(async () => cached), write: vi.fn(), discard: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:media');
  const revokeObjectURL = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const disconnect = vi.fn();
  const media = scope.run(() => runInNewContext(`${compiled}\n({frame,source,failed,loadingFailed,load,release,decodeFailed})`, {
    ref, computed, onScopeDispose, onMounted: (callback: () => void) => { mount = callback; },
    inject: () => cache, ACCOUNT_CACHE: Symbol(), Blob, setTimeout, clearTimeout,
    defineProps: () => ({ groupId: 'group', pending: uploading, attachment: { id: 'file', fileName: name, contentType: 'application/octet-stream', byteSize: 4 } }),
    defineEmits: () => vi.fn(), chatMediaFormat, chatMediaFrameStyle, fetchFilePreview, fetchChatThumbnail, AbortController,
    URL: { createObjectURL, revokeObjectURL },
    IntersectionObserver: class { constructor(callback: typeof callbacks[number]) { callbacks.push(callback); } observe() {} disconnect = disconnect; },
  })) as { frame: {value: unknown}; source: {value: string}; failed: {value: boolean}; loadingFailed: {value: boolean}; load(): Promise<void>; release(): void; decodeFailed(): void };
  media.frame.value = { closest: () => null }; mount();
  return { scope, media, cache, requestStarted, callbacks, fetchFilePreview, fetchChatThumbnail, createObjectURL, revokeObjectURL, resolve: (blob: Blob | null) => resolve(blob), disconnect };
}
it('离开区域取消读取，迟到内容不能创建 URL 或写入缓存', async () => {
  const f = setup();
  const loading = f.media.load(); await f.requestStarted;
  f.callbacks[0]([{ isIntersecting: false }]);
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.createObjectURL).not.toHaveBeenCalled();
  expect(f.cache.write).not.toHaveBeenCalled();
  f.scope.stop(); expect(f.disconnect).toHaveBeenCalledOnce();
});
it('视频列表只加载封面，不下载或解码原视频', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted;
  expect(f.fetchChatThumbnail).toHaveBeenCalledOnce();
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  expect(f.cache.write).toHaveBeenCalledWith('image', 'group', expect.any(Blob), 'cover:file');
  expect(f.createObjectURL.mock.calls[0][0].type).toBe('image/jpeg');
  f.scope.stop(); expect(f.revokeObjectURL).toHaveBeenCalledOnce();
});
it('缓存命中不重复下载视频封面', async () => {
  const f = setup('test.mp4', new Blob(['cached']));
  await f.media.load();
  expect(f.fetchChatThumbnail).not.toHaveBeenCalled();
  expect(f.media.source.value).toBe('blob:media');
  f.media.release(); await f.media.load();
  expect(f.cache.read).toHaveBeenCalledTimes(2);
  expect(f.createObjectURL).toHaveBeenCalledTimes(2);
  f.scope.stop();
});
it('发送中的图片文件只请求临时缩略图', async () => {
  const f = setup('test.gif', null, true);
  const loading = f.media.load(); await f.requestStarted;
  expect(f.fetchChatThumbnail).toHaveBeenCalledExactlyOnceWith('group', 'file', expect.any(AbortSignal), 'file', true);
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  expect(f.cache.write).not.toHaveBeenCalled();
  f.scope.stop();
});
it('上传封面暂缺时补查一次，离屏期间取消补查', async () => {
  vi.useFakeTimers();
  const f = setup('test.gif', null, true);
  try {
    const first = f.media.load(); await f.requestStarted; f.resolve(null); await first;
    f.callbacks[0]([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.fetchChatThumbnail).toHaveBeenCalledOnce();
    f.callbacks[0]([{ isIntersecting: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
    f.resolve(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.media.failed.value).toBe(true);
    expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
  } finally { f.scope.stop(); vi.useRealTimers(); }
});

it('上传封面稍后就绪时，原位显示补查结果', async () => {
  vi.useFakeTimers();
  const f = setup('test.gif', null, true);
  try {
    const first = f.media.load(); await f.requestStarted; f.resolve(null); await first;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
    f.resolve(new Blob(['cover'])); await vi.advanceTimersByTimeAsync(0);
    expect(f.media.source.value).toBe('blob:media');
    expect(f.cache.write).not.toHaveBeenCalled();
  } finally { f.scope.stop(); vi.useRealTimers(); }
});

it('没有封面时保留文件入口，不转而自动下载原视频', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted; f.resolve(null); await loading;
  expect(f.media.failed.value).toBe(true);
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  expect(f.createObjectURL).not.toHaveBeenCalled();
  f.scope.stop();
});
it('音频、普通文件和完成上传的图片由对应组件处理，封面解码失败丢弃缓存', async () => {
  for (const name of ['test.mp3', 'test.zip', 'test.gif']) {
    const f = setup(name); await f.media.load();
    expect(f.callbacks).toHaveLength(0);
    expect(f.fetchChatThumbnail).not.toHaveBeenCalled();
    f.scope.stop();
  }
  const f = setup(); f.media.decodeFailed();
  expect(f.cache.discard).toHaveBeenCalledWith('image', 'group', 'cover:file'); f.scope.stop();
});
it('清理缓存期间的迟到预览可显示，但不重新写入缓存', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); await f.requestStarted; f.cache.revision++;
  f.resolve(new Blob(['cover'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  expect(f.cache.write).not.toHaveBeenCalled(); f.scope.stop();
});

it('视频封面临时失败后可以手动重试，不判为不支持，也不下载原视频', async () => {
  const f = setup('test.mp4');
  f.fetchChatThumbnail.mockRejectedValueOnce(new Error('network unavailable'));
  await f.media.load();
  expect(f.media.loadingFailed.value).toBe(true);
  expect(f.media.failed.value).toBe(false);
  f.callbacks[0]([{ isIntersecting: false }]);
  f.callbacks[0]([{ isIntersecting: true }]);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(1);
  f.fetchChatThumbnail.mockResolvedValueOnce(new Blob(['cover']));
  // 执行实际模板的失败分支，点击文件卡片中交给用户的按钮。
  const render = new Function('Vue', compile(descriptor.template!.content, { prefixIdentifiers: true }).code)(
    { ...Vue, resolveComponent: (name: string) => name });
  const root = render({ attachment: { id: 'file' }, format: { kind: 'video' },
    loadingFailed: f.media.loadingFailed.value, load: f.media.load }, []);
  const card = root.children.find((child: Vue.VNode) => child.type === 'ChatFileCard');
  const retry = card?.children.find((child: Vue.VNode) => child.props?.['aria-label'] === '重试视频封面');
  expect(retry?.type).toBe('button');
  await retry.props.onClick();
  expect(f.media.source.value).toBe('blob:media');
  expect(f.media.loadingFailed.value).toBe(false);
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  f.scope.stop();
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../auth/authApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';

const { descriptor } = parse(readFileSync(new URL('./ChatFileMedia.vue', import.meta.url), 'utf8'));
const script = descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('media.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.useRealTimers());
function setup(name = 'test.mp4', cached: Blob | null = null, uploading = false) {
  const scope = effectScope();
  let mount!: () => void;
  let resolve!: (blob: Blob | null) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(done => { started = done; });
  const pending = () => new Promise<Blob | null>(done => { resolve = done; started(); });
  const fetchFilePreview = vi.fn(pending);
  const fetchChatThumbnail = vi.fn<typeof import('../chat/chatApi').fetchChatThumbnail>(pending);
  const cache = { revision: 0, read: vi.fn(async () => cached), write: vi.fn(), discard: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:media');
  const revokeObjectURL = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const margins: string[] = [];
  const document = Object.assign(new EventTarget(), { hidden: false });
  const disconnect = vi.fn();
  const media = scope.run(() => runInNewContext(`${compiled}\n({frame,source,coverState,load,release,decodeFailed})`, {
    ref, computed, onScopeDispose, onMounted: (callback: () => void) => { mount = callback; },
    inject: () => cache, ACCOUNT_CACHE: Symbol(), Blob, setTimeout, clearTimeout, ApiRequestError, document,
    defineProps: () => ({ groupId: 'group', pending: uploading, attachment: { id: 'file', fileName: name, contentType: 'application/octet-stream', byteSize: 4 } }),
    defineEmits: () => vi.fn(), chatMediaFormat, chatMediaFrameStyle, fetchFilePreview, fetchChatThumbnail, AbortController,
    URL: { createObjectURL, revokeObjectURL },
    IntersectionObserver: class {
      constructor(callback: typeof callbacks[number], options: IntersectionObserverInit) {
        callbacks.push(callback); margins.push(options.rootMargin!);
      }
      observe() {} disconnect = disconnect;
    },
  })) as { frame: {value: unknown}; source: {value: string}; coverState: {value: string}; load(): Promise<void>; release(): void; decodeFailed(): void };
  media.frame.value = { closest: () => null }; mount();
  const intersect = (visible: boolean) => callbacks.at(-1)!([{ isIntersecting: visible }]);
  const hide = (hidden: boolean) => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
  return { scope, media, cache, requestStarted, callbacks, margins, intersect, hide, fetchFilePreview, fetchChatThumbnail, createObjectURL, revokeObjectURL, resolve: (blob: Blob | null) => resolve(blob), disconnect };
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
    expect(f.media.coverState.value).toBe('unavailable');
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
  expect(f.media.coverState.value).toBe('unavailable');
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

it('正式封面只在真正可见时自动补试，成功后缓存并恢复预取', async () => {
  vi.useFakeTimers();
  const f = setup('test.mp4');
  f.fetchChatThumbnail.mockRejectedValueOnce(new Error('network unavailable'));
  await f.media.load();
  expect(f.media.coverState.value).toBe('retry');
  expect(f.margins).toEqual(['240px 0px', '0px']);
  // 切换观察范围之前已排队的预取回调不能触发补试。
  f.callbacks[0]([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(1);
  f.fetchChatThumbnail.mockResolvedValueOnce(new Blob(['cover']));
  f.intersect(true);
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(501);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
  expect(f.media.source.value).toBe('blob:media');
  expect(f.media.coverState.value).toBe('ready');
  expect(f.cache.write).toHaveBeenCalledOnce();
  expect(f.margins.at(-1)).toBe('240px 0px');
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  f.scope.stop();
});

it('服务繁忙时最多补试两次，离屏或隐藏期间停止，滚动不重置额度', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.fetchChatThumbnail.mockRejectedValue(new ApiRequestError(429, 'BUSY', '稍后再试'));
  await f.media.load();
  f.intersect(true); f.intersect(false);
  await vi.advanceTimersByTimeAsync(10_000);
  f.intersect(true); f.hide(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(1);
  f.hide(false);
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(7400);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.media.coverState.value).toBe('unavailable');
  f.intersect(false); f.intersect(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(3);
  f.scope.stop();
});

it.each([401, 403, 404])('正式封面返回 %i 时保留文件卡片，停止请求', async status => {
  vi.useFakeTimers();
  const f = setup();
  f.fetchChatThumbnail.mockRejectedValue(new ApiRequestError(status, 'UNAVAILABLE', '无法读取'));
  await f.media.load();
  f.intersect(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.media.coverState.value).toBe('unavailable');
  expect(f.fetchChatThumbnail).toHaveBeenCalledOnce();
  f.scope.stop();
});

it('最后一次补试已发出时隐藏窗口，取消请求且返回前台不会再发', async () => {
  vi.useFakeTimers();
  const f = setup();
  const timeout = new DOMException('timeout', 'TimeoutError');
  f.fetchChatThumbnail.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);
  await f.media.load();
  f.intersect(true);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(3);
  const signal = f.fetchChatThumbnail.mock.lastCall![2];
  f.hide(true);
  expect(signal.aborted).toBe(true);
  f.hide(false); f.intersect(true); f.resolve(new Blob(['late']));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(3);
  expect(f.cache.write).not.toHaveBeenCalled();
  f.scope.stop();
});

it('切群销毁卡片后取消补试，迟到的补试结果不能写入缓存', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.fetchChatThumbnail.mockRejectedValueOnce(new ApiRequestError(503, 'BUSY', '稍后再试'));
  await f.media.load();
  f.intersect(true);
  await vi.advanceTimersByTimeAsync(2500);
  f.scope.stop();
  f.resolve(new Blob(['late']));
  f.intersect(true); f.hide(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.cache.write).not.toHaveBeenCalled();
  expect(f.createObjectURL).not.toHaveBeenCalled();
  expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(2);
});

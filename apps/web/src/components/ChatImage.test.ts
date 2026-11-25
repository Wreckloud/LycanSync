import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFrameStyle } from '../chat/chatMedia';
import type { AccountCache } from '../cache/localCache';
import { ApiRequestError } from '../auth/authApi';

const script = parse(readFileSync(new URL('./ChatImage.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('ChatImage.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

async function settleRequests() {
  // VM 的 await 会跨 Promise realm；等待其转交及 Vue 监听完成，不依赖真实计时器。
  for (let turn = 0; turn < 4; turn++) await nextTick();
}

function setup(cache: AccountCache | null = null, byteSize = 20) {
  const scope = effectScope();
  const props = reactive({ groupId: 'first', attachmentId: 'image', width: 20, height: 10, byteSize, alt: '图片' });
  const observers: FakeObserver[] = [];
  class FakeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly notify: (entries: Array<{ isIntersecting: boolean }>) => void,
      readonly options: IntersectionObserverInit) { observers.push(this); }
    intersect() { this.notify([{ isIntersecting: true }]); }
    leave() { this.notify([{ isIntersecting: false }]); }
  }
  const pending: Array<{ resolve: (blob: Blob) => void; reject: (error: Error) => void; signal: AbortSignal }> = [];
  const fetchAttachment = vi.fn((_group: string, _image: string, signal: AbortSignal) => new Promise<Blob>((resolve, reject) => {
    pending.push({ resolve, reject, signal });
  }));
  const fetchChatThumbnail = vi.fn<() => Promise<Blob | null>>().mockResolvedValue(null);
  const createObjectURL = vi.fn(() => `blob:preview-${pending.length}`);
  const revokeObjectURL = vi.fn();
  // 回调可以在断开观察之后人工送达，验证正式监听/销毁边界，不读取图片或运行浏览器。
  const emit = vi.fn();
  const image = scope.run(() => runInNewContext(`${compiled}\n({ frame, source, thumbnail, error, originalAction, observeFrame, load, imageFailed, openImage })`, {
    computed, ref, watch, onScopeDispose, onMounted: () => {}, defineProps: () => props, defineEmits: () => emit,
    chatMediaFrameStyle, inject: () => cache, ACCOUNT_CACHE: Symbol(), Blob, ApiRequestError,
    fetchAttachment, fetchChatThumbnail, fetchFilePreview: fetchAttachment, AbortController, Error, IntersectionObserver: FakeObserver,
    URL: { createObjectURL, revokeObjectURL },
  })) as { frame: { value: HTMLElement | null }; source: { value: string }; error: { value: string };
    thumbnail: { value: boolean }; originalAction: { value: string }; observeFrame: () => void; load: () => Promise<void>; imageFailed: () => Promise<void>; openImage: () => void };
  image.frame.value = { closest: () => null } as unknown as HTMLElement;
  image.observeFrame();
  return { scope, props, image, observers, pending, fetchAttachment, fetchChatThumbnail, createObjectURL, revokeObjectURL, emit };
}

it('可见时仅加载缩略图，手动加载完成后替换并复用原图', async () => {
  const f = setup();
  const original = new Blob(['original']);
  f.fetchChatThumbnail.mockResolvedValue(new Blob(['thumbnail']));
  try {
    f.observers[0].intersect();
    await settleRequests();
    expect(f.fetchChatThumbnail).toHaveBeenCalledExactlyOnceWith('first', 'image', expect.any(AbortSignal), 'image');
    expect(f.fetchAttachment).not.toHaveBeenCalled();
    expect(f.image.thumbnail.value).toBe(true);
    f.image.openImage();
    expect(f.image.thumbnail.value).toBe(true);
    f.pending[0].resolve(original);
    await settleRequests();
    expect(f.image.thumbnail.value).toBe(false);
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:preview-0');
    f.image.openImage();
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('preview', original);
    expect(f.fetchAttachment).toHaveBeenCalledOnce();
  } finally { f.scope.stop(); }
});

it.each([8 * 1024 ** 2 + 1, 32 * 1024 ** 2, 32 * 1024 ** 2 + 1])('主动查看的 %i 字节原图按上限保存，返回时读取对应版本', async byteSize => {
  const entries = new Map<string, Blob>();
  const cache = { revision: 0, read: vi.fn(async (_kind, _group, key) => entries.get(key)),
    write: vi.fn(async (_kind, _group, blob, key) => entries.set(key, blob)) } as unknown as AccountCache;
  const f = setup(cache, byteSize);
  const retained = byteSize <= 32 * 1024 ** 2;
  try {
    f.fetchChatThumbnail.mockResolvedValue(new Blob(['thumbnail']));
    expect(f.image.originalAction.value).toBe(retained ? '加载原图' : '临时查看原图');
    const loading = f.image.load();
    await settleRequests();
    f.pending[0].resolve(new Blob([new ArrayBuffer(byteSize)]));
    await loading;
    f.observers[1].leave(); f.observers[1].intersect(); f.observers[0].intersect();
    await vi.waitFor(() => expect(f.image.source.value).not.toBe(''));
    expect(f.image.thumbnail.value).toBe(!retained);
    expect(f.fetchAttachment).toHaveBeenCalledOnce();
    expect(entries.has('image')).toBe(retained);
  } finally { f.scope.stop(); }
});

it.each([204, 403, 429, 503])('缩略图响应 %i 时只对临时故障补查一次', async status => {
  const f = setup();
  try {
    if (status !== 204) f.fetchChatThumbnail.mockRejectedValue(new ApiRequestError(status, '', '读取失败'));
    for (let entry = 0; entry < 3; entry++) {
      f.observers[0].intersect(); await settleRequests();
      f.observers[0].intersect(); await settleRequests();
      f.observers[0].leave();
    }
    expect(f.fetchChatThumbnail).toHaveBeenCalledTimes(status === 429 || status === 503 ? 2 : 1);
    f.image.openImage();
    expect(f.fetchAttachment).toHaveBeenCalledOnce();
    f.pending[0].resolve(new Blob(['original'])); await settleRequests();
    expect(f.image.source.value).not.toBe('');
  } finally { f.scope.stop(); }
});

it('磁盘图片命中不重新下载，远离后仍释放解码引用，再返回可重新读取缓存', async () => {
  const cache = { read: vi.fn().mockResolvedValue(new Blob(['cached image'])), write: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  try {
    f.observers[0].intersect();
    await settleRequests();
    expect(f.fetchAttachment).not.toHaveBeenCalled();
    expect(f.createObjectURL).toHaveBeenCalledOnce();
    f.observers[1].leave();
    expect(f.revokeObjectURL).toHaveBeenCalledOnce();
    expect(f.image.source.value).toBe('');
    f.observers[1].intersect();
    await settleRequests();
    expect(cache.read).toHaveBeenCalledTimes(2);
    expect(f.fetchAttachment).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('损坏的缓存图片只重试下载一次，下载图仍损坏则保留明确错误', async () => {
  const cache = { read: vi.fn().mockResolvedValue(new Blob(['bad image'])), write: vi.fn(), discard: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn() } as AccountCache;
  const f = setup(cache);
  try {
    await f.image.load();
    const retry = f.image.imageFailed();
    await settleRequests();
    expect(cache.discard).toHaveBeenCalledWith('image', 'first', 'image');
    expect(f.fetchAttachment).toHaveBeenCalledOnce();
    f.pending[0].resolve(new Blob(['still invalid']));
    await retry;
    await f.image.imageFailed();
    expect(f.fetchAttachment).toHaveBeenCalledOnce();
    expect(f.image.source.value).toBe('');
    expect(f.image.error.value).toBe('图片加载失败');
  } finally { f.scope.stop(); }
});

it('清理之前开始的图片下载可显示但不重新写回磁盘', async () => {
  let revision = 0;
  const cache = { read: vi.fn().mockResolvedValue(null), write: vi.fn(), discard: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), get revision() { return revision; }, dispose: vi.fn() } as AccountCache;
  const f = setup(cache);
  try {
    const loading = f.image.load();
    await settleRequests();
    revision++;
    f.pending[0].resolve(new Blob(['late']));
    await loading;
    expect(f.image.source.value).not.toBe('');
    expect(cache.write).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('销毁后旧可见回调不重开请求，不创建新的预览URL', async () => {
  const { scope, observers, fetchAttachment, image } = setup();
  scope.stop();
  observers[0].intersect();
  const loading = image.load();
  expect(fetchAttachment).not.toHaveBeenCalled();
  await loading;
  expect(image.source.value).toBe('');
});

it('更换附件后旧观察器回调失效，进入视口仅自动请求缩略图', async () => {
  const { scope, props, image, observers, pending, fetchAttachment, fetchChatThumbnail } = setup();
  try {
    props.attachmentId = 'new-image';
    await nextTick();
    observers[0].intersect();
    expect(fetchAttachment).not.toHaveBeenCalled();
    observers[2].intersect();
    observers[2].intersect();
    expect(fetchChatThumbnail).toHaveBeenCalledExactlyOnceWith('first', 'new-image', expect.any(AbortSignal), 'image');
    expect(fetchAttachment).not.toHaveBeenCalled();
    void image.load();
    expect(fetchAttachment).toHaveBeenCalledExactlyOnceWith('first', 'new-image', expect.any(AbortSignal), expect.any(Function));
    pending[0].resolve(new Blob(['image']));
    await settleRequests();
    expect(image.source.value).toBe('blob:preview-1');
  } finally { scope.stop(); }
});

it('旧请求迟到不创建URL，当前失败只在明确重试时重新加载', async () => {
  const { scope, props, image, observers, pending, createObjectURL, fetchAttachment } = setup();
  try {
    observers[0].intersect();
    void image.load();
    props.attachmentId = 'new-image';
    await nextTick();
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve(new Blob(['old']));
    await settleRequests();
    expect(createObjectURL).not.toHaveBeenCalled();
    observers[2].intersect();
    void image.load();
    pending[1].reject(new Error('读取失败'));
    await settleRequests();
    expect(image.error.value).toBe('读取失败');
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    const retrying = image.load();
    pending[2].resolve(new Blob(['new']));
    await retrying;
    expect(image.error.value).toBe('');
    expect(image.source.value).toBe('blob:preview-3');
  } finally { scope.stop(); }
});

it('成功预览的URL在更换附件和销毁时各自释放', async () => {
  const { scope, props, image, observers, pending, revokeObjectURL } = setup();
  observers[0].intersect();
  void image.load();
  pending[0].resolve(new Blob(['first']));
  await settleRequests();
  props.attachmentId = 'second';
  await nextTick();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  observers[2].intersect();
  void image.load();
  pending[1].resolve(new Blob(['second']));
  await settleRequests();
  scope.stop();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
  expect(image.source.value).toBe('');
});

it('邻近区域保留图片，远离后释放URL，回到附近只重新加载一次且尺寸不变', async () => {
  const { scope, image, observers, pending, fetchAttachment, revokeObjectURL } = setup();
  try {
    expect(observers[0].options.rootMargin).toBe('180px 0px');
    expect(observers[1].options.rootMargin).toBe('1200px 0px');
    observers[1].intersect();
    observers[0].intersect();
    void image.load();
    pending[0].resolve(new Blob(['first']));
    await settleRequests();
    observers[0].leave();
    expect(image.source.value).toBe('blob:preview-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    observers[1].leave();
    expect(image.source.value).toBe('');
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
    observers[0].intersect();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    observers[1].intersect();
    observers[0].intersect();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    void image.load();
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    pending[1].resolve(new Blob(['second']));
    await settleRequests();
    expect(image.source.value).toBe('blob:preview-2');
  } finally { scope.stop(); }
});

it('远离时取消在途图片，迟到结果不占用URL，旧保留观察器也不能清除新图片', async () => {
  const { scope, props, image, observers, pending, createObjectURL } = setup();
  try {
    observers[0].intersect();
    void image.load();
    observers[1].leave();
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve(new Blob(['late']));
    await settleRequests();
    expect(createObjectURL).not.toHaveBeenCalled();
    props.attachmentId = 'new-image'; await nextTick();
    observers[2].intersect();
    void image.load();
    pending[1].resolve(new Blob(['new']));
    await settleRequests();
    observers[1].leave();
    expect(image.source.value).toBe('blob:preview-2');
    scope.stop();
    observers[2].intersect(); observers[3].intersect();
    expect(pending).toHaveLength(2);
  } finally { scope.stop(); }
});

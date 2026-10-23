import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./ChatImage.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('ChatImage.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

async function settleRequests() {
  // VM 的 await 会跨 Promise realm；等待其转交及 Vue 监听完成，不依赖真实计时器。
  for (let turn = 0; turn < 4; turn++) await nextTick();
}

function setup() {
  const scope = effectScope();
  const props = reactive({ groupId: 'first', attachmentId: 'image', width: 20, height: 10, alt: '图片' });
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
  const createObjectURL = vi.fn(() => `blob:preview-${pending.length}`);
  const revokeObjectURL = vi.fn();
  // 回调可以在断开观察之后人工送达，验证正式监听/销毁边界，不读取图片或运行浏览器。
  const image = scope.run(() => runInNewContext(`${compiled}\n({ frame, source, error, observeFrame, load })`, {
    computed, ref, watch, onScopeDispose, onMounted: () => {}, defineProps: () => props,
    fetchAttachment, AbortController, Error, IntersectionObserver: FakeObserver,
    URL: { createObjectURL, revokeObjectURL },
  })) as { frame: { value: HTMLElement | null }; source: { value: string }; error: { value: string };
    observeFrame: () => void; load: () => Promise<void> };
  image.frame.value = { closest: () => null } as unknown as HTMLElement;
  image.observeFrame();
  return { scope, props, image, observers, pending, fetchAttachment, createObjectURL, revokeObjectURL };
}

it('销毁后旧可见回调不重开请求，不创建新的预览URL', async () => {
  const { scope, observers, fetchAttachment, image } = setup();
  scope.stop();
  observers[0].intersect();
  const loading = image.load();
  expect(fetchAttachment).not.toHaveBeenCalled();
  await loading;
  expect(image.source.value).toBe('');
});

it('更换附件后旧观察器回调失效，当前观察器只触发一次加载', async () => {
  const { scope, props, image, observers, pending, fetchAttachment } = setup();
  try {
    props.attachmentId = 'new-image';
    await nextTick();
    observers[0].intersect();
    expect(fetchAttachment).not.toHaveBeenCalled();
    observers[2].intersect();
    observers[2].intersect();
    expect(fetchAttachment).toHaveBeenCalledExactlyOnceWith('first', 'new-image', expect.any(AbortSignal));
    pending[0].resolve(new Blob(['image']));
    await settleRequests();
    expect(image.source.value).toBe('blob:preview-1');
  } finally { scope.stop(); }
});

it('旧请求迟到不创建URL，当前失败只在明确重试时重新加载', async () => {
  const { scope, props, image, observers, pending, createObjectURL, fetchAttachment } = setup();
  try {
    observers[0].intersect();
    props.attachmentId = 'new-image';
    await nextTick();
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve(new Blob(['old']));
    await settleRequests();
    expect(createObjectURL).not.toHaveBeenCalled();
    observers[2].intersect();
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
  pending[0].resolve(new Blob(['first']));
  await settleRequests();
  props.attachmentId = 'second';
  await nextTick();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  observers[2].intersect();
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
    observers[1].leave();
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve(new Blob(['late']));
    await settleRequests();
    expect(createObjectURL).not.toHaveBeenCalled();
    props.attachmentId = 'new-image'; await nextTick();
    observers[2].intersect();
    pending[1].resolve(new Blob(['new']));
    await settleRequests();
    observers[1].leave();
    expect(image.source.value).toBe('blob:preview-2');
    scope.stop();
    observers[2].intersect(); observers[3].intersect();
    expect(pending).toHaveLength(2);
  } finally { scope.stop(); }
});

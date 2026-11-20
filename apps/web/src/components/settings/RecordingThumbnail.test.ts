import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./RecordingThumbnail.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('thumbnail.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function setup(disabled = false) {
  const scope = effectScope();
  const props = reactive({ source: 'lycan://app/recordings/test', disabled });
  const emit = vi.fn();
  let mount!: () => void;
  let intersect!: (entries: { isIntersecting: boolean }[]) => void;
  let resolve!: (cover: ImageData) => void;
  const loadRecordingThumbnail = vi.fn((_source: string, _signal: AbortSignal) => new Promise<ImageData>(yes => { resolve = yes; }));
  const putImageData = vi.fn();
  const thumbnail = scope.run(() => runInNewContext(`${compiled}\n({frame,canvas,ready})`, {
    ref, watch, onScopeDispose, AbortController, loadRecordingThumbnail, recordingThumbnailDuration: () => 2317,
    onMounted: (callback: () => void) => { mount = callback; },
    defineProps: () => props, defineEmits: () => emit,
    IntersectionObserver: class { constructor(callback: typeof intersect) { intersect = callback; } observe() {} disconnect() {} },
  })) as { frame: { value: unknown }; canvas: { value: unknown }; ready: { value: boolean } };
  thumbnail.frame.value = {};
  thumbnail.canvas.value = { width: 0, height: 0, getContext: () => ({ putImageData }) }; mount();
  return { scope, props, emit, thumbnail, loadRecordingThumbnail, putImageData, resolve: () => resolve({ width: 240, height: 135 } as ImageData), visible: (value: boolean) => intersect([{ isIntersecting: value }]) };
}
it('可见时才请求封面，保留像素，不因滚出后返回重复请求', async () => {
  const f = setup(); expect(f.loadRecordingThumbnail).not.toHaveBeenCalled();
  f.visible(true); f.resolve();
  await vi.waitFor(() => expect(f.putImageData).toHaveBeenCalledOnce());
  expect(f.emit).toHaveBeenCalledWith('duration', 2317);
  f.visible(false); f.visible(true); expect(f.loadRecordingThumbnail).toHaveBeenCalledOnce(); f.scope.stop();
});
it('滚出或销毁取消排队和解码，迟到内容不再绘制', async () => {
  const f = setup(); f.visible(true); f.visible(false);
  expect(f.loadRecordingThumbnail.mock.calls[0]![1].aborted).toBe(true);
  f.resolve(); await Promise.resolve(); expect(f.putImageData).not.toHaveBeenCalled();
  f.scope.stop(); f.visible(true); expect(f.loadRecordingThumbnail).toHaveBeenCalledOnce();
});
it('录制中或不可用文件不读取封面', () => {
  const f = setup(true); f.visible(true); expect(f.loadRecordingThumbnail).not.toHaveBeenCalled(); f.scope.stop();
});

it('切换来源取消旧解码，重新启用可见封面时加载当前文件', async () => {
  const f = setup();
  try {
    f.visible(true);
    const finishOld = f.resolve;
    f.props.disabled = true;
    await nextTick();
    expect(f.loadRecordingThumbnail.mock.calls[0]![1].aborted).toBe(true);
    finishOld();
    await Promise.resolve();
    expect(f.putImageData).not.toHaveBeenCalled();
    f.props.source = 'lycan://app/recordings/new';
    f.props.disabled = false;
    await nextTick();
    expect(f.loadRecordingThumbnail.mock.calls[1]![0]).toBe(f.props.source);
    f.resolve();
    await vi.waitFor(() => expect(f.thumbnail.ready.value).toBe(true));
    f.props.source = '';
    f.props.disabled = true;
    await nextTick();
    expect(f.thumbnail.ready.value).toBe(false);
    expect(f.loadRecordingThumbnail).toHaveBeenCalledTimes(2);
  } finally { f.scope.stop(); }
});

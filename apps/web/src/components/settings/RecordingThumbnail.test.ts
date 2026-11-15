import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./RecordingThumbnail.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('thumbnail.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup(disabled = false) {
  const scope = effectScope();
  let mount!: () => void;
  let frameReady!: () => void;
  const bitmap = { width: 240, height: 135, close: vi.fn() };
  const createImageBitmap = vi.fn(async () => bitmap);
  let intersect!: (entries: { isIntersecting: boolean }[]) => void;
  const video = { play: vi.fn(async () => {}), requestVideoFrameCallback: vi.fn((callback: () => void) => { frameReady = callback; }), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), duration: 12,
    videoWidth: 1920, videoHeight: 1080, currentTime: 0,
    onloadedmetadata: null as (() => void) | null, onseeked: null as (() => void) | null };
  const createElement = vi.fn(() => video);
  const drawImage = vi.fn();
  const thumbnail = scope.run(() => runInNewContext(`${compiled}\n({frame,canvas,ready})`, {
    ref, onScopeDispose, setTimeout, clearTimeout, createImageBitmap, onMounted: (callback: () => void) => { mount = callback; },
    defineProps: () => ({ source: 'lycan://app/recordings/test', disabled }), defineEmits: () => vi.fn(),
    document: { createElement }, IntersectionObserver: class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {} disconnect() {}
    },
  })) as { frame: { value: unknown }; canvas: { value: unknown }; ready: { value: boolean } };
  thumbnail.frame.value = {};
  thumbnail.canvas.value = { width: 0, height: 0, getContext: () => ({ drawImage, getImageData: vi.fn(), putImageData: vi.fn() }) };
  mount();
  return { scope, thumbnail, video, bitmap, createImageBitmap, frameReady: () => frameReady(), createElement, drawImage, visible: (value: boolean) => intersect([{ isIntersecting: value }]) };
}

it('可见时才取帧，收到可用帧后保留缩略图并释放播放器', async () => {
  const f = setup();
  expect(f.createElement).not.toHaveBeenCalled();
  f.visible(true);
  f.video.onloadedmetadata!();
  expect(f.video.currentTime).toBe(0.1);
  f.video.onseeked!();
  expect(f.drawImage).not.toHaveBeenCalled();
  f.frameReady();
  await vi.waitFor(() => expect(f.drawImage).toHaveBeenCalledWith(f.bitmap, 0, 0));
  expect(f.bitmap.close).toHaveBeenCalledOnce();
  expect(f.thumbnail.ready.value).toBe(true);
  expect(f.video.removeAttribute).toHaveBeenCalledWith('src');
  expect(f.video.pause).toHaveBeenCalled();
  f.visible(false); f.visible(true);
  expect(f.createElement).toHaveBeenCalledOnce();
  f.scope.stop();
});

it('滚出或销毁后释放读取，迟到回调不会绘制或重启解码', () => {
  const f = setup();
  f.visible(true);
  const late = f.video.onseeked!;
  f.visible(false); late();
  expect(f.drawImage).not.toHaveBeenCalled();
  f.scope.stop(); f.visible(true);
  expect(f.createElement).toHaveBeenCalledOnce();
});

it('录制中或不可用的文件不尝试生成缩略图', () => {
  const f = setup(true);
  f.visible(true);
  expect(f.createElement).not.toHaveBeenCalled();
  f.scope.stop();
});

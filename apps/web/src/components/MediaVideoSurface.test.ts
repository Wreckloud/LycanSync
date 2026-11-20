import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./MediaVideoSurface.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('video.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup(width: number, height: number) {
  const scope = effectScope();
  const emit = vi.fn();
  const video = { videoWidth: width, videoHeight: height, duration: 5, pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
  const surface = scope.run(() => runInNewContext(`${compiled}\n({player,failed,aspectRatio,measureVideo,playbackFailed})`, {
    ref, onScopeDispose, defineExpose: () => {}, onMounted: () => {}, defineProps: () => ({ source: 'blob:video' }), defineEmits: () => emit,
  })) as { player: {value: unknown}; failed: {value: boolean}; aspectRatio: {value: number}; measureVideo(): void; playbackFailed(): void };
  surface.player.value = video;
  return { scope, emit, video, surface };
}

it('容器只有音轨可用时关闭空白播放器并报告一次失败，避免继续播放声音', () => {
  const f = setup(0, 0);
  f.surface.measureVideo();
  f.surface.playbackFailed();
  expect(f.surface.failed.value).toBe(true);
  expect(f.emit).toHaveBeenCalledExactlyOnceWith('error', undefined);
  expect(f.video.pause).toHaveBeenCalledOnce();
  expect(f.video.removeAttribute).toHaveBeenCalledWith('src');
  expect(f.video.load).toHaveBeenCalledOnce();
  f.scope.stop();
});

it('有效画面按原始比例显示，离开查看器停止播放并释放来源', () => {
  const f = setup(544, 968);
  f.surface.measureVideo();
  expect(f.surface.failed.value).toBe(false);
  expect(f.surface.aspectRatio.value).toBe(544 / 968);
  expect(f.emit).toHaveBeenCalledWith('metadata', 5);
  f.scope.stop();
  expect(f.video.pause).toHaveBeenCalledOnce();
  expect(f.video.removeAttribute).toHaveBeenCalledWith('src');
});

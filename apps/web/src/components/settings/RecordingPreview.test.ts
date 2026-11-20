import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./RecordingPreview.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('preview.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const scope = effectScope();
  const target = new EventTarget();
  const positions: number[] = [];
  const video = { seeking: false, paused: true, removeAttribute: vi.fn(), load: vi.fn(), pause: vi.fn(), play: vi.fn(async () => {}),
    addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target),
    get currentTime() { return positions.at(-1) ?? 0; },
    set currentTime(value: number) { positions.push(value); video.seeking = true; } };
  const preview = scope.run(() => runInNewContext(`${compiled}\n({player,start,end,metadata,position,play,shareRecording,edit,rate,step,cursor})`, {
    ref, computed, onScopeDispose, onMounted: vi.fn(), cancelAnimationFrame: vi.fn(), setTimeout, clearTimeout, crypto,
    defineProps: () => ({ entry: { id: 'test' }, source: 'test' }), defineEmits: () => vi.fn(),
    inject: () => ({ select: vi.fn() }), RECORDING_SHARE: Symbol(), window: {}, useBackdropDismiss: () => ({}),
  })) as { player: { value: unknown }; cursor: { value: number }; rate: { value: number }; edit(): void; step(marker: string, direction: number): void; start: { value: number }; end: { value: number }; metadata(seconds: number): void;
    position(edge: 'start' | 'end' | 'cursor', seconds: number, precise?: boolean): void; play(fromStart: boolean): void; shareRecording(): void };
  preview.player.value = video; preview.metadata(10);
  return { scope, preview, video, positions, seeked: () => { video.seeking = false; target.dispatchEvent(new Event('seeked')); } };
}
it('拖动合并中间目标，尚未完成的寻帧不被打断，松手后定位最新位置', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) { f.preview.position('start', index / 10, false); }
  expect(f.positions).toEqual([]); vi.advanceTimersByTime(80);
  expect(f.positions).toEqual([1.9]);
  f.preview.position('start', 3, false); vi.advanceTimersByTime(80);
  f.preview.position('start', 4, true);
  expect(f.positions).toEqual([1.9]); f.seeked();
  expect(f.positions).toEqual([1.9, 4]); f.scope.stop();
});
it('松手直接定位，预览片段不会被旧定时任务覆盖', async () => {
  const f = fixture(); f.preview.cursor.value = 2; f.preview.edit();
  expect(f.positions).toEqual([2]); f.seeked();
  f.preview.position('end', 7, false);
  f.preview.play(true); await vi.runAllTimersAsync();
  expect(f.positions).toEqual([2, 2]); expect(f.video.play).toHaveBeenCalledOnce(); f.scope.stop();
});
it('分享或卸载取消延迟寻帧与等待监听', () => {
  for (const dispose of [false, true]) {
    const f = fixture(); f.preview.position('start', 1, true);
    f.preview.position('start', 4, true);
    if (dispose) f.scope.stop(); else f.preview.shareRecording();
    f.seeked(); vi.runAllTimers(); expect(f.positions).toEqual([1]); f.scope.stop();
  }
});

it('长录像从当前帧预选 12 秒，片尾按剩余时间截取', () => {
  const f = fixture();
  f.preview.metadata(1240); f.preview.rate.value = 60;
  f.preview.cursor.value = 720; f.preview.edit();
  expect([f.preview.start.value, f.preview.end.value]).toEqual([720, 732]);
  f.preview.cursor.value = 1237; f.preview.edit();
  expect([f.preview.start.value, f.preview.end.value]).toEqual([1237, 1240]);
  f.scope.stop();
});

it('两个边界靠拢时保留整帧，片尾不足一帧时仍可选到文件末尾', () => {
  const f = fixture();
  f.preview.metadata(10.01); f.preview.rate.value = 24;
  f.preview.position('end', 2, true);
  f.preview.position('start', 3, true);
  expect(f.preview.start.value).toBe(45 / 24);
  f.preview.position('end', 1, true);
  expect(f.preview.end.value).toBe(2);
  f.preview.position('end', 10.01, true);
  expect(f.preview.end.value).toBe(10.01);
  expect(f.preview.cursor.value).toBe(10);
  f.scope.stop();
});

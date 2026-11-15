import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFormat } from '../chat/chatMedia';

const script = parse(readFileSync(new URL('./ChatFileMedia.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('media.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function setup(name = 'test.gif') {
  const scope = effectScope();
  let mount!: () => void;
  let resolve!: (blob: Blob) => void;
  const fetchFilePreview = vi.fn(() => new Promise<Blob>(done => { resolve = done; }));
  const createObjectURL = vi.fn(() => 'blob:media');
  const revokeObjectURL = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const disconnect = vi.fn();
  const media = scope.run(() => runInNewContext(`${compiled}\n({frame,player,source,failed,load,release,decodeFailed})`, {
    ref, computed, onScopeDispose, onMounted: (callback: () => void) => { mount = callback; },
    defineProps: () => ({ groupId: 'group', attachment: { id: 'file', fileName: name, contentType: 'application/octet-stream', byteSize: 4 } }),
    defineEmits: () => vi.fn(), chatMediaFormat, fetchFilePreview, AbortController,
    URL: { createObjectURL, revokeObjectURL },
    IntersectionObserver: class { constructor(callback: typeof callbacks[number]) { callbacks.push(callback); } observe() {} disconnect = disconnect; },
  })) as { frame: {value: unknown}; player: {value: unknown}; source: {value: string}; failed: {value: boolean}; load(): Promise<void>; release(): void; decodeFailed(): void };
  media.frame.value = { closest: () => null }; mount();
  return { scope, media, callbacks, fetchFilePreview, createObjectURL, revokeObjectURL, resolve: (blob: Blob) => resolve(blob), disconnect };
}
it('媒体只在进入可见区域后加载，离开区域中止请求且迟到内容不能恢复', async () => {
  const f = setup();
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  const loading = f.media.load();
  f.callbacks[0]([{ isIntersecting: false }]);
  f.resolve(new Blob(['gif'])); await loading;
  expect(f.createObjectURL).not.toHaveBeenCalled();
  f.scope.stop(); expect(f.disconnect).toHaveBeenCalledTimes(2);
});
it('GIF 保留原始文件，销毁释放内容，离开可见范围暂停播放', async () => {
  const f = setup();
  const loading = f.media.load(); f.resolve(new Blob(['gif'])); await loading;
  expect(f.media.source.value).toBe('blob:media');
  const player = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() }; f.media.player.value = player;
  f.callbacks[1]([{ isIntersecting: false }]); expect(player.pause).toHaveBeenCalled();
  f.scope.stop(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:media');
});
it('无法解码后停止加载并回到普通下载卡片', async () => {
  const f = setup('test.mp4');
  const loading = f.media.load(); f.resolve(new Blob(['bad'])); await loading;
  f.media.decodeFailed(); await f.media.load();
  expect(f.media.failed.value).toBe(true); expect(f.fetchFilePreview).toHaveBeenCalledOnce();
  expect(f.revokeObjectURL).toHaveBeenCalledOnce(); f.scope.stop();
});
it('不支持的文件不自动读取文件内容', async () => {
  const f = setup('test.zip'); await f.media.load();
  expect(f.callbacks).toHaveLength(0); expect(f.fetchFilePreview).not.toHaveBeenCalled(); f.scope.stop();
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFormat } from '../chat/chatMedia';

const script = parse(readFileSync(new URL('./ChatMediaViewer.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('viewer.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup(imageMessage = false) {
  const scope = effectScope();
  const pending: Array<{ resolve(blob: Blob): void; signal: AbortSignal }> = [];
  const fetchFilePreview = vi.fn((_group: string, _id: string, signal: AbortSignal) =>
    new Promise<Blob>(resolve => pending.push({ resolve, signal })));
  const fetchAttachment = vi.fn(fetchFilePreview);
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:preview');
  const revokeObjectURL = vi.fn();
  const emit = vi.fn();
  const viewer = scope.run(() => runInNewContext(`${compiled}\n({load,close,source,error,player})`, {
    ref, computed, onScopeDispose, onMounted: () => {}, defineEmits: () => emit,
    defineProps: () => ({ groupId: 'group', imageMessage,
      attachment: { id: 'file', fileName: imageMessage ? 'test.png' : 'test.mp4', byteSize: 3, contentType: 'application/octet-stream' } }),
    chatMediaFormat, useLoadingHint: () => ref(false), useBackdropDismiss: () => ({}),
    fetchAttachment, fetchFilePreview, downloadFile: vi.fn(), AbortController, Error, DOMException,
    URL: { createObjectURL, revokeObjectURL },
  })) as { load(): Promise<void>; close(): void; source: { value: string }; error: { value: string }; player: { value: unknown } };
  return { scope, viewer, pending, createObjectURL, revokeObjectURL, fetchAttachment, fetchFilePreview, emit };
}

it('关闭取消加载，迟到响应不能创建媒体 URL', async () => {
  const f = setup();
  try {
    const loading = f.viewer.load();
    f.viewer.close();
    expect(f.pending[0].signal.aborted).toBe(true);
    f.pending[0].resolve(new Blob(['late'])); await loading;
    expect(f.createObjectURL).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith('close');
  } finally { f.scope.stop(); }
});

it('关闭停止播放并释放 Blob，重新加载先释放上一份资源', async () => {
  const f = setup();
  try {
    const loading = f.viewer.load(); f.pending[0].resolve(new Blob(['first'])); await loading;
    expect(f.createObjectURL.mock.calls[0][0].type).toBe('video/mp4');
    const player = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    f.viewer.player.value = player;
    const retry = f.viewer.load();
    expect(f.revokeObjectURL).toHaveBeenCalledOnce();
    f.pending[1].resolve(new Blob(['second'])); await retry;
    f.viewer.close();
    expect(player.pause).toHaveBeenCalled();
    expect(player.removeAttribute).toHaveBeenCalledWith('src');
    expect(f.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(f.viewer.source.value).toBe('');
  } finally { f.scope.stop(); }
});

it('原聊天图片继续使用图片接口，不请求普通文件接口', async () => {
  const f = setup(true);
  try {
    const loading = f.viewer.load();
    expect(f.fetchAttachment).toHaveBeenCalledWith('group', 'file', expect.any(AbortSignal));
    f.pending[0].resolve(new Blob(['image'])); await loading;
    expect(f.createObjectURL.mock.calls[0][0].type).toBe('image/png');
  } finally { f.scope.stop(); }
});

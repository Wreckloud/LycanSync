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

function setup(imageMessage = false, desktop = false, previewBlob?: Blob, localSource?: string) {
  const scope = effectScope();
  const pending: Array<{ resolve(blob: Blob): void; signal: AbortSignal }> = [];
  const fetchFilePreview = vi.fn((_group: string, _id: string, signal: AbortSignal) =>
    new Promise<Blob>(resolve => pending.push({ resolve, signal })));
  const fetchAttachment = vi.fn(fetchFilePreview);
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:preview');
  const revokeObjectURL = vi.fn();
  const emit = vi.fn();
  const videoPreviewStatus = vi.fn().mockResolvedValue({ status: 'ready', message: null });
  const fetchCompatibleVideo = vi.fn().mockResolvedValue(new Blob(['converted'], { type: 'video/mp4' }));
  const viewer = scope.run(() => runInNewContext(`${compiled}\n({load,close,source,error,player,convertVideo,playbackFailed,compatible,converting})`, {
    ref, computed, CHAT_TRANSFERS: Symbol(), inject: () => ({ downloads: new Map() }), onScopeDispose, onMounted: () => {}, defineEmits: () => emit,
    defineProps: () => ({ groupId: 'group', imageMessage, previewBlob, localSource,
      attachment: { id: 'file', fileName: imageMessage ? 'test.png' : 'test.mp4', byteSize: 3, contentType: 'application/octet-stream' } }),
    desktopMediaUrl: (_group: string, _id: string, compatible: boolean) => desktop ? '/api/groups/group/files/file/' + (compatible ? 'preview/media' : 'media') : null, chatMediaFormat, useLoadingHint: () => ref(false), useBackdropDismiss: () => ({}),
    videoPreviewStatus, fetchCompatibleVideo, setTimeout, clearTimeout, Date,
    fetchAttachment, fetchFilePreview, downloadFile: vi.fn(), AbortController, Error, DOMException,
    URL: { createObjectURL, revokeObjectURL },
  })) as { load(): Promise<void>; close(): void; convertVideo(): Promise<void>; playbackFailed(): void; compatible: { value: boolean }; converting: { value: boolean }; source: { value: string }; error: { value: string }; player: { value: unknown } };
  return { scope, viewer, pending, createObjectURL, revokeObjectURL, fetchAttachment, fetchFilePreview, videoPreviewStatus, fetchCompatibleVideo, emit };
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

it('已加载的聊天原图直接复用 Blob，查看器独立释放自己的 URL', async () => {
  const original = new Blob(['original image bytes'], { type: 'image/png' });
  const f = setup(true, false, original);
  try {
    await f.viewer.load();
    expect(f.fetchAttachment).not.toHaveBeenCalled();
    expect(f.fetchFilePreview).not.toHaveBeenCalled();
    const viewed = f.createObjectURL.mock.calls[0][0];
    expect(viewed.type).toBe('image/png');
    expect(await viewed.text()).toBe(await original.text());
    f.viewer.close();
    expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview');
    expect(f.viewer.source.value).toBe('');
  } finally { f.scope.stop(); }
});

it('桌面播放使用受认证的媒体地址，不下载整段 Blob，关闭不撤销普通 URL', async () => {
  const f = setup(false, true);
  await f.viewer.load();
  expect(f.viewer.source.value).toBe('/api/groups/group/files/file/media');
  expect(f.fetchFilePreview).not.toHaveBeenCalled();
  expect(f.createObjectURL).not.toHaveBeenCalled();
  f.viewer.close();
  expect(f.revokeObjectURL).not.toHaveBeenCalled();
  f.scope.stop();
});

it('待发送预览复用附件来源，失败不请求服务器，关闭不撤销聊天持有的 URL', async () => {
  for (const source of ['blob:pending', 'lycan://app/recordings/local-id']) {
    const f = setup(false, true, undefined, source);
    try {
      await f.viewer.load();
      expect(f.viewer.source.value).toBe(source);
      f.viewer.playbackFailed();
      expect(f.viewer.error.value).toContain('仍可作为附件发送');
      expect(f.fetchFilePreview).not.toHaveBeenCalled();
      expect(f.videoPreviewStatus).not.toHaveBeenCalled();
      f.viewer.close();
      expect(f.revokeObjectURL).not.toHaveBeenCalled();
    } finally { f.scope.stop(); }
  }
});

it('正常加载和播放失败都不自动启动转码，点击后复用兼容文件', async () => {
  const f = setup(false, true);
  await f.viewer.load();
  expect(f.videoPreviewStatus).not.toHaveBeenCalled();
  f.videoPreviewStatus.mockResolvedValueOnce({ status: 'absent' });
  f.viewer.playbackFailed();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.videoPreviewStatus).toHaveBeenCalledWith('group', 'file', false, expect.any(AbortSignal));
  await f.viewer.convertVideo();
  expect(f.videoPreviewStatus).toHaveBeenCalledWith('group', 'file', true, expect.any(AbortSignal));
  expect(f.viewer.source.value).toBe('/api/groups/group/files/file/preview/media');
  expect(f.viewer.compatible.value).toBe(true);
  expect(f.fetchCompatibleVideo).not.toHaveBeenCalled();
  f.scope.stop();
});

it('播放失败后自动复用已有兼容预览，不重新启动转换', async () => {
  const f = setup(false, true);
  await f.viewer.load();
  f.viewer.playbackFailed();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.videoPreviewStatus).toHaveBeenCalledExactlyOnceWith('group', 'file', false, expect.any(AbortSignal));
  expect(f.viewer.source.value).toBe('/api/groups/group/files/file/preview/media');
  f.scope.stop();
});

it('关闭查看器取消转换等待，迟到结果不替换画面', async () => {
  const f = setup(false, true);
  let resolve!: (value: unknown) => void;
  f.videoPreviewStatus.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const conversion = f.viewer.convertVideo();
  f.viewer.close();
  expect(f.videoPreviewStatus.mock.calls[0][3].aborted).toBe(true);
  resolve({ status: 'ready' }); await conversion;
  expect(f.viewer.source.value).toBe('');
  expect(f.createObjectURL).not.toHaveBeenCalled();
  f.scope.stop();
});

it('转换未完成只轮询状态，失败可重试，不伪造成功', async () => {
  vi.useFakeTimers();
  const f = setup(false, true);
  try {
    f.videoPreviewStatus.mockResolvedValueOnce({ status: 'processing' }).mockResolvedValueOnce({ status: 'failed', message: '无法转换' });
    const conversion = f.viewer.convertVideo();
    await vi.advanceTimersByTimeAsync(1000); await conversion;
    expect(f.videoPreviewStatus.mock.calls.map(call => call[2])).toEqual([true, false]);
    expect(f.viewer.error.value).toBe('无法转换');
    expect(f.viewer.converting.value).toBe(false);
    expect(f.viewer.compatible.value).toBe(false);
    await f.viewer.convertVideo();
    expect(f.viewer.compatible.value).toBe(true);
  } finally { f.scope.stop(); vi.useRealTimers(); }
});

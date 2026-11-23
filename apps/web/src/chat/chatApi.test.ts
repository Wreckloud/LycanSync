import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../auth/authApi';
import { desktopMediaUrl, videoPreviewStatus, fetchCompatibleVideo, downloadFile, fetchVideoThumbnail, findMessages } from './chatApi';

vi.mock('../auth/authApi', () => ({ authenticatedFetch: vi.fn(), readApiError: vi.fn() }));

it('等待新消息沿用增量游标与固定路径，历史读取不进入长轮询', async () => {
  vi.mocked(authenticatedFetch).mockImplementation(async () => Response.json({ messages: [], hasMore: false }));
  await findMessages('group', { afterMessageId: 'cursor' }, undefined, true);
  const url = new URL(vi.mocked(authenticatedFetch).mock.calls[0][0], 'https://example.test');
  expect(url.pathname).toBe('/api/groups/group/messages');
  expect(url.searchParams.get('afterMessageId')).toBe('cursor');
  expect(url.searchParams.get('wait')).toBe('true');
  expect(Number(url.searchParams.get('requestId'))).toBeGreaterThan(0);
  await findMessages('group', { beforeMessageId: 'older' });
  expect(vi.mocked(authenticatedFetch).mock.calls[1][0]).toBe('/api/groups/group/messages?beforeMessageId=older');
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const attachment = { id: 'file', byteSize: 3, contentType: 'application/octet-stream', fileName: 'sample.bin' };

it('桌面下载使用原生保存框并按本次请求取消', async () => {
  const pending = deferred<'cancelled'>();
  const downloadChatFile = vi.fn(() => pending.promise);
  const cancelChatDownload = vi.fn();
  vi.stubGlobal('window', { lycanDesktop: { downloadChatFile, cancelChatDownload } });
  const controller = new AbortController();
  const progress = vi.fn();
  const result = downloadFile('group', attachment, controller.signal, progress);
  expect(downloadChatFile).toHaveBeenCalledWith(expect.any(String), '/api/groups/group/files/file', 'sample.bin', 3, progress);
  controller.abort();
  expect(cancelChatDownload).toHaveBeenCalledExactlyOnceWith(downloadChatFile.mock.calls[0]?.at(0));
  pending.resolve('cancelled');
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(authenticatedFetch).not.toHaveBeenCalled();
});

it('封面只请求封面接口，204 表示无封面，不回退下载原视频', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(null, { status: 204 }));
  expect(await fetchVideoThumbnail('group', 'file', new AbortController().signal)).toBeNull();
  expect(authenticatedFetch).toHaveBeenCalledExactlyOnceWith('/api/groups/group/files/file/thumbnail', expect.any(Object));
});

it('只有桌面使用媒体地址，不向 URL 拼入登录凭据', () => {
  vi.stubGlobal('window', {});
  expect(desktopMediaUrl('group', 'file')).toBeNull();
  vi.stubGlobal('window', { lycanDesktop: {} });
  expect(desktopMediaUrl('group', 'file')).toBe('/api/groups/group/files/file/media');
});

it('下载内容不完整时中止写入，不把截断文件保存为成功', async () => {
  const { writer, controller, progress } = setup();
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1, 2])));
  await expect(downloadFile('group', attachment, controller.signal, progress)).rejects.toThrow('文件未能完整下载');
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup() {
  const writer = { write: vi.fn(async (_bytes: Uint8Array) => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const handle = { createWritable: vi.fn(async () => writer) };
  const picker = vi.fn(async () => handle);
  vi.stubGlobal('window', { showSaveFilePicker: picker });
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  return { writer, handle, picker, controller: new AbortController(), progress: vi.fn() };
}

it('正常下载逐块写入，完成后提交保存', async () => {
  const { writer, picker, controller, progress } = setup();
  await downloadFile('group', attachment, controller.signal, progress);
  expect(picker).toHaveBeenCalledWith({ suggestedName: 'sample.bin' });
  expect(writer.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  expect(progress).toHaveBeenCalledWith(3);
  expect(writer.close).toHaveBeenCalledOnce();
  expect(writer.abort).not.toHaveBeenCalled();
});

it('收到超过声明大小的内容时中止下载，超出的数据不写入磁盘', async () => {
  const { writer, controller, progress } = setup();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array([1, 2]));
      stream.enqueue(new Uint8Array([3, 4]));
      controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason), { once: true });
    },
    cancel,
  });
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(body));
  // 最后留有未结束的流，超限处理不能依赖流读到末尾。
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    await expect(downloadFile('group', attachment, controller.signal, progress)).rejects.toThrow('文件未能完整下载');
  } finally { clearTimeout(timeout); }
  expect(writer.write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2]));
  expect(writer.close).not.toHaveBeenCalled();
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it('保存对话框等待期间取消，迟到选址不创建写入或请求', async () => {
  const { handle, picker, controller, progress } = setup();
  const selection = deferred<typeof handle>();
  picker.mockReturnValueOnce(selection.promise);
  const downloading = downloadFile('group', attachment, controller.signal, progress);
  const rejected = expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  selection.resolve(handle);
  await rejected;
  expect(handle.createWritable).not.toHaveBeenCalled();
  expect(authenticatedFetch).not.toHaveBeenCalled();
});

it('创建写入等待期间取消，返回后中止写入，不请求文件', async () => {
  const { writer, handle, controller, progress } = setup();
  const opened = deferred<typeof writer>();
  const creating = deferred<void>();
  handle.createWritable.mockImplementationOnce(() => { creating.resolve(); return opened.promise; });
  const downloading = downloadFile('group', attachment, controller.signal, progress);
  const rejected = expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
  await creating.promise;
  controller.abort();
  opened.resolve(writer);
  await rejected;
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
  expect(authenticatedFetch).not.toHaveBeenCalled();
});

it('最后一块磁盘写入等待期间取消，不把文件提交保存或报告完成进度', async () => {
  const { writer, controller, progress } = setup();
  const writing = deferred<void>();
  const written = deferred<void>();
  writer.write.mockImplementationOnce(() => { writing.resolve(); return written.promise; });
  const downloading = downloadFile('group', attachment, controller.signal, progress);
  const rejected = expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
  await writing.promise;
  controller.abort();
  written.resolve();
  await rejected;
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});

it('写入错误中止网络读取和写入，保留原错误', async () => {
  const { writer, controller, progress } = setup();
  const diskError = new Error('磁盘空间不足');
  const reader = { read: vi.fn(async () => ({ done: false, value: new Uint8Array([1]) })), cancel: vi.fn(async () => {}), releaseLock: vi.fn() };
  vi.mocked(authenticatedFetch).mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);
  writer.write.mockRejectedValueOnce(diskError);
  await expect(downloadFile('group', attachment, controller.signal, progress)).rejects.toBe(diskError);
  expect(reader.cancel).toHaveBeenCalledWith(diskError);
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});


it('兼容预览查询不启动转换，只有显式启动才用 POST，播放仍附带会话', async () => {
  vi.mocked(authenticatedFetch).mockImplementation(async () => Response.json({ status: 'processing', message: null }));
  const signal = new AbortController().signal;
  await videoPreviewStatus('group', 'file', false, signal);
  expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/groups/group/files/file/preview', expect.objectContaining({ method: 'GET' }));
  await videoPreviewStatus('group', 'file', true, signal);
  expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/groups/group/files/file/preview', expect.objectContaining({ method: 'POST' }));
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Blob(['mp4'], { type: 'video/mp4' })));
  expect((await fetchCompatibleVideo('group', 'file', signal)).type).toBe('video/mp4');
  vi.stubGlobal('window', { lycanDesktop: {} });
  expect(desktopMediaUrl('group', 'file', true)).toBe('/api/groups/group/files/file/preview/media');
});

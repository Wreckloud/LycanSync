import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../auth/authApi';
import { downloadFile } from './chatApi';

vi.mock('../auth/authApi', () => ({ authenticatedFetch: vi.fn(), readApiError: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const attachment = { id: 'file', byteSize: 3, contentType: 'application/octet-stream', fileName: 'sample.bin' };

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
  const reader = { read: vi.fn(async () => ({ done: false, value: new Uint8Array([1]) })), cancel: vi.fn(async () => {}) };
  vi.mocked(authenticatedFetch).mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);
  writer.write.mockRejectedValueOnce(diskError);
  await expect(downloadFile('group', attachment, controller.signal, progress)).rejects.toBe(diskError);
  expect(reader.cancel).toHaveBeenCalledWith(diskError);
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});

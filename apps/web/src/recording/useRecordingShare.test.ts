import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecordingShare } from './useRecordingShare';
import { sendFile } from '../chat/chatApi';

vi.mock('../chat/chatApi', () => ({ sendFile: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
const entry: RecordingLibraryEntry = { id: 'recording', sessionId: 'session', createdAt: 1, durationMs: 1000,
  width: 640, height: 360, bytes: 3, state: 'saved', availability: 'available', fileName: 'Krita · 回放.mkv' };
function setup() {
  const scope = effectScope(); const notify = vi.fn();
  const share = scope.run(() => useRecordingShare(notify, () => 'current-group'))!;
  return { scope, notify, share };
}
it('分享按需流式读取本地文件，关闭弹窗不会取消上传；正在发送时不替换目标', async () => {
  const f = setup();
  let finish!: () => void;
  const wait = new Promise<void>(yes => { finish = yes; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
  vi.mocked(sendFile).mockImplementation(async (group, file, _content, _id, signal, progress) => {
    expect(group).toBe('current-group'); expect(file.name).toBe(entry.fileName);
    const reader = file.stream().getReader();
    expect(Array.from((await reader.read()).value!)).toEqual([1, 2, 3]);
    expect((await reader.read()).done).toBe(true); progress(3);
    await wait; expect(signal.aborted).toBe(false);
    return {} as never;
  });
  f.share.select(entry); const uploading = f.share.send();
  f.share.visible.value = false;
  f.share.select({ ...entry, id: 'other' });
  expect(f.share.entry.value?.id).toBe('recording');
  finish(); await uploading;
  expect(f.notify).toHaveBeenCalledOnce(); expect(f.share.entry.value).toBeNull();
  f.scope.stop();
});
it('失败重试保留幂等上传标识；更改目标或留言才开始新上传', async () => {
  const f = setup(); vi.mocked(sendFile).mockRejectedValue(new Error('网络中断'));
  f.share.select(entry); await f.share.send(); await f.share.send();
  const calls = vi.mocked(sendFile).mock.calls;
  expect(calls[1]![3]).toBe(calls[0]![3]); expect(f.share.error.value).toBe('网络中断');
  f.share.resetUpload(); await f.share.send();
  expect(calls[2]![3]).not.toBe(calls[0]![3]); f.scope.stop();
});
it('取消或退出主界面中断进行中的上传，不报告发送成功', async () => {
  const f = setup();
  vi.mocked(sendFile).mockImplementation((_group, _file, _content, _id, signal) => new Promise((_yes, no) => {
    signal.addEventListener('abort', () => no(new Error('aborted')), { once: true });
  }));
  f.share.select(entry); const first = f.share.send(); f.share.cancel(); await first;
  expect(f.share.error.value).toBe('已取消上传。');
  const second = f.share.send(); f.scope.stop(); await second;
  expect(f.notify).not.toHaveBeenCalled();
});

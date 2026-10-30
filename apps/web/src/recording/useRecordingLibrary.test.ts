import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecordingLibrary } from './useRecordingLibrary';

const entry: RecordingLibraryEntry = { id: 'entry', sessionId: 'session', createdAt: 1, durationMs: 1000,
  width: 1920, height: 1080, bytes: 100, state: 'saved', availability: 'available' };
afterEach(() => { vi.unstubAllGlobals(); });

function fixture() {
  const desktop = { getRecordingLibrary: vi.fn(async (_offset = 0) => ({ items: [entry], hasMore: false })),
    recordingFile: vi.fn(async (_id: string, _action: string) => true) };
  vi.stubGlobal('window', { lycanDesktop: desktop });
  const scope = effectScope();
  const library = scope.run(useRecordingLibrary)!;
  return { desktop, scope, library };
}

it('重叠刷新只采用最新结果，离开设置后不再接收迟到数据', async () => {
  const f = fixture();
  try {
    let resolve!: (value: { items: RecordingLibraryEntry[]; hasMore: boolean }) => void;
    f.desktop.getRecordingLibrary.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const old = f.library.load();
    await f.library.load();
    resolve({ items: [], hasMore: true }); await old;
    expect(f.library.entries.value).toEqual([entry]); expect(f.library.hasMore.value).toBe(false);
    f.desktop.getRecordingLibrary.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const pending = f.library.load(); f.scope.stop();
    resolve({ items: [], hasMore: true }); await pending;
    expect(f.library.entries.value).toEqual([entry]);
  } finally { f.scope.stop(); }
});

it('删除取消保留列表，确认后刷新；活动录像不执行文件操作', async () => {
  const f = fixture();
  try {
    await f.library.load();
    f.desktop.recordingFile.mockResolvedValueOnce(false);
    await f.library.file(entry, 'delete');
    expect(f.desktop.getRecordingLibrary).toHaveBeenCalledTimes(1);
    f.desktop.getRecordingLibrary.mockResolvedValueOnce({ items: [], hasMore: false });
    await f.library.file(entry, 'delete');
    expect(f.library.entries.value).toEqual([]);
    expect(f.desktop.recordingFile).toHaveBeenLastCalledWith(entry.id, 'delete');
    await f.library.file({ ...entry, state: 'recording' }, 'play');
    expect(f.desktop.recordingFile).toHaveBeenCalledTimes(2);
  } finally { f.scope.stop(); }
});

it('播放器失败留在当前页并显示操作附近的反馈，不输出异常正文', async () => {
  const f = fixture();
  try {
    await f.library.load();
    f.desktop.recordingFile.mockRejectedValueOnce(new Error('private-path'));
    await f.library.file(entry, 'play');
    expect(f.library.entries.value).toEqual([entry]);
    expect(f.library.notice.value).toContain('MKV');
    expect(f.library.notice.value).not.toContain('private-path');
    expect(f.library.pendingId.value).toBe('');
  } finally { f.scope.stop(); }
});

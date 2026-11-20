import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecordingLibrary } from './useRecordingLibrary';

const entry: RecordingLibraryEntry = { id: 'entry', sessionId: 'session', createdAt: 1, durationMs: 1000,
  width: 1920, height: 1080, bytes: 100, state: 'saved', availability: 'available' };
afterEach(() => { vi.unstubAllGlobals(); });

function fixture() {
  const desktop = { getRecordingLibrary: vi.fn(async (_offset = 0) => ({ items: [entry], hasMore: false })),
    updateRecordingDuration: vi.fn(async (_id: string, _duration: number) => {}),
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

it('后台刷新保留已展开页，新增录像后一次更新完整范围；切换类型只取首页', async () => {
  const f = fixture();
  let stored = Array.from({ length: 130 }, (_, index) => ({ ...entry, id: String(index) }));
  f.desktop.getRecordingLibrary.mockImplementation(async (offset = 0) => ({ items: stored.slice(offset, offset + 50), hasMore: offset + 50 < stored.length }));
  try {
    await f.library.load(); await f.library.load(true);
    stored = [{ ...entry, id: 'new' }, ...stored];
    await f.library.load();
    expect(f.library.entries.value).toHaveLength(100);
    expect(f.library.entries.value[0]!.id).toBe('new');
    expect(f.library.entries.value[99]!.id).toBe('98');
    f.library.kind.value = 'replay'; await f.library.load();
    expect(f.library.entries.value).toHaveLength(50);
    expect(f.desktop.getRecordingLibrary).toHaveBeenLastCalledWith(0, 'replay');
  } finally { f.scope.stop(); }
});

it('后续页刷新失败保留原列表；删除后不足一页时正常收尾', async () => {
  const f = fixture();
  const first = Array.from({ length: 50 }, (_, index) => ({ ...entry, id: String(index) }));
  try {
    f.desktop.getRecordingLibrary.mockResolvedValueOnce({ items: first, hasMore: true });
    await f.library.load(); await f.library.load(true);
    const previous = f.library.entries.value;
    f.desktop.getRecordingLibrary.mockResolvedValueOnce({ items: first, hasMore: true }).mockRejectedValueOnce(new Error('unavailable'));
    await f.library.load();
    expect(f.library.entries.value).toBe(previous);
    expect(f.library.notice.value).not.toBe('');
    await f.library.load();
    expect(f.library.entries.value).toEqual([entry]);
    expect(f.library.hasMore.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('旧录像读取到实际时长后补齐并持久化，保存失败明确反馈', async () => {
  const f = fixture();
  try {
    const unknown = { ...entry, durationMs: null };
    f.library.entries.value = [unknown];
    await f.library.updateDuration(unknown, 2317);
    expect(f.library.entries.value[0]!.durationMs).toBe(2317);
    expect(f.desktop.updateRecordingDuration).toHaveBeenCalledWith(entry.id, 2317);
    await f.library.updateDuration(unknown, 2400);
    expect(f.desktop.updateRecordingDuration).toHaveBeenCalledTimes(1);
    expect(f.library.entries.value[0]!.durationMs).toBe(2317);
    f.library.entries.value = [unknown];
    f.desktop.updateRecordingDuration.mockRejectedValueOnce(new Error('unavailable'));
    await f.library.updateDuration(unknown, 2400);
    expect(f.library.notice.value).toContain('未能保存');
  } finally { f.scope.stop(); }
});

it('刷新后的列表不接收旧时长写入错误，已移除或销毁的条目不回填', async () => {
  const f = fixture();
  try {
    const unknown = { ...entry, durationMs: null };
    f.library.entries.value = [unknown];
    let reject!: (error: Error) => void;
    f.desktop.updateRecordingDuration.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    const updating = f.library.updateDuration(unknown, 2317);
    await f.library.load();
    reject(new Error('unavailable'));
    await updating;
    expect(f.library.notice.value).toBe('');
    expect(f.library.entries.value).toEqual([entry]);
    f.library.entries.value = [];
    await f.library.updateDuration(unknown, 2317);
    f.library.entries.value = [unknown];
    f.scope.stop();
    await f.library.updateDuration(unknown, 2317);
    expect(f.desktop.updateRecordingDuration).toHaveBeenCalledTimes(1);
  } finally { f.scope.stop(); }
});

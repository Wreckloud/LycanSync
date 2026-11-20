import { expect, it, vi } from 'vitest';
import { useRecordingShare } from './useRecordingShare';

const entry: RecordingLibraryEntry = { id: 'recording', sessionId: 'session', createdAt: 1, durationMs: 1000,
  width: 640, height: 360, bytes: 3, state: 'saved', availability: 'available', fileName: '饥荒联机版 · 回放.mkv' };

it('分享选择只交接原片信息并导航到群聊，不直接上传', () => {
  const navigate = vi.fn();
  const share = useRecordingShare(navigate);
  share.select(entry);
  expect(share.visible.value).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  share.choose('target');
  expect(share.pending.value).toEqual({ groupId: 'target', entry });
  expect(share.visible.value).toBe(false);
  expect(share.entry.value).toBeNull();
  expect(navigate).toHaveBeenCalledExactlyOnceWith('target');
});

it('关闭选择浮层不添加附件；缺失或录制中的原片不交接', () => {
  const navigate = vi.fn();
  const share = useRecordingShare(navigate);
  share.select(entry);
  share.visible.value = false;
  expect(share.pending.value).toBeNull();
  share.choose('');
  share.select({ ...entry, availability: 'missing' });
  share.choose('target');
  share.select({ ...entry, state: 'recording' });
  share.choose('target');
  expect(navigate).not.toHaveBeenCalled();
});

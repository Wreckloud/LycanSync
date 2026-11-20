import { ref, shallowRef, type InjectionKey } from 'vue';

export const RECORDING_SHARE: InjectionKey<ReturnType<typeof useRecordingShare>> = Symbol('recording-share');

// 分享只交接到目标群的待发送附件；上传由聊天发送入口统一负责。
export function useRecordingShare(openGroup: (groupId: string) => void) {
  const entry = shallowRef<RecordingLibraryEntry | null>(null);
  const visible = ref(false);
  const pending = shallowRef<{ groupId: string; entry: RecordingLibraryEntry } | null>(null);
  function select(value: RecordingLibraryEntry) {
    entry.value = value;
    visible.value = true;
  }
  function choose(groupId: string) {
    const value = entry.value;
    if (!groupId || !value || value.availability !== 'available' || value.state === 'recording' || !value.bytes) return;
    pending.value = { groupId, entry: value };
    visible.value = false;
    entry.value = null;
    openGroup(groupId);
  }
  return { entry, visible, pending, select, choose };
}

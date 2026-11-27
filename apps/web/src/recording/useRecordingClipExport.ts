import { onScopeDispose, ref } from 'vue';

type LibraryPosition = { kind: 'all' | NonNullable<RecordingLibraryEntry['kind']>; loadedCount: number; scrollTop: number };

export function useRecordingClipExport(notify: (message: string, kind?: 'success') => void) {
  const desktop = window.lycanDesktop;
  const task = ref<{ sourceId: string; requestId: string; percent: number; cancelling: boolean; position: LibraryPosition } | null>(null);
  const lastSavedId = ref('');
  const unsubscribe = desktop?.onRecordingClipProgress?.(({ requestId, percent }) => {
    if (task.value?.requestId === requestId) task.value.percent = percent;
  });

  function start(sourceId: string, startMs: number, endMs: number, position: LibraryPosition) {
    if (!desktop || task.value) return false;
    const requestId = crypto.randomUUID();
    task.value = { sourceId, requestId, percent: 0, cancelling: false, position };
    void desktop.exportRecordingClip(requestId, sourceId, startMs, endMs).then(clip => {
      if (task.value?.requestId !== requestId) return;
      lastSavedId.value = clip.id;
      notify('剪辑片段已保存', 'success');
    }, reason => {
      if (task.value?.requestId !== requestId) return;
      const message = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '';
      if (message !== '已取消保存片段。') notify(message || '片段导出失败，请重试。');
    }).finally(() => { if (task.value?.requestId === requestId) task.value = null; });
    return true;
  }

  async function cancel() {
    const current = task.value;
    if (!desktop || !current || current.cancelling) return;
    current.cancelling = true;
    try { await desktop.cancelRecordingClip(current.requestId); }
    catch {
      if (task.value === current) {
        current.cancelling = false;
        notify('未能取消导出，请重试。');
      }
    }
  }
  onScopeDispose(() => {
    unsubscribe?.();
    void cancel();
    task.value = null;
  });
  return { task, lastSavedId, start, cancel };
}

import { onScopeDispose, ref, shallowRef } from 'vue';

export function useRecordingLibrary() {
  const desktop = window.lycanDesktop;
  const entries = shallowRef<RecordingLibraryEntry[]>([]);
  const hasMore = ref(false);
  const loading = ref(false);
  const pendingId = ref('');
  const notice = ref('');
  let disposed = false;
  let revision = 0;

  async function load(append = false) {
    if (!desktop || append && loading.value) return;
    const version = ++revision;
    loading.value = true;
    notice.value = '';
    try {
      const result = await desktop.getRecordingLibrary(append ? entries.value.length : 0);
      if (disposed || version !== revision) return;
      entries.value = append ? [...entries.value, ...result.items.filter(item => !entries.value.some(entry => entry.id === item.id))] : result.items;
      hasMore.value = result.hasMore;
    } catch {
      if (!disposed && version === revision) notice.value = '无法读取录像列表，请检查安装目录的读写权限后重试。';
    } finally { if (!disposed && version === revision) loading.value = false; }
  }
  async function file(entry: RecordingLibraryEntry, action: 'play' | 'reveal' | 'delete') {
    if (!desktop || pendingId.value || entry.state === 'recording') return;
    pendingId.value = entry.id; notice.value = '';
    try {
      const changed = await desktop.recordingFile(entry.id, action);
      if (!disposed && action === 'delete' && changed) await load();
    } catch {
      if (!disposed) notice.value = action === 'play' ? '无法打开录像，请确认原片仍存在，并安装支持 MKV 的播放器。'
        : action === 'delete' ? '录像未能删除，请关闭正在使用该文件的程序后重试。' : '无法定位录像，请确认原片仍在原位置。';
    } finally { if (!disposed) pendingId.value = ''; }
  }
  onScopeDispose(() => { disposed = true; revision++; });
  return { entries, hasMore, loading, pendingId, notice, load, file };
}

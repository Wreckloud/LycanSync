import { onScopeDispose, ref, shallowRef } from 'vue';
import { forgetRecordingThumbnail } from './recordingThumbnails';

export function useRecordingLibrary() {
  const desktop = window.lycanDesktop;
  const entries = shallowRef<RecordingLibraryEntry[]>([]);
  const hasMore = ref(false);
  const loading = ref(false);
  const pendingId = ref('');
  const notice = ref('');
  const kind = ref<'all' | 'recording' | 'replay' | 'clip'>('all');
  let disposed = false;
  let revision = 0;
  let loadedKind = kind.value;

  async function load(append = false) {
    if (!desktop || append && loading.value) return;
    const version = ++revision;
    const requestedKind = kind.value;
    const targetCount = requestedKind === loadedKind ? entries.value.length : 0;
    loading.value = true;
    notice.value = '';
    try {
      const refreshed: RecordingLibraryEntry[] = [];
      let more = false;
      do {
        const result = await desktop.getRecordingLibrary(append ? entries.value.length : refreshed.length, requestedKind);
        if (disposed || version !== revision) return;
        refreshed.push(...result.items);
        more = result.hasMore;
        if (!result.items.length) break;
      } while (!append && more && refreshed.length < targetCount);
      // 后台刷新完整读取已展开的范围，再一次替换，避免中间页闪空或回到第一页。
      for (const entry of refreshed) if (entry.availability !== 'available') forgetRecordingThumbnail(entry.id);
      entries.value = append ? [...entries.value, ...refreshed.filter(item => !entries.value.some(entry => entry.id === item.id))] : refreshed;
      loadedKind = requestedKind;
      hasMore.value = more;
    } catch {
      if (!disposed && version === revision) notice.value = '无法读取录像列表，请检查安装目录的读写权限后重试。';
    } finally { if (!disposed && version === revision) loading.value = false; }
  }
  async function file(entry: RecordingLibraryEntry, action: 'play' | 'reveal' | 'delete' | 'relink' | 'clearUnavailable') {
    if (!desktop || pendingId.value || entry.state === 'recording') return;
    pendingId.value = entry.id; notice.value = '';
    try {
      const changed = await desktop.recordingFile(entry.id, action);
      if (!disposed && ['delete', 'relink', 'clearUnavailable'].includes(action) && changed) {
        forgetRecordingThumbnail(entry.id);
        await load();
      }
    } catch {
      if (!disposed) notice.value = action === 'play' ? '无法打开录像，请确认原片仍存在，并安装支持 MKV 的播放器。'
        : action === 'delete' ? '录像未能删除，请关闭正在使用该文件的程序后重试。'
          : action === 'relink' ? '无法重新关联，请确认原位置的录像文件仍然可用。'
            : action === 'clearUnavailable' ? '记录未能清理，请稍后重试。' : '无法定位录像，请确认原片仍在原位置。';
    } finally { if (!disposed) pendingId.value = ''; }
  }
  onScopeDispose(() => { disposed = true; revision++; });
  return { kind, entries, hasMore, loading, pendingId, notice, load, file };
}

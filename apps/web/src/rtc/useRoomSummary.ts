import { onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import { requestRoomSummary, type RtcRoomSummary } from './roomSummaryApi';

const REFRESH_INTERVAL_MS = 10_000;

/** 未入房时查询摘要；切换群组、入房或销毁作用域时取消旧请求。 */
export function useRoomSummary(groupId: Ref<string>, enabled: Ref<boolean>) {
  const summary = shallowRef<RtcRoomSummary | null>(null);
  const pageVisible = shallowRef(typeof document === 'undefined' || document.visibilityState !== 'hidden');

  const updatePageVisibility = () => {
    pageVisible.value = document.visibilityState !== 'hidden';
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', updatePageVisibility);
    onScopeDispose(() => document.removeEventListener('visibilitychange', updatePageVisibility));
  }

  watch([groupId, enabled, pageVisible], ([currentGroupId, shouldRefresh, isVisible], _, onCleanup) => {
    summary.value = null;
    if (!shouldRefresh || !isVisible) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      request.abort();
      clearTimeout(timer);
    });
    const refresh = async () => {
      try {
        const result = await requestRoomSummary(currentGroupId, request.signal);
        if (!request.signal.aborted) summary.value = result;
      } catch {
        if (!request.signal.aborted) summary.value = null;
      } finally {
        if (!request.signal.aborted) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
  }, { immediate: true });

  return summary;
}

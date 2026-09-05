import { shallowRef, watch, type Ref } from 'vue';
import { requestRoomSummary, type RtcRoomSummary } from './roomSummaryApi';

// TODO: 页面隐藏时暂停轮询、恢复时刷新；正式事件通道接入后保留重连快照校准。
const REFRESH_INTERVAL_MS = 3_000;

/** 未入房时查询摘要；切换群组、入房或销毁作用域时取消旧请求。 */
export function useRoomSummary(groupId: Ref<string>, enabled: Ref<boolean>) {
  const summary = shallowRef<RtcRoomSummary | null>(null);

  watch([groupId, enabled], ([currentGroupId, shouldRefresh], _, onCleanup) => {
    summary.value = null;
    if (!shouldRefresh) return;
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

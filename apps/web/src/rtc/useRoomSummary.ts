import { onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import { requestRoomSummary, type RtcRoomSummary } from './roomSummaryApi';
import { ApiRequestError } from '../auth/authApi';

const REFRESH_INTERVAL_MS = 5_000;
const PREVIEW_MAX_AGE_MS = 30_000;

/** 未入房时查询摘要；切换群组、入房或销毁作用域时取消旧请求。 */
export function useRoomSummary(groupId: Ref<string | null>, enabled: Ref<boolean>, onError?: (message: string | null) => void,
  refreshVersion?: Ref<number>, onReceived?: (groupId: string, result: RtcRoomSummary) => void) {
  const summary = shallowRef<RtcRoomSummary | null>(null);
  const recent = new Map<string, { result: RtcRoomSummary; expires: number }>();
  let currentRequest: AbortController | undefined;
  function remember(id: string, result: RtcRoomSummary) {
    const now = Date.now();
    for (const [key, entry] of recent) if (entry.expires <= now) recent.delete(key);
    recent.set(id, { result, expires: now + PREVIEW_MAX_AGE_MS });
  }
  function cached(id: string) {
    const entry = recent.get(id);
    return entry && entry.expires > Date.now() ? entry.result : null;
  }
  function forget(id: string) {
    recent.delete(id);
    if (groupId.value === id) {
      currentRequest?.abort();
      summary.value = null;
    }
  }
  const pageVisible = shallowRef(typeof document === 'undefined' || document.visibilityState !== 'hidden');

  const updatePageVisibility = () => {
    pageVisible.value = document.visibilityState !== 'hidden';
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', updatePageVisibility);
    onScopeDispose(() => document.removeEventListener('visibilitychange', updatePageVisibility));
  }

  watch([groupId, enabled, pageVisible, () => refreshVersion?.value], ([currentGroupId, shouldRefresh, isVisible], _, onCleanup) => {
    summary.value = currentGroupId && shouldRefresh ? cached(currentGroupId) : null;
    onError?.(null);
    if (!currentGroupId || !shouldRefresh || !isVisible) return;
    const request = new AbortController();
    currentRequest = request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      request.abort();
      clearTimeout(timer);
    });
    const refresh = async () => {
      try {
        const result = await requestRoomSummary(currentGroupId, request.signal);
        if (!request.signal.aborted) {
          summary.value = result;
          remember(currentGroupId, result);
          onReceived?.(currentGroupId, result);
          onError?.(null);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) recent.delete(currentGroupId);
          summary.value = cached(currentGroupId);
          onError?.('暂时无法查询当前语音成员');
        }
      } finally {
        if (!request.signal.aborted) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
  }, { immediate: true });

  return { summary, remember, forget };
}

import { onScopeDispose, ref, watch } from 'vue';
import { authenticatedFetch, readApiError } from '../auth/authApi';

export function useOwnVoiceTime(active: () => boolean) {
  const seconds = ref<number | null>(null);
  const error = ref('');
  let request: AbortController | undefined;
  watch(active, async visible => {
    request?.abort();
    seconds.value = null;
    error.value = '';
    if (!visible) return;
    const current = new AbortController();
    request = current;
    try {
      const response = await authenticatedFetch('/api/rtc/voice-time', {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw await readApiError(response);
      const result = await response.json();
      if (!Number.isSafeInteger(result.seconds) || result.seconds < 0) throw new Error('语音时长响应无效');
      if (!current.signal.aborted) seconds.value = result.seconds;
    } catch (reason) {
      if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取语音时长';
    }
  }, { immediate: true });
  onScopeDispose(() => request?.abort());
  return { seconds, error };
}

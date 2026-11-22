import { inject, provide, ref, watch, type InjectionKey } from 'vue';
import { authenticatedFetch, readApiError } from '../auth/authApi';

const OWN_VOICE_TIME: InjectionKey<ReturnType<typeof createOwnVoiceTime>> = Symbol('own-voice-time');

function createOwnVoiceTime() {
  const seconds = ref<number | null>(null);
  const error = ref('');
  const viewers = ref(0);
  let fetchedAt = 0;
  watch(() => viewers.value > 0, async (visible, _, onCleanup) => {
    error.value = '';
    if (!visible || (seconds.value !== null && Date.now() - fetchedAt < 60_000)) return;
    const current = new AbortController();
    onCleanup(() => current.abort());
    try {
      const response = await authenticatedFetch('/api/rtc/voice-time', {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw await readApiError(response);
      const result = await response.json();
      if (!Number.isSafeInteger(result.seconds) || result.seconds < 0) throw new Error('语音时长响应无效');
      if (!current.signal.aborted) {
        seconds.value = result.seconds;
        fetchedAt = Date.now();
      }
    } catch (reason) {
      if (!current.signal.aborted && seconds.value === null) error.value = reason instanceof Error ? reason.message : '无法读取语音时长';
    }
  });
  return { seconds, error, viewers };
}

export function provideOwnVoiceTime() {
  provide(OWN_VOICE_TIME, createOwnVoiceTime());
}

export function useOwnVoiceTime(active: () => boolean) {
  const state = inject(OWN_VOICE_TIME, createOwnVoiceTime, true);
  watch(active, (visible, _, onCleanup) => {
    if (!visible) return;
    state.viewers.value++;
    onCleanup(() => { state.viewers.value--; });
  }, { immediate: true });
  return { seconds: state.seconds, error: state.error };
}

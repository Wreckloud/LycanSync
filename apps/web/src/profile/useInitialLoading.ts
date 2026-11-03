import { onScopeDispose, ref, watch } from 'vue';

/** 首批请求照常执行，准备画面只补足一次短过渡；后续刷新不重新遮盖。 */
export function useInitialLoading(ready: () => boolean,
  report: (stage: 'loginDataReady' | 'loginReady', durationMs: number) => void) {
  const loading = ref(true);
  const startedAt = performance.now();
  const preference = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dataReady = false;

  function finish() {
    if (!loading.value || !dataReady) return;
    clearTimeout(timer);
    loading.value = false;
    report('loginReady', Math.round(performance.now() - startedAt));
  }
  watch(ready, value => {
    if (!value || dataReady) return;
    dataReady = true;
    const elapsed = performance.now() - startedAt;
    report('loginDataReady', Math.round(elapsed));
    const remaining = preference?.matches ? 0 : Math.max(0, 1_000 - elapsed);
    if (remaining === 0) finish();
    else timer = setTimeout(finish, remaining);
  }, { flush: 'post', immediate: true });
  const reduceMotion = () => { if (preference?.matches) finish(); };
  preference?.addEventListener('change', reduceMotion);
  onScopeDispose(() => {
    clearTimeout(timer);
    preference?.removeEventListener('change', reduceMotion);
  });
  return loading;
}

import { ref, watch } from 'vue';

/** 只延后等待文案，请求和已有内容照常更新。 */
export function useLoadingHint(pending: () => boolean | string, delay = 1000, operation?: () => string | undefined) {
  const visible = ref(false);
  watch(() => Boolean(pending()) && (operation?.() || true), (waiting, _previous, onCleanup) => {
    visible.value = false;
    if (!waiting) return;
    const timer = setTimeout(() => { visible.value = true; }, delay);
    onCleanup(() => clearTimeout(timer));
  }, { immediate: true, flush: 'sync' });
  return visible;
}

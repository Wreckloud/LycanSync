import { ref, watch } from 'vue';

/** 只延后等待文案，请求和已有内容照常更新。 */
export function useLoadingHint(pending: () => boolean | string, delay = 400) {
  const visible = ref(false);
  watch(pending, (waiting, _previous, onCleanup) => {
    visible.value = false;
    if (!waiting) return;
    const timer = setTimeout(() => { visible.value = true; }, delay);
    onCleanup(() => clearTimeout(timer));
  }, { immediate: true, flush: 'sync' });
  return visible;
}

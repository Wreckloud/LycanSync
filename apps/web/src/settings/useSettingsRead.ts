import { onScopeDispose, ref, shallowRef } from 'vue';
import { ApiRequestError } from '../auth/authApi';

/** 在当前设置会话内复用已确认的读数与在途请求，撤权和销毁时丢弃。 */
export function useSettingsRead<T>(read: (signal: AbortSignal) => Promise<T>, fallback: string,
  onDenied: (message: string) => void) {
  const value = shallowRef<T | null>(null);
  const error = ref('');
  const loading = ref(false);
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;

  function clear() {
    controller?.abort();
    controller = undefined;
    task = undefined;
    value.value = null;
    error.value = '';
    loading.value = false;
  }

  function refresh() {
    if (task) return task;
    const current = controller = new AbortController();
    loading.value = true;
    task = read(current.signal).then(result => {
      if (current.signal.aborted) return;
      value.value = result;
      error.value = '';
    }).catch((reason: unknown) => {
      if (current.signal.aborted) return;
      const message = reason instanceof Error ? reason.message : fallback;
      if (reason instanceof ApiRequestError && (reason.status === 401 || reason.status === 403)) {
        clear();
        error.value = message;
        onDenied(message);
      } else {
        error.value = value.value === null ? message : `${message}（当前显示上次结果）`;
      }
    }).finally(() => {
      if (controller === current) { task = undefined; loading.value = false; }
    });
    return task;
  }

  onScopeDispose(clear);
  return { value, loading, error, refresh, clear };
}

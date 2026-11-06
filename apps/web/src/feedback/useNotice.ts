import { computed, shallowRef } from 'vue';

// 保留可读取的错误状态，同时让同文案的新操作产生一次独立通知。
export function useNotice() {
  const noticeEvent = shallowRef<{ message: string } | null>(null);
  const notice = computed({
    get: () => noticeEvent.value?.message ?? '',
    set: (message: string) => { noticeEvent.value = message ? { message } : null; },
  });
  return { notice, noticeEvent };
}

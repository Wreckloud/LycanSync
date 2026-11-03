import { effectScope, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLoadingHint } from './useLoadingHint';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('短请求结束后不闪加载文字，持续等待才显示，完成后立即收起', async () => {
  const scope = effectScope();
  const pending = ref(true);
  const hint = scope.run(() => useLoadingHint(() => pending.value))!;
  try {
    await vi.advanceTimersByTimeAsync(200);
    expect(hint.value).toBe(false);
    pending.value = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hint.value).toBe(false);
    pending.value = true;
    await vi.advanceTimersByTimeAsync(399);
    expect(hint.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hint.value).toBe(true);
    pending.value = false;
    expect(hint.value).toBe(false);
  } finally { scope.stop(); }
});

it('缓存出现即取消提示，切换等待重新计时，销毁释放计时器', async () => {
  const scope = effectScope();
  const loading = ref(true);
  const hasContent = ref(false);
  const hint = scope.run(() => useLoadingHint(() => loading.value && !hasContent.value))!;
  try {
    await vi.advanceTimersByTimeAsync(300);
    hasContent.value = true;
    expect(vi.getTimerCount()).toBe(0);
    hasContent.value = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(hint.value).toBe(false);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(hint.value).toBe(false);
  } finally { scope.stop(); }
});

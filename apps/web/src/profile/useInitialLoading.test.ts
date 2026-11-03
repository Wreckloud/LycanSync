import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInitialLoading } from './useInitialLoading';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(reduce = false) {
  const ready = ref(false);
  const report = vi.fn();
  const preference = { matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', { matchMedia: () => preference });
  const scope = effectScope();
  const loading = scope.run(() => useInitialLoading(() => ready.value, report))!;
  return { ready, report, preference, scope, loading };
}

it('快速加载只补足到一秒，请求就绪计时与界面就绪计时分别记录', async () => {
  const f = setup();
  try {
    await vi.advanceTimersByTimeAsync(200);
    f.ready.value = true; await nextTick();
    expect(f.report).toHaveBeenCalledWith('loginDataReady', 200);
    await vi.advanceTimersByTimeAsync(799);
    expect(f.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.loading.value).toBe(false);
    expect(f.report).toHaveBeenLastCalledWith('loginReady', 1_000);
    f.ready.value = false; await nextTick();
    expect(f.loading.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('慢请求就绪后立即进入，不再叠加一秒', async () => {
  const f = setup();
  try {
    await vi.advanceTimersByTimeAsync(2_500);
    expect(f.loading.value).toBe(true);
    f.ready.value = true; await nextTick();
    expect(f.loading.value).toBe(false);
    expect(f.report).toHaveBeenLastCalledWith('loginReady', 2_500);
  } finally { f.scope.stop(); }
});

it('减少动态效果时不补时长，退出销毁后不通知旧界面', async () => {
  const reduced = setup(true);
  reduced.ready.value = true; await nextTick();
  expect(reduced.loading.value).toBe(false);
  reduced.scope.stop();
  const closed = setup();
  closed.ready.value = true; await nextTick();
  closed.scope.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(closed.report).toHaveBeenCalledTimes(1);
  expect(closed.preference.removeEventListener).toHaveBeenCalledOnce();
});

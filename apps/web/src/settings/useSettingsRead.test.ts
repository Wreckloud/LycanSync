import { effectScope } from 'vue';
import { expect, it, vi } from 'vitest';
import { useSettingsRead } from './useSettingsRead';

it('设置会话合并并发读取，使清除或离开前发出的请求无法覆盖新结果', async () => {
  const scope = effectScope();
  const pending: Array<{ signal: AbortSignal; finish: (value: string) => void }> = [];
  const read = scope.run(() => useSettingsRead(signal => new Promise<string>(finish => {
    pending.push({ signal, finish });
  }), '读取失败', vi.fn()))!;

  const first = read.refresh();
  expect(read.refresh()).toBe(first);
  read.clear();
  expect(pending[0].signal.aborted).toBe(true);
  const next = read.refresh();
  pending[1].finish('新结果');
  await next;
  pending[0].finish('旧结果');
  await first;
  expect(read.value.value).toBe('新结果');

  const last = read.refresh();
  scope.stop();
  expect(pending[2].signal.aborted).toBe(true);
  pending[2].finish('已离开的账号');
  await last;
  expect(read.value.value).toBeNull();
});

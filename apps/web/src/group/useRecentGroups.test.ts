import { effectScope, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AccountCache } from '../cache/localCache';
import type { GroupSummary } from './groupApi';
import { useRecentGroups } from './useRecentGroups';

it('按自己的发言和语音互动时间排序，无历史保留原顺序，迟到缓存不覆盖新互动', async () => {
  const groups = ref(['first', 'second', 'third'].map(id => ({ id }) as GroupSummary));
  let resolve!: (value: unknown) => void;
  const read = vi.fn((kind: string, id: string) => {
    if (kind === 'groupActivity' && id === 'first') return new Promise(done => { resolve = done; });
    return Promise.resolve(kind === 'messages' && id === 'second' ? { messages: [
      { senderUserId: 'self', createdAt: '2026-11-19T01:00:00Z' },
      { senderUserId: 'other', createdAt: '2026-11-19T09:00:00Z' },
    ] } : null);
  });
  const cache = { read, write: vi.fn().mockResolvedValue(undefined) } as unknown as AccountCache;
  const scope = effectScope();
  const recent = scope.run(() => useRecentGroups(groups, cache, 'self'))!;
  try {
    await vi.waitFor(() => expect(recent.sorted.value.map(group => group.id)).toEqual(['second', 'first', 'third']));
    recent.mark('first');
    resolve(1);
    await nextTick();
    expect(recent.sorted.value.map(group => group.id)).toEqual(['first', 'second', 'third']);
    expect(cache.write).toHaveBeenCalledWith('groupActivity', 'first', expect.any(Number));
    const calls = read.mock.calls.length;
    groups.value = [...groups.value];
    await nextTick();
    expect(read).toHaveBeenCalledTimes(calls);
    groups.value = groups.value.slice(1);
    await nextTick();
    recent.mark('first');
    expect(cache.write).toHaveBeenCalledTimes(1);
  } finally { scope.stop(); }
});

it('重新进入账号可恢复互动顺序，离开后不再写入缓存', async () => {
  const groups = ref(['first', 'second'].map(id => ({ id }) as GroupSummary));
  const cache = { read: vi.fn(async (kind, id) => kind === 'groupActivity' && id === 'second' ? 500 : null),
    write: vi.fn() } as unknown as AccountCache;
  const scope = effectScope();
  const recent = scope.run(() => useRecentGroups(groups, cache, 'self'))!;
  await vi.waitFor(() => expect(recent.sorted.value[0].id).toBe('second'));
  scope.stop();
  recent.mark('first');
  expect(cache.write).not.toHaveBeenCalled();
});

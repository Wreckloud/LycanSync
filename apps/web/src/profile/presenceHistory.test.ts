import { expect, it } from 'vitest';
import { formatPresenceAgo, formatRecentGame } from './presenceHistory';

const now = Date.parse('2026-11-01T08:00:00Z');

it.each([[0, '刚刚'], [59, '刚刚'], [60, '1分钟前'], [1200, '20分钟前'], [1800, '半小时前'],
  [3599, '半小时前'], [3600, '1小时前'], [86400, '1天前']])('相对时间 %s 秒使用 %s', (seconds, expected) => {
  expect(formatPresenceAgo(new Date(now - Number(seconds) * 1000).toISOString(), now)).toBe(expected);
});

it('未知和未来时间不生成记录，缺少有效游戏时长也不补默认值', () => {
  expect(formatPresenceAgo(null, now)).toBe('');
  expect(formatPresenceAgo('invalid', now)).toBe('');
  expect(formatPresenceAgo(new Date(now + 1000).toISOString(), now)).toBe('');
  expect(formatRecentGame({ name: '游戏', endedAt: new Date(now).toISOString(), playedSeconds: 0 }, now)).toBe('');
  expect(formatRecentGame({ name: '', endedAt: new Date(now).toISOString(), playedSeconds: 30 }, now)).toBe('');
});

it('最近游戏使用模糊结束时间与公开时长，长记录退回日期', () => {
  expect(formatRecentGame({ name: '最终幻想14', endedAt: new Date(now - 1800_000).toISOString(), playedSeconds: 3600 }, now))
    .toBe('半小时前 · 玩了约1小时《最终幻想14》');
  expect(formatRecentGame({ name: '游戏', endedAt: new Date(now).toISOString(), playedSeconds: 20 }, now))
    .toBe('刚刚 · 玩了不到1分钟《游戏》');
  expect(formatPresenceAgo('2025-10-01T08:00:00Z', now)).toContain('2025');
});

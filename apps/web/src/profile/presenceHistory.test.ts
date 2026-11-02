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

it('最近游戏使用口语时间与公开时长，游戏名前用的连接，上次在线格式不变', () => {
  expect(formatRecentGame({ name: '最终幻想14', endedAt: new Date(now - 1800_000).toISOString(), playedSeconds: 3600 }, now))
    .toBe('不久前玩了一个多小时的 最终幻想14');
  expect(formatRecentGame({ name: '游戏', endedAt: new Date(now).toISOString(), playedSeconds: 20 }, now))
    .toBe('刚刚玩了一小会儿的 游戏');
  expect(formatPresenceAgo('2025-10-01T08:00:00Z', now)).toContain('2025');
});

it.each([[1, '一小会儿'], [59, '一小会儿'], [60, '几分钟'], [599, '几分钟'], [600, '十来分钟'], [1199, '十来分钟'],
  [1200, '半个小时左右'], [2399, '半个小时左右'], [2400, '大半个小时'], [3599, '大半个小时'],
  [3600, '一个多小时'], [7199, '一个多小时'], [7200, '两三个小时'], [10799, '两三个小时'],
  [10800, '好几个小时'], [17999, '好几个小时'], [18000, '很久']])('公开时长%s秒显示%s，不先四舍五入', (seconds, duration) => {
  expect(formatRecentGame({ name: 'PEAK', endedAt: new Date(now).toISOString(), playedSeconds: Number(seconds) }, now))
    .toBe(`刚刚玩了${duration}的 PEAK`);
});

it.each([[0, '刚刚'], [299, '刚刚'], [300, '不久前'], [3599, '不久前'], [3600, '几小时前'], [10799, '几小时前'],
  [10800, '今天上午']])('结束后%s秒使用%s', (seconds, ago) => {
  const current = new Date(2026, 10, 2, 12).getTime();
  expect(formatRecentGame({ name: 'PEAK', endedAt: new Date(current - Number(seconds) * 1000).toISOString(), playedSeconds: 600 }, current))
    .toBe(`${ago}玩了十来分钟的 PEAK`);
});

it.each([[0, '凌晨'], [5, '凌晨'], [6, '上午'], [10, '上午'], [11, '中午'], [12, '中午'], [13, '下午'],
  [16, '下午'], [17, '傍晚'], [18, '傍晚'], [19, '晚上'], [22, '晚上'], [23, '深夜']])('本地%s点结束按%s描述', (hour, period) => {
  const current = new Date(2026, 10, 3, 12).getTime();
  const endedAt = new Date(2026, 10, 2, Number(hour)).toISOString();
  expect(formatRecentGame({ name: 'PEAK', endedAt, playedSeconds: 600 }, current)).toBe(`昨天${period}玩了十来分钟的 PEAK`);
});

it('相对时间优先于跨午夜，超过三小时后使用本地日历', () => {
  const current = new Date(2026, 10, 2, 1).getTime();
  const description = (endedAt: Date) => formatRecentGame({ name: 'PEAK', endedAt: endedAt.toISOString(), playedSeconds: 600 }, current);
  expect(description(new Date(2026, 10, 1, 23))).toBe('几小时前玩了十来分钟的 PEAK');
  expect(description(new Date(2026, 10, 1, 20))).toBe('昨天晚上玩了十来分钟的 PEAK');
  expect(description(new Date(2026, 9, 31, 23))).toBe('前天玩了十来分钟的 PEAK');
  expect(description(new Date(2026, 9, 30, 23))).toBe('前几天玩了十来分钟的 PEAK');
  expect(description(new Date(2026, 9, 26, 23))).toBe('更早之前玩了十来分钟的 PEAK');
});

it('缺少记录或时间异常不补游戏动态', () => {
  expect(formatRecentGame(null, now)).toBe('');
  for (const endedAt of ['invalid', new Date(now + 1000).toISOString()]) {
    expect(formatRecentGame({ name: 'PEAK', endedAt, playedSeconds: 600 }, now)).toBe('');
  }
  for (const playedSeconds of [-1, NaN, Infinity]) {
    expect(formatRecentGame({ name: 'PEAK', endedAt: new Date(now).toISOString(), playedSeconds }, now)).toBe('');
  }
  expect(formatRecentGame({ name: 'PEAK', endedAt: new Date(now).toISOString(), playedSeconds: 600 }, NaN)).toBe('');
});

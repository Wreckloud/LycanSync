import { expect, it } from 'vitest';
import { formatFullMessageTime, formatMessageDate, formatMessageDateDivider, formatMessageTime, localDateKey } from './messageTime';

const now = new Date(2026, 9, 30, 0, 5);

it.each([
  [new Date(2026, 10, 3, 12), '2026年11月3日'],
  [new Date(2026, 0, 1, 0, 1), '2026年1月1日'],
  [new Date(2025, 11, 31, 23, 59), '2025年12月31日'],
])('日期分割线始终显示本地年月日 %s', (date, label) => {
  expect(formatMessageDateDivider(date.toISOString())).toBe(label);
});

it.each([
  [new Date(2026, 9, 30, 0, 1), '今天'],
  [new Date(2026, 9, 29, 23, 59), '昨天'],
  [new Date(2026, 9, 28, 12), '周三'],
  [new Date(2026, 9, 24, 12), '周六'],
  [new Date(2026, 9, 23, 12), '10月23日 周五'],
  [new Date(2025, 9, 30, 12), '2025年10月30日 周四'],
  [new Date(2026, 9, 31, 12), '10月31日 周六'],
])('日期 %s 使用明确的日历标签 %s', (date, label) => {
  expect(formatMessageDate(date.toISOString(), now)).toBe(label);
});

it('跨年昨天不误用年份，超过最近六天才显示月日', () => {
  expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).toISOString(), new Date(2026, 0, 1, 0, 1)))
    .toBe('昨天 23:59');
  expect(localDateKey(new Date(2026, 0, 1, 0, 1).toISOString()))
    .not.toBe(localDateKey(new Date(2025, 11, 31, 23, 59).toISOString()));
});

it('短时间保留两位时分，完整时间保留年月日、星期和秒', () => {
  const value = new Date(2026, 9, 30, 0, 1, 9).toISOString();
  expect(formatMessageTime(value, now)).toBe('今天 00:01');
  expect(formatFullMessageTime(value)).toBe('2026年10月30日周五 00:01:09');
});

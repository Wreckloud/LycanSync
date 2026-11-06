import { expect, it } from 'vitest';
import { formatSharedVoiceTime } from './sharedVoiceTime';

it.each([
  [0, ''],
  [1, '一起开黑的时间还不到 1 分钟'],
  [60, '一起开黑的时间已经有 1 分钟了'],
  [3599, '一起开黑的时间已经有 59 分钟了'],
  [151200, '一起开黑的时间已经有 42 小时了'],
])('共同连麦 %i 秒的轻量文案', (seconds, expected) => {
  expect(formatSharedVoiceTime(seconds as number)).toBe(expected);
});

it('自己的时长使用独立文案，无记录及未知值不展示', () => {
  expect(formatSharedVoiceTime(460800, true)).toBe('累计已与朋友开黑了 128 小时');
  expect(formatSharedVoiceTime(0, true)).toBe('');
  expect(formatSharedVoiceTime(NaN, true)).toBe('');
});

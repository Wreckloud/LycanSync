import { expect, it } from 'vitest';
import { formatSharedVoiceTime } from './sharedVoiceTime';

it.each([
  [0, '还没有记录下共同开黑的时间呢。'],
  [1, '一起开黑的时间，还不到 1 分钟。'],
  [59, '一起开黑的时间，还不到 1 分钟。'],
  [60, '一起开黑的时间，已经有 1 分钟了。'],
  [3599, '一起开黑的时间，已经有 59 分钟了。'],
  [3600, '一起开黑的时间，已经有 1 小时了。'],
  [151200, '一起开黑的时间，已经有 42 小时了。'],
])('共同连麦 %i 秒的轻量文案', (seconds, expected) => {
  expect(formatSharedVoiceTime(seconds as number)).toBe(expected);
});

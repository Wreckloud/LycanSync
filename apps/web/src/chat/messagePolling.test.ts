import { describe, expect, it } from 'vitest';
import { messagePollDelay } from './messagePolling';

describe('messagePollDelay', () => {
  it('聊天活跃时保持快速刷新', () => {
    expect(messagePollDelay(0)).toBe(2_000);
  });

  it('连续没有新消息时逐级退避并限制上限', () => {
    expect(messagePollDelay(1)).toBe(4_000);
    expect(messagePollDelay(2)).toBe(8_000);
    expect(messagePollDelay(20)).toBe(8_000);
  });

  it('防止异常计数产生非法延迟', () => {
    expect(messagePollDelay(-1)).toBe(2_000);
  });
});

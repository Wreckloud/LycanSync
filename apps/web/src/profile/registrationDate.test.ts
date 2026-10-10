import { describe, expect, it } from 'vitest';
import { formatRegistrationDate } from './registrationDate';

describe('注册日期展示', () => {
  it('按本机时区展示服务端真实日期', () => {
    expect(formatRegistrationDate('2026-09-06T12:00:00Z')).toBe('2026年9月6日');
  });

  it('缺失或无效时不生成假日期', () => {
    expect(formatRegistrationDate(undefined)).toBeNull();
    expect(formatRegistrationDate('')).toBeNull();
    expect(formatRegistrationDate('not-a-date')).toBeNull();
  });
});

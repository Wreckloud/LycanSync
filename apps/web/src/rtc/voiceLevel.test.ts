import { describe, expect, it } from 'vitest';
import { normalizeVoiceLevel, quantizeVoiceLevel } from './voiceLevel';

describe('normalizeVoiceLevel', () => {
  it('过滤静音底噪和非法数值', () => {
    expect(normalizeVoiceLevel(0)).toBe(0);
    expect(normalizeVoiceLevel(0.02)).toBe(0);
    expect(normalizeVoiceLevel(Number.NaN)).toBe(0);
  });

  it('放大正常说话的可见范围并限制最大值', () => {
    expect(normalizeVoiceLevel(0.25)).toBeGreaterThan(0.45);
    expect(normalizeVoiceLevel(1)).toBe(1);
    expect(normalizeVoiceLevel(2)).toBe(1);
  });

  it('将本机音量限制为四个可见等级', () => {
    expect(quantizeVoiceLevel(0, 4)).toBe(0);
    expect(quantizeVoiceLevel(0.03, 4)).toBe(0.25);
    expect(quantizeVoiceLevel(0.25, 4)).toBe(0.5);
    expect(quantizeVoiceLevel(1, 4)).toBe(1);
  });

  it('单级模式只区分有声和无声', () => {
    expect(quantizeVoiceLevel(0, 1)).toBe(0);
    expect(quantizeVoiceLevel(0.03, 1)).toBe(1);
  });
});

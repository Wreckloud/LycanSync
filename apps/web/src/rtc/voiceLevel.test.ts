import { describe, expect, it } from 'vitest';
import { normalizeVoiceLevel, quantizeVoiceLevel } from './voiceLevel';

describe('normalizeVoiceLevel', () => {
  it('过滤静音底噪和非法数值', () => {
    for (const level of [0, -1, 0.001, 10 ** (-50 / 20), Number.NaN, Infinity, -Infinity]) {
      expect(normalizeVoiceLevel(level)).toBe(0);
    }
  });

  it('轻声、正常与较强输入占据有用的显示范围，满格不需要数字满幅', () => {
    expect(normalizeVoiceLevel(0.01)).toBeCloseTo(0.263, 3);
    expect(normalizeVoiceLevel(0.02)).toBeCloseTo(0.422, 3);
    expect(normalizeVoiceLevel(0.1)).toBeCloseTo(0.789, 3);
    expect(normalizeVoiceLevel(10 ** (-12 / 20))).toBe(1);
    expect(normalizeVoiceLevel(1)).toBe(1);
    expect(normalizeVoiceLevel(2)).toBe(1);
  });

  it('电平增加时显示只会上升，在有效区间按分贝等距变化', () => {
    let previous = 0;
    for (let db = -60; db <= 0; db++) {
      const current = normalizeVoiceLevel(10 ** (db / 20));
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(1);
      previous = current;
    }
    expect(normalizeVoiceLevel(10 ** (-20 / 20)) - normalizeVoiceLevel(10 ** (-30 / 20)))
      .toBeCloseTo(normalizeVoiceLevel(10 ** (-30 / 20)) - normalizeVoiceLevel(10 ** (-40 / 20)));
  });

  it('将本机音量限制为四个可见等级', () => {
    expect(quantizeVoiceLevel(0, 4)).toBe(0);
    expect(quantizeVoiceLevel(0.005, 4)).toBe(0.25);
    expect(quantizeVoiceLevel(0.02, 4)).toBe(0.5);
    expect(quantizeVoiceLevel(0.05, 4)).toBe(0.75);
    expect(quantizeVoiceLevel(0.25, 4)).toBe(1);
    expect(quantizeVoiceLevel(1, 4)).toBe(1);
  });

  it('单级模式只区分有声和无声', () => {
    expect(quantizeVoiceLevel(0, 1)).toBe(0);
    expect(quantizeVoiceLevel(0.03, 1)).toBe(1);
  });
});

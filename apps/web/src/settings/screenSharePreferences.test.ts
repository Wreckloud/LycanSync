import { describe, expect, it } from 'vitest';
import { readScreenSharePreferences, saveScreenSharePreferences } from './screenSharePreferences';

describe('screenSharePreferences', () => {
  it('默认保留共享光标，优先无系统边框', () => {
    expect(readScreenSharePreferences({ getItem: () => null })).toEqual({ hideCursor: false, hideBorder: true });
  });

  it('只记住光标偏好，边框许可与手动方式不变成长期授权', () => {
    let saved = '';
    saveScreenSharePreferences({ hideCursor: true, hideBorder: false, windowMethod: 'wgc' }, { setItem: (_key, value) => { saved = value; } });
    expect(JSON.parse(saved)).toEqual({ hideCursor: true });
    expect(readScreenSharePreferences({ getItem: () => saved })).toEqual({ hideCursor: true, hideBorder: true });
    expect(readScreenSharePreferences({ getItem: () => '{"hideCursor":true,"hideBorder":false}' }))
      .toEqual({ hideCursor: true, hideBorder: true });
  });

  it('损坏或非法类型的偏好明确失败', () => {
    for (const saved of ['null', '{}', '{', '{"hideCursor":"false","hideBorder":false}']) {
      expect(() => readScreenSharePreferences({ getItem: () => saved })).toThrow();
    }
  });
});

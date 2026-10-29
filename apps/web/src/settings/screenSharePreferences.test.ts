import { describe, expect, it } from 'vitest';
import { readScreenSharePreferences, saveScreenSharePreferences } from './screenSharePreferences';

describe('screenSharePreferences', () => {
  it('默认保留共享光标，边框由当次选择说明', () => {
    expect(readScreenSharePreferences({ getItem: () => null })).toEqual({ hideCursor: false, hideBorder: false });
  });

  it('只记住光标偏好，边框许可与手动方式不变成长期授权', () => {
    let saved = '';
    saveScreenSharePreferences({ hideCursor: true, hideBorder: false, windowMethod: 'auto' }, { setItem: (_key, value) => { saved = value; } });
    expect(JSON.parse(saved)).toEqual({ hideCursor: true });
    expect(readScreenSharePreferences({ getItem: () => saved })).toEqual({ hideCursor: true, hideBorder: false });
    expect(readScreenSharePreferences({ getItem: () => '{"hideCursor":true,"hideBorder":true}' }))
      .toEqual({ hideCursor: true, hideBorder: false });
  });

  it('损坏或非法类型的偏好明确失败', () => {
    for (const saved of ['null', '{}', '{', '{"hideCursor":"false","hideBorder":false}']) {
      expect(() => readScreenSharePreferences({ getItem: () => saved })).toThrow();
    }
  });
});

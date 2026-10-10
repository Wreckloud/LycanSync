import { describe, expect, it } from 'vitest';
import { readScreenSharePreferences, saveScreenSharePreferences } from './screenSharePreferences';

describe('screenSharePreferences', () => {
  it('默认保留共享光标和系统边框', () => {
    expect(readScreenSharePreferences({ getItem: () => null })).toEqual({ hideCursor: false, hideBorder: false });
  });

  it('保存后下次采集读取相同设置', () => {
    let saved = '';
    saveScreenSharePreferences({ hideCursor: true, hideBorder: false }, { setItem: (_key, value) => { saved = value; } });
    expect(readScreenSharePreferences({ getItem: () => saved })).toEqual({ hideCursor: true, hideBorder: false });
  });

  it('损坏或非法类型的偏好明确失败', () => {
    for (const saved of ['null', '{}', '{', '{"hideCursor":"false","hideBorder":false}']) {
      expect(() => readScreenSharePreferences({ getItem: () => saved })).toThrow();
    }
  });
});

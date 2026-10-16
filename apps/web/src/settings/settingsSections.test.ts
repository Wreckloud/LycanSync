import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, settingsSectionTitle } from './settingsSections';

describe('设置栏目', () => {
  it('账号与音频栏目使用统一标题', () => {
    expect(settingsSectionTitle('account')).toBe('账号设置');
    expect(settingsSectionTitle('audio')).toBe('语音与音频');
  });

  it('资料和活动归入账号栏目，不新增重复导航', () => {
    expect(SETTINGS_SECTIONS.map(({ id }) => id)).toEqual(['account', 'audio', 'sound', 'overlay', 'client', 'about', 'members']);
  });
});

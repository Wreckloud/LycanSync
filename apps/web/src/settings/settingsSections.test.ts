import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, settingsSectionForEntry, settingsSectionTitle } from './settingsSections';

describe('settings sections', () => {
  it('routes both existing entrances into the shared settings page', () => {
    expect(settingsSectionForEntry('avatar')).toBe('account');
    expect(settingsSectionForEntry('gear')).toBe('audio');
    expect(settingsSectionTitle(settingsSectionForEntry('avatar'))).toBe('账号设置');
    expect(settingsSectionTitle(settingsSectionForEntry('gear'))).toBe('语音与音频');
  });

  it('groups profile and activity into one account page', () => {
    expect(SETTINGS_SECTIONS.map(({ id }) => id)).toEqual(['account', 'audio', 'sound', 'client', 'about', 'members']);
  });
});

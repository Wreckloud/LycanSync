export const SETTINGS_SECTIONS = [
  { id: 'account', title: '账号设置' },
  { id: 'audio', title: '语音与音频' },
  { id: 'sound', title: '音效' },
  { id: 'overlay', title: '屏幕覆盖' },
  { id: 'client', title: '客户端' },
  { id: 'about', title: '关于与诊断' },
  { id: 'members', title: '邀请与成员' },
] as const;

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

export function settingsSectionTitle(section: SettingsSectionId) {
  return SETTINGS_SECTIONS.find((item) => item.id === section)!.title;
}

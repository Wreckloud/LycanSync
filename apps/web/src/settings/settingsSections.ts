export const SETTINGS_SECTIONS = [
  { id: 'account', title: '账号设置', description: '管理个人资料、在线展示和账号。' },
  { id: 'audio', title: '语音与音频', description: '选择通话设备，调整音量和声音处理。' },
  { id: 'sound', title: '音效', description: '调整操作提示音，设置自己的入场音效。' },
  { id: 'shortcuts', title: '快捷键', description: '在游戏或其他应用中，也能快捷切换麦克风、收听和保存回放。' },
  { id: 'recording', title: '共享与录制', description: '设置共享画质、录像和即时回放。' },
  { id: 'overlay', title: '屏幕覆盖', description: '在游戏画面上查看通话成员和说话状态。' },
  { id: 'client', title: '客户端', description: '查看应用版本，管理启动方式、日志和缓存。' },
  { id: 'members', title: '服主管理', description: '管理成员访问、服务器配置和服主权限。' },
] as const;

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

export function settingsSectionTitle(section: SettingsSectionId) {
  return SETTINGS_SECTIONS.find((item) => item.id === section)!.title;
}

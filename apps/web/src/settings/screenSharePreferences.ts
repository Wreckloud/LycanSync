export type WindowCaptureMethod = 'auto' | 'game' | 'bitblt' | 'wgc';

export interface ScreenSharePreferences {
  hideCursor: boolean;
  hideBorder: boolean;
  windowMethod?: WindowCaptureMethod;
}

const STORAGE_KEY = 'lycansync.screen-share';

/** 当前设备的采集偏好只在新建共享会话时读取。 */
export function readScreenSharePreferences(storage?: Pick<Storage, 'getItem'>): ScreenSharePreferences {
  const saved = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
  if (!saved) return { hideCursor: false, hideBorder: true };
  const value = JSON.parse(saved) as Partial<ScreenSharePreferences>;
  if (!value || typeof value.hideCursor !== 'boolean'
      || (value.hideBorder !== undefined && typeof value.hideBorder !== 'boolean')) {
    throw new Error('屏幕共享设置格式无效，请重新保存设置。');
  }
  // 旧边框偏好不再作为长期授权；是否允许带框由本次来源选择确认。
  return { hideCursor: value.hideCursor, hideBorder: true };
}

export function saveScreenSharePreferences(settings: ScreenSharePreferences, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify({ hideCursor: settings.hideCursor }));
}

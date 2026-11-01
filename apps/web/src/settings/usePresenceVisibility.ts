import { ref } from 'vue';

export function usePresenceVisibility(userId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `lycansync.activity-visible.v1.${userId}`;
  const lastOnlineKey = `lycansync.last-online-visible.v1.${userId}`;
  const showActivity = ref(true);
  const showLastOnline = ref(true);
  const error = ref('');
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored !== null && stored !== 'true' && stored !== 'false') throw new Error('invalid activity preference');
    showActivity.value = stored !== 'false';
    const lastOnline = (storage ?? localStorage).getItem(lastOnlineKey);
    if (lastOnline !== null && lastOnline !== 'true' && lastOnline !== 'false') throw new Error('invalid last online preference');
    showLastOnline.value = lastOnline !== 'false';
  } catch {
    showActivity.value = false;
    showLastOnline.value = false;
    error.value = '无法读取展示偏好，当前不公开动态和上次在线时间。';
  }

  function setShowActivity(enabled: boolean) {
    showActivity.value = enabled;
    error.value = '';
    try {
      (storage ?? localStorage).setItem(key, String(enabled));
    } catch {
      error.value = '本次修改已生效，但无法保存到本机。';
    }
  }

  function setShowLastOnline(enabled: boolean) {
    showLastOnline.value = enabled;
    error.value = '';
    try { (storage ?? localStorage).setItem(lastOnlineKey, String(enabled)); }
    catch { error.value = '本次修改已生效，但无法保存到本机。'; }
  }

  return { showActivity, showLastOnline, error, setShowActivity, setShowLastOnline };
}

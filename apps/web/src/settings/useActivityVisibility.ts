import { ref } from 'vue';

export function useActivityVisibility(userId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `lycansync.activity-visible.v1.${userId}`;
  const showActivity = ref(true);
  const error = ref('');
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored !== null && stored !== 'true' && stored !== 'false') throw new Error('invalid activity preference');
    showActivity.value = stored !== 'false';
  } catch {
    showActivity.value = false;
    error.value = '无法读取动态偏好，当前不显示动态。';
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

  return { showActivity, error, setShowActivity };
}

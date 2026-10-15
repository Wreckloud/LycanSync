import { ref } from 'vue';

export function useStagePreferences(userId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `lycansync.stage-auto-fill.v1.${userId}`;
  const autoFill = ref(true);
  const error = ref('');
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored !== null && stored !== 'true' && stored !== 'false') throw new Error('invalid stage preference');
    autoFill.value = stored !== 'false';
  } catch {
    error.value = '无法读取舞台偏好，当前使用自动填充。';
  }

  function setAutoFill(enabled: boolean) {
    autoFill.value = enabled;
    error.value = '';
    try { (storage ?? localStorage).setItem(key, String(enabled)); }
    catch { error.value = '本次修改已生效，但无法保存到本机。'; }
  }

  return { autoFill, error, setAutoFill };
}

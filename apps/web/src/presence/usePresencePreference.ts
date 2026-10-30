import { ref } from 'vue';

export type PresenceMode = 'online' | 'invisible';

export function usePresencePreference(userId: string,
  desktop?: Pick<NonNullable<Window['lycanDesktop']>, 'getServerSettings'>,
  storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  // 读取完成前不公开在线状态，避免重启时短暂暴露隐身用户。
  const mode = ref<PresenceMode>('invisible');
  const ready = ref(false);
  const error = ref('');
  let key: string | undefined;
  const loaded = (async () => {
    try {
      const server = desktop ? (await desktop.getServerSettings()).apiUrl : window.location.origin;
      key = `lycansync.presence-mode.v1.${JSON.stringify([new URL(server).origin, userId])}`;
      const stored = (storage ?? localStorage).getItem(key);
      if (stored !== null && stored !== 'online' && stored !== 'invisible') throw new Error('invalid presence preference');
      mode.value = stored === 'invisible' ? 'invisible' : 'online';
    } catch {
      error.value = '无法读取状态偏好，本次先隐身；可手动选择状态。';
    } finally {
      ready.value = true;
    }
  })();

  function setMode(next: PresenceMode) {
    if (!ready.value) return;
    mode.value = next;
    error.value = '';
    try {
      if (!key) throw new Error('presence preference server unavailable');
      (storage ?? localStorage).setItem(key, next);
    } catch {
      error.value = '状态已选择，但无法保存到本机，重启后可能无法恢复。';
    }
  }

  return { mode, ready, error, loaded, setMode };
}

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
      error.value = '无法读取上次的在线状态，暂时保持隐身；你可以手动切换。';
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
      error.value = '当前状态已生效，但未能保存，重启后可能恢复原设置。';
    }
  }

  return { mode, ready, error, loaded, setMode };
}

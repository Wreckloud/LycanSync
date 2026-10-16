import { onScopeDispose, ref } from 'vue';

type ActivityBridge = Pick<NonNullable<Window['lycanDesktop']>, 'configureActivityMappings' | 'listActivityWindows'>;

export function useActivityMappings(userId: string, desktop?: ActivityBridge,
  storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `lycansync.activity-mappings.v1.${userId}`;
  const entries = ref<ActivityMapping[]>([]);
  const windows = ref<ActivityWindow[]>([]);
  const busy = ref(false);
  const loading = ref(false);
  const ready = ref(!desktop);
  const error = ref('');
  const windowError = ref('');
  let disposed = false;
  let windowRevision = 0;

  function validMapping(value: unknown): value is ActivityMapping {
    if (!value || typeof value !== 'object') return false;
    const entry = value as ActivityMapping;
    return typeof entry.executable === 'string' && /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\).+\.exe$/i.test(entry.executable)
      && entry.executable.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(entry.executable)
      && typeof entry.name === 'string' && !!entry.name.trim() && entry.name.length <= 80
      && !/[\u0000-\u001f\u007f]/.test(entry.name);
  }

  async function initialize() {
    if (!desktop || disposed || busy.value) return;
    busy.value = true;
    error.value = '';
    let saved: ActivityMapping[] = [];
    try {
      const stored: unknown = JSON.parse((storage ?? localStorage).getItem(key) ?? '[]');
      if (!Array.isArray(stored) || stored.length > 32 || !stored.every(validMapping)
          || new Set(stored.map((entry) => entry.executable)).size !== stored.length) {
        throw new Error('invalid activity mappings');
      }
      saved = stored;
    } catch {
      error.value = '无法读取已记忆的动态名称，请重新选择程序。';
    }
    try {
      await desktop.configureActivityMappings(saved);
      if (disposed) return;
      entries.value = saved;
      ready.value = true;
    } catch {
      if (!disposed) error.value = '无法应用动态名称，请重试。';
    } finally {
      if (!disposed) busy.value = false;
    }
  }

  async function refreshWindows() {
    if (!desktop || disposed || loading.value) return;
    const revision = ++windowRevision;
    loading.value = true;
    windowError.value = '';
    try {
      const snapshot = await desktop.listActivityWindows();
      if (!disposed && revision === windowRevision) windows.value = snapshot;
    } catch {
      if (!disposed && revision === windowRevision) windowError.value = '无法读取运行窗口，请刷新重试。';
    } finally {
      if (!disposed && revision === windowRevision) loading.value = false;
    }
  }

  async function replace(next: ActivityMapping[]) {
    if (!desktop || disposed || busy.value || !ready.value) return false;
    busy.value = true;
    error.value = '';
    try {
      await desktop.configureActivityMappings(next);
      if (disposed) return false;
      entries.value = next;
      try { (storage ?? localStorage).setItem(key, JSON.stringify(next)); }
      catch { error.value = '本次名称已生效，但无法保存到本机。'; }
      return true;
    } catch {
      if (!disposed) error.value = '动态名称未能应用，请重试。';
      return false;
    } finally {
      if (!disposed) busy.value = false;
    }
  }

  async function save(executable: string, name: string) {
    const mapping = { executable, name: name.trim() };
    if (!validMapping(mapping)) {
      error.value = '请输入 1–80 个字符的显示名称。';
      return false;
    }
    // 新条目只能来自本次窗口清单，不能通过输入名称创建虚构程序。
    if (!entries.value.some((entry) => entry.executable === executable)
        && !windows.value.some((window) => window.executable === executable)) {
      error.value = '请先从运行窗口中选择程序。';
      return false;
    }
    // 同一游戏可能有大厅和对局程序，末尾代表最近保存的名称修正。
    const next = entries.value.filter((entry) => entry.executable !== executable).concat(mapping);
    if (next.length > 32) { error.value = '最多记忆 32 个程序，请先移除不再使用的条目。'; return false; }
    return replace(next);
  }

  function remove(executable: string) {
    return replace(entries.value.filter((entry) => entry.executable !== executable));
  }

  void initialize();
  onScopeDispose(() => { disposed = true; windowRevision++; });
  return { entries, windows, busy, loading, ready, error, windowError, initialize, refreshWindows, save, remove };
}

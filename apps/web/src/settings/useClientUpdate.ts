import { onScopeDispose, ref, watch } from 'vue';

type UpdateBridge = Pick<NonNullable<Window['lycanDesktop']>,
  'getUpdateState' | 'checkUpdates' | 'restartForUpdate' | 'onUpdateState'>;

/** 设置页只检查和确认重启；下载、校验与安装仍由主进程启动流程负责。 */
export function useClientUpdate(bridge: UpdateBridge | undefined, active: () => boolean) {
  const state = ref<StartupUpdateState>();
  const error = ref('');
  const busy = ref(false);
  const confirmationVersion = ref('');
  let disposed = false;
  let loaded = false;
  let attempt = 0;
  let stateRevision = 0;
  const removeListener = bridge?.onUpdateState((next) => {
    if (disposed) return;
    stateRevision++;
    state.value = next;
  });

  watch(active, (visible) => {
    if (!visible) { attempt++; confirmationVersion.value = ''; return; }
    if (!bridge || loaded) return;
    loaded = true;
    const revision = stateRevision;
    void bridge.getUpdateState().then((next) => {
      if (!disposed && revision === stateRevision) state.value = next;
    }).catch(() => { if (!disposed) error.value = '无法读取更新状态，请重新打开客户端。'; });
  }, { immediate: true });

  async function check() {
    if (!bridge || busy.value || !state.value?.supported) return;
    const checking = ++attempt;
    busy.value = true;
    error.value = '';
    confirmationVersion.value = '';
    try {
      const next = await bridge.checkUpdates();
      if (disposed) return;
      state.value = next;
      if (checking === attempt && active() && next.phase === 'ready' && next.supported && !next.error && next.nextVersion) {
        confirmationVersion.value = next.nextVersion;
      }
    } catch {
      if (!disposed) error.value = '无法检查更新，请稍后重试。';
    } finally { if (!disposed) busy.value = false; }
  }

  function cancel() { if (!busy.value) confirmationVersion.value = ''; }

  async function restart() {
    if (!bridge || busy.value || !confirmationVersion.value) return;
    busy.value = true;
    error.value = '';
    try {
      await bridge.restartForUpdate();
      // 成功后保持禁用，窗口正在执行正常媒体退出，不能重复排队重启。
    } catch {
      if (!disposed) {
        error.value = '无法重启更新，请稍后重试。';
        busy.value = false;
      }
    }
  }

  onScopeDispose(() => { disposed = true; attempt++; removeListener?.(); });
  return { state, error, busy, confirmationVersion, check, cancel, restart };
}

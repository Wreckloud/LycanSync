import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { PRESENCE_STATUS_LABELS, sendPresenceHeartbeat, type UserPresenceStatus } from './presenceApi';
import { usePresencePreference, type PresenceMode } from './usePresencePreference';

type PresenceDesktop = Pick<NonNullable<Window['lycanDesktop']>, 'getSystemIdleState' | 'getCurrentActivity' | 'onActivityChange' | 'getServerSettings'>;

const PRESENCE_HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_IDLE_TIMEOUT_MS = 5 * 60_000;
const PRESENCE_IDLE_CHECK_INTERVAL_MS = 2_000;

// 当前账号的公开状态：串行同步隐私选择，并持有本机活动及闲置检测的清理责任。
export function useOwnPresence(userId: string, visibility: { showActivity: Ref<boolean>; showLastOnline: Ref<boolean> }, desktop?: PresenceDesktop) {
  const { showActivity, showLastOnline } = visibility;
  let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let presenceIdleTimer: ReturnType<typeof setInterval> | null = null;
  let presenceIdleRequest = 0;
  let presenceRecovery: { startedAt: number; lastInputAt: number; samples: number } | null = null;
  let presenceAbort: AbortController | null = null;
  let presenceStopped = false;
  const currentPresenceStatus = ref<UserPresenceStatus>('ONLINE');
  const presencePreference = usePresencePreference(userId, desktop);
  const { mode: presenceMode, ready: presenceReady, error: presencePreferenceError } = presencePreference;
  const publicPresenceStatus = computed<UserPresenceStatus>(() => presenceMode.value === 'invisible' ? 'OFFLINE' : currentPresenceStatus.value);
  const personalPresenceLabel = computed(() => !presenceReady.value ? '正在读取状态…'
    : presenceMode.value === 'invisible' ? '隐身' : PRESENCE_STATUS_LABELS[currentPresenceStatus.value]);
  const presenceSyncing = ref(false);
  const presenceSyncError = ref('');
  let presenceSending: Promise<void> | null = null;
  let presenceHeartbeatPending = false;
  let presenceModeChange = 0;
  const currentActivity = ref<DetectedActivity | null>(null);
  const sharedActivity = computed(() => showActivity.value && presenceMode.value === 'online' ? currentActivity.value : null);
  let activityRevision = 0;
  const activitySnapshotRevision = activityRevision;
  watch([showActivity, showLastOnline], () => { void sendHeartbeat(); });

  function applyDetectedActivity(activity: DetectedActivity | null) {
    if (presenceStopped) return;
    activityRevision++;
    if (JSON.stringify(activity) === JSON.stringify(currentActivity.value)) return;
    currentActivity.value = activity;
    void sendHeartbeat();
  }
  const removeActivityListener = desktop?.onActivityChange(applyDetectedActivity);
  void desktop?.getCurrentActivity().then((activity) => {
    if (activityRevision === activitySnapshotRevision) applyDetectedActivity(activity);
  }).catch(() => undefined);

  function sendHeartbeat(): Promise<void> {
    if (presenceStopped) return Promise.resolve();
    presenceHeartbeatPending = true;
    // 同一会话串行发送并合并待发状态，旧在线请求结束后再提交最新隐身选择。
    if (!presenceSending) presenceSending = flushPresenceHeartbeats();
    return presenceSending;
  }

  async function flushPresenceHeartbeats() {
    try {
      await presencePreference.loaded;
      while (presenceHeartbeatPending && !presenceStopped) {
        presenceHeartbeatPending = false;
        const controller = new AbortController();
        presenceAbort = controller;
        const status = publicPresenceStatus.value;
        const activity = sharedActivity.value ? { type: sharedActivity.value.type, name: sharedActivity.value.name } : null;
        presenceSyncing.value = true;
        try {
          await sendPresenceHeartbeat(status, activity, controller.signal, { showActivity: showActivity.value, showLastOnline: showLastOnline.value });
          if (!presenceStopped && !controller.signal.aborted && status === publicPresenceStatus.value) presenceSyncError.value = '';
        } catch {
          if (!presenceStopped && !controller.signal.aborted) presenceSyncError.value = '状态设置尚未同步，将自动重试。';
        } finally {
          if (presenceAbort === controller) presenceAbort = null;
        }
      }
    } finally {
      presenceSending = null;
      presenceSyncing.value = false;
    }
  }

  async function changePresenceMode(mode: PresenceMode) {
    if (!presenceReady.value) return;
    const change = ++presenceModeChange;
    if (mode === 'online') await updateOwnPresenceStatus();
    if (presenceStopped || change !== presenceModeChange) return;
    presencePreference.setMode(mode);
    await sendHeartbeat();
  }

  function startPresenceHeartbeat() {
    if (presenceHeartbeatTimer) return;
    if (presenceStopped) return;
    void updateOwnPresenceStatus();
    void sendHeartbeat();
    presenceHeartbeatTimer = setInterval(() => void sendHeartbeat(), PRESENCE_HEARTBEAT_INTERVAL_MS);
    presenceIdleTimer = setInterval(() => void updateOwnPresenceStatus(), PRESENCE_IDLE_CHECK_INTERVAL_MS);
    document.addEventListener('click', confirmPresenceInteraction, true);
    document.addEventListener('keydown', confirmPresenceInteraction, true);
  }

  function stopPresenceHeartbeat() {
    presenceStopped = true;
    presenceHeartbeatPending = false;
    presenceAbort?.abort();
    presenceAbort = null;
    if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
    if (presenceIdleTimer) clearInterval(presenceIdleTimer);
    presenceIdleTimer = null;
    document.removeEventListener('click', confirmPresenceInteraction, true);
    document.removeEventListener('keydown', confirmPresenceInteraction, true);
  }

  function prepareLogout() {
    stopPresenceHeartbeat();
    return { showActivity: showActivity.value, showLastOnline: showLastOnline.value };
  }

  async function reportOfflineBeforeClose() {
    await sendPresenceHeartbeat('OFFLINE', null, AbortSignal.timeout(1_200), prepareLogout()).catch(() => undefined);
  }

  async function updateOwnPresenceStatus() {
    const request = ++presenceIdleRequest;
    const sampledAt = performance.now();
    const systemIdle = await desktop?.getSystemIdleState().catch(() => null);
    // 系统查询失败时保留上次状态，下一轮重试，不能据此判定用户已经恢复操作。
    if (presenceStopped || request !== presenceIdleRequest) return;
    if (desktop && (!systemIdle || systemIdle.state === 'unknown')) { presenceRecovery = null; return; }
    const nextStatus = systemIdle && (systemIdle.state === 'idle' || systemIdle.state === 'locked'
      || systemIdle.idleSeconds >= PRESENCE_IDLE_TIMEOUT_MS / 1000) ? 'AWAY' : 'ONLINE';
    if (nextStatus === 'AWAY' || currentPresenceStatus.value !== 'AWAY') presenceRecovery = null;
    else if (systemIdle) {
      // 闲置秒数会取整；只有新的输入时间明显前进，才算另一轮操作。
      const lastInputAt = sampledAt - systemIdle.idleSeconds * 1000;
      if (systemIdle.idleSeconds > 2) { presenceRecovery = null; return; }
      if (!presenceRecovery || lastInputAt - presenceRecovery.lastInputAt > 4000) {
        presenceRecovery = { startedAt: sampledAt, lastInputAt, samples: 1 };
        return;
      }
      if (lastInputAt - presenceRecovery.lastInputAt <= 1000) return;
      presenceRecovery.lastInputAt = lastInputAt;
      presenceRecovery.samples++;
      if (sampledAt - presenceRecovery.startedAt < 6000 || presenceRecovery.samples < 3) return;
      presenceRecovery = null;
    }
    if (nextStatus === currentPresenceStatus.value) return;
    currentPresenceStatus.value = nextStatus;
    void sendHeartbeat();
  }

  function confirmPresenceInteraction(event: Event) {
    if (!event.isTrusted || presenceStopped || document.visibilityState === 'hidden'
        || currentPresenceStatus.value !== 'AWAY') return;
    if (event instanceof KeyboardEvent && (event.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key))) return;
    if (!(event.target instanceof Element) || !event.target.closest('button, a[href], input, textarea, [contenteditable="true"], [role="button"]')) return;
    presenceIdleRequest++;
    presenceRecovery = null;
    currentPresenceStatus.value = 'ONLINE';
    void sendHeartbeat();
  }

  onScopeDispose(() => { stopPresenceHeartbeat(); removeActivityListener?.(); });
  return { currentActivity, sharedActivity, currentPresenceStatus, publicPresenceStatus, personalPresenceLabel,
    presenceMode, presenceReady, presencePreferenceError, presenceSyncing, presenceSyncError,
    sendHeartbeat, changePresenceMode, startPresenceHeartbeat, updateOwnPresenceStatus, prepareLogout, reportOfflineBeforeClose,
    get stopped() { return presenceStopped; } };
}

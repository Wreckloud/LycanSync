import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { findGroupPresences, nextPresenceWaitRequest, waitForGroupPresenceChanges,
  type GroupDetail, type GroupPresence, type GroupPresenceChangeCursor } from './groupApi';

// 当前预览群组的状态订阅；资料与成员资格仍交给原有群组加载流程核对。
export function useGroupPresences(selectedGroupId: Ref<string | null>,
  currentDetail: () => Pick<GroupDetail, 'id' | 'members'> | null,
  refreshDetail: (groupId: string, keepExisting: boolean) => Promise<void>) {
  const groupPresences = ref<Record<string, GroupPresence>>({});
  let groupPresenceRequest: AbortController | null = null;
  let groupPresenceWaitRequest: AbortController | null = null;
  let groupPresenceWatchGeneration = 0;
  let groupPresenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelGroupPresenceRetry: (() => void) | null = null;
  const presenceCursors = new Map<string, Pick<GroupPresenceChangeCursor, 'serverInstanceId' | 'version' | 'detailVersion'>>();
  const presenceConnectionLost = ref(false);
  async function refreshGroupPresences(groupId: string, generation: number, signal: AbortSignal) {
    try {
      const result = await findGroupPresences(groupId, signal);
      if (!signal.aborted && generation === groupPresenceWatchGeneration && selectedGroupId.value === groupId) {
        groupPresences.value = Object.fromEntries(result.map((presence) => [presence.userId, presence]));
        const detail = currentDetail();
        const memberIds = new Set(result.map((presence) => presence.userId));
        if (detail?.id === groupId && (detail.members.length !== memberIds.size
            || detail.members.some((member) => !memberIds.has(member.userId)))) {
          // 状态快照也确认当前成员资格；名单变化时立即复核资料，不等待群列表周期刷新。
          void refreshDetail(groupId, true);
        }
        presenceConnectionLost.value = false;
        return true;
      }
      return false;
    } catch {
      if (!signal.aborted && generation === groupPresenceWatchGeneration) presenceConnectionLost.value = true;
      return false;
    }
  }

  function waitForPresenceRetry(delayMs: number, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        if (groupPresenceRetryTimer) clearTimeout(groupPresenceRetryTimer);
        groupPresenceRetryTimer = null;
        cancelGroupPresenceRetry = null;
        signal.removeEventListener('abort', finish);
        resolve();
      };
      cancelGroupPresenceRetry = finish;
      groupPresenceRetryTimer = setTimeout(finish, delayMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  function stopGroupPresenceSync() {
    groupPresenceWatchGeneration++;
    groupPresenceWaitRequest?.abort();
    groupPresenceWaitRequest = null;
    groupPresenceRequest?.abort();
    groupPresenceRequest = null;
    cancelGroupPresenceRetry?.();
  }

  function refreshGroupPresence() {
    const groupId = selectedGroupId.value;
    stopGroupPresenceSync();
    const generation = groupPresenceWatchGeneration;
    if (!groupId) {
      groupPresences.value = {};
      presenceConnectionLost.value = false;
      return;
    }

    const controller = new AbortController();
    groupPresenceWaitRequest = controller;
    void (async () => {
      let retryDelayMs = 1_000;
      let refreshSnapshot = true;
      while (!controller.signal.aborted && generation === groupPresenceWatchGeneration
          && selectedGroupId.value === groupId) {
        try {
          if (refreshSnapshot) {
            const snapshotController = new AbortController();
            groupPresenceRequest = snapshotController;
            const loaded = await refreshGroupPresences(groupId, generation, snapshotController.signal);
            if (controller.signal.aborted || generation !== groupPresenceWatchGeneration) return;
            if (!loaded) throw new Error('暂时无法更新成员状态。');
            refreshSnapshot = false;
          }

          const waiter = nextPresenceWaitRequest();
          const response = await waitForGroupPresenceChanges(groupId, waiter.clientId, waiter.requestId,
            presenceCursors.get(groupId) ?? null, controller.signal);
          if (controller.signal.aborted || generation !== groupPresenceWatchGeneration
              || selectedGroupId.value !== groupId) return;
          const previous = presenceCursors.get(groupId);
          // 首次建立游标后也复核资料，覆盖初始读取与订阅之间恰好提交的修改。
          if (!previous || previous.serverInstanceId !== response.serverInstanceId || previous.detailVersion !== response.detailVersion) {
            void refreshDetail(groupId, currentDetail()?.id === groupId);
          }
          presenceCursors.set(groupId, { serverInstanceId: response.serverInstanceId, version: response.version, detailVersion: response.detailVersion });
          presenceConnectionLost.value = false;
          retryDelayMs = 1_000;
          if (response.changed) refreshSnapshot = true;
        } catch {
          if (controller.signal.aborted || generation !== groupPresenceWatchGeneration) return;
          presenceConnectionLost.value = true;
          refreshSnapshot = true;
          await waitForPresenceRetry(retryDelayMs, controller.signal);
          retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
        }
      }
    })();
  }

  watch(selectedGroupId, () => {
    groupPresences.value = {};
    presenceConnectionLost.value = false;
    refreshGroupPresence();
  });
  onScopeDispose(stopGroupPresenceSync);
  return { groupPresences, presenceConnectionLost, refreshGroupPresence };
}

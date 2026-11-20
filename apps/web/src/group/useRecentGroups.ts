import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { AccountCache } from '../cache/localCache';
import type { ChatMessage } from '../chat/chatApi';
import type { GroupSummary } from './groupApi';

export function useRecentGroups(groups: Ref<GroupSummary[]>, cache: AccountCache, userId: string) {
  const activity = ref(new Map<string, number>());
  let disposed = false;
  function mark(groupId: string) {
    if (disposed || !groups.value.some(group => group.id === groupId)) return;
    const time = Date.now();
    activity.value.set(groupId, time);
    void cache.write('groupActivity', groupId, time);
  }
  watch(groups, (current, previous = []) => {
    for (const id of activity.value.keys()) if (!current.some(group => group.id === id)) activity.value.delete(id);
    for (const group of current.filter(group => !previous.some(item => item.id === group.id))) {
      // 旧版本没有互动记录时，从已有聊天缓存补入自己的发言时间，不额外请求群聊历史。
      void Promise.all([
        cache.read<number>('groupActivity', group.id),
        cache.read<{ messages: ChatMessage[] }>('messages', group.id),
      ]).then(([stored, chat]) => {
        if (disposed || !groups.value.some(item => item.id === group.id)) return;
        let latest = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
        for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
          const sentAt = message?.senderUserId === userId ? Date.parse(message.createdAt) : NaN;
          if (Number.isFinite(sentAt)) latest = Math.max(latest, sentAt);
        }
        activity.value.set(group.id, Math.max(activity.value.get(group.id) ?? 0, latest));
      });
    }
  }, { immediate: true });
  onScopeDispose(() => { disposed = true; });
  const sorted = computed(() => [...groups.value].sort((a, b) => (activity.value.get(b.id) ?? 0) - (activity.value.get(a.id) ?? 0)));
  return { sorted, mark };
}

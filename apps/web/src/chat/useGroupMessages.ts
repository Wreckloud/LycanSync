import { nextTick, onScopeDispose, ref } from 'vue';
import { ApiRequestError } from '../auth/authApi';
import type { AccountCache } from '../cache/localCache';
import { findMessages, type ChatMessage } from './chatApi';
import { messagePollDelay } from './messagePolling';
import type { useChatScroll } from './useChatScroll';

type MessageScroll = Pick<ReturnType<typeof useChatScroll>, 'list' | 'atBottom' | 'followingScroll' | 'unreadMessageIds'
  | 'scrollToBottom' | 'updateReadMessages' | 'preserveHistoryPosition' | 'finishHistoryLoad' | 'resetReadingPosition'>;

// 随按群 ID 创建的 GroupChat 销毁，独占该群的请求、游标与缓存写入计时器。
export function useGroupMessages({ getGroupId, getUserId, cache, scroll, onInitialLoad }: {
  getGroupId: () => string;
  getUserId: () => string;
  cache: AccountCache | null;
  scroll: MessageScroll;
  onInitialLoad: (groupId: string) => void;
}) {
  const { list, atBottom, followingScroll, unreadMessageIds, scrollToBottom, updateReadMessages } = scroll;
  let cacheLoaded = false;
  let initialLoadNotified = false;
  let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
  let cacheWriteRevision = cache?.revision;
  const messages = ref<ChatMessage[]>([]);
  const pollError = ref('');
  const historyError = ref('');
  const initialLoaded = ref(false);
  const refreshing = ref(false);
  const loadingOlder = ref(false);
  const hasMore = ref(false);
  let pollRequest: AbortController | null = null;
  let historyRequest: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestFetchedMessageId: string | undefined;
  let consecutiveEmptyPolls = 0;
  let lastActivationRefreshAt = 0;
  let disposed = false;

  function appendMessages(incoming: ChatMessage[], forceScroll = false, behavior: ScrollBehavior = 'smooth') {
    const known = new Set(messages.value.map((message) => message.id));
    const added = incoming.filter((message) => {
      if (known.has(message.id)) return false;
      known.add(message.id);
      return true;
    });
    if (!added.length) return 0;
    messages.value = [...messages.value, ...added];
    if (forceScroll || atBottom.value || followingScroll.value) void scrollToBottom(behavior, forceScroll);
    return added.length;
  }

  function writeMessageCache() {
    if (cache?.revision !== cacheWriteRevision) return;
    const confirmedEnd = latestFetchedMessageId ? messages.value.findIndex(message => message.id === latestFetchedMessageId) + 1 : 0;
    if (!confirmedEnd && (!initialLoaded.value || messages.value.length)) return;
    const confirmed = messages.value.slice(0, confirmedEnd);
    void cache?.write('messages', getGroupId(), {
      messages: confirmed.slice(-500), hasMore: hasMore.value || confirmed.length > 500,
    });
  }

  function saveMessageCache() {
    if (!cache || cacheWriteTimer) return;
    cacheWriteRevision = cache.revision;
    // 连续消息合并落盘，切群时再补最后一份快照。
    cacheWriteTimer = setTimeout(() => { cacheWriteTimer = null; writeMessageCache(); }, 1_000);
  }

  async function refresh(wait = false) {
    const cacheRevision = cache?.revision;
    pollRequest?.abort();
    const controller = new AbortController();
    pollRequest = controller;
    refreshing.value = true;
    const groupId = getGroupId();
    const initial = !initialLoaded.value;
    try {
      let restoredIds: Set<string> | null = null;
      if (!cacheLoaded) {
        cacheLoaded = true;
        const cached = cache ? await cache.read<{ messages: ChatMessage[]; hasMore: boolean }>('messages', groupId) : null;
        if (controller.signal.aborted || disposed || pollRequest !== controller) return null;
        if (cached && Array.isArray(cached.messages) && cached.messages.length <= 500
            && cached.messages.every(message => message && typeof message.id === 'string' && typeof message.content === 'string'
              && typeof message.senderUserId === 'string' && typeof message.senderNickname === 'string'
              && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)))) {
          const cachedIds = new Set(cached.messages.map(message => message.id));
          restoredIds = cachedIds.size ? cachedIds : null;
          messages.value = [...cached.messages, ...messages.value.filter(message => !cachedIds.has(message.id))];
          hasMore.value = Boolean(cached.hasMore);
          latestFetchedMessageId = cached.messages.at(-1)?.id;
          initialLoaded.value = true;
          void scrollToBottom('auto', true);
        } else if (cached) { void cache?.discard('messages', groupId); }
      }
      // 只有查询结果能推进轮询游标；本机发送成功不代表游标之前的其他消息已经读完。
      let latestId = latestFetchedMessageId;
      let page = await findMessages(groupId, latestId ? { afterMessageId: latestId } : undefined, controller.signal, wait);
      if (controller.signal.aborted || disposed || pollRequest !== controller || getGroupId() !== groupId) return null;
      if (restoredIds && page.messages.length >= 30) {
        // 缓存落后较多时回到最近一页，避免启动后连续追赶大量旧消息，也不拼出缺口历史。
        page = await findMessages(groupId, undefined, controller.signal);
        if (controller.signal.aborted || disposed || pollRequest !== controller) return null;
        messages.value = messages.value.filter(message => !restoredIds.has(message.id));
        latestId = undefined;
      }
      pollError.value = '';
      if (!latestId) {
        hasMore.value = page.hasMore;
        initialLoaded.value = true;
      }
      // 历史或轮询可能晚于本机发送返回；游标之后先按服务端顺序合并，再补上快照之后发出的消息。
      const currentIds = new Set(messages.value.map((message) => message.id));
      const snapshotIds = new Set(page.messages.map((message) => message.id));
      const prefixEnd = latestId ? messages.value.findIndex((message) => message.id === latestId) + 1 : 0;
      const prefix = messages.value.slice(0, prefixEnd);
      const known = new Set(prefix.map((message) => message.id));
      // 游标之前的重复响应不能再次插入，游标之后仍按快照顺序纠正本机消息的位置。
      const orderedPage = page.messages.filter((message) => {
        if (known.has(message.id)) return false;
        known.add(message.id);
        return true;
      });
      const newMessages = orderedPage.filter((message) => !currentIds.has(message.id));
      const added = newMessages.length;
      messages.value = [...prefix, ...orderedPage,
        ...messages.value.slice(prefixEnd).filter((message) => !snapshotIds.has(message.id))];
      latestFetchedMessageId = page.messages.at(-1)?.id ?? latestId;
      if ((added || initial) && cache?.revision === cacheRevision) saveMessageCache();
      if (!initial) {
        unreadMessageIds.value.push(...newMessages.filter(message => message.senderUserId !== getUserId())
          .map(message => message.id));
      }
      if (added && (initial || atBottom.value || followingScroll.value)) void scrollToBottom(initial ? 'auto' : 'smooth', initial);
      else if (added) {
        await nextTick();
        if (!disposed) updateReadMessages();
      }
      return added;
    } catch (reason) {
      if (controller.signal.aborted || disposed || pollRequest !== controller) return null;
      pollError.value = reason instanceof Error ? reason.message : '无法读取群聊消息';
      if (reason instanceof ApiRequestError && [400, 403, 404].includes(reason.status)) {
        // 游标或群访问已失效，未完成的历史请求也不能重新填回旧消息。
        historyRequest?.abort();
        historyRequest = null;
        loadingOlder.value = false;
        hasMore.value = false;
        historyError.value = '';
        scroll.resetReadingPosition();
        messages.value = [];
        latestFetchedMessageId = undefined;
        initialLoaded.value = false;
        if (reason.status !== 400) await cache?.revokeGroup(groupId);
      }
      return 0;
    } finally {
      if (pollRequest === controller) {
        pollRequest = null;
        refreshing.value = false;
        if (!initialLoadNotified && !disposed && !controller.signal.aborted) {
          initialLoadNotified = true;
          onInitialLoad(groupId);
        }
      }
    }
  }

  async function loadOlder() {
    const cacheRevision = cache?.revision;
    const cursor = messages.value[0]?.id;
    if (!list.value || !cursor || !initialLoaded.value || !hasMore.value || loadingOlder.value || disposed) return;
    const controller = new AbortController();
    historyRequest = controller;
    loadingOlder.value = true;
    historyError.value = '';
    atBottom.value = false;
    const groupId = getGroupId();
    try {
      const page = await findMessages(groupId, { beforeMessageId: cursor }, controller.signal);
      if (controller.signal.aborted || disposed || historyRequest !== controller || getGroupId() !== groupId) return;
      const known = new Set(messages.value.map((message) => message.id));
      const older = page.messages.filter((message) => {
        if (known.has(message.id)) return false;
        known.add(message.id);
        return true;
      });
      hasMore.value = page.hasMore && older.length > 0;
      if (!older.length) return;
      const restorePosition = scroll.preserveHistoryPosition();
      messages.value = [...older, ...messages.value];
      if (cache?.revision === cacheRevision) saveMessageCache();
      await nextTick();
      if (controller.signal.aborted || disposed) return;
      restorePosition();
    } catch (reason) {
      if (!controller.signal.aborted && !disposed && historyRequest === controller) {
        historyError.value = reason instanceof Error ? reason.message : '无法读取更早消息';
      }
    } finally {
      if (historyRequest === controller) {
        historyRequest = null;
        loadingOlder.value = false;
        scroll.finishHistoryLoad();
      }
    }
  }

  function clearRefreshTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleRefresh() {
    clearRefreshTimer();
    if (disposed || document.visibilityState === 'hidden') return;
    timer = setTimeout(() => void pollMessages(), messagePollDelay(consecutiveEmptyPolls));
  }

  async function pollMessages() {
    clearRefreshTimer();
    const initial = !initialLoadNotified;
    const startedAt = Date.now();
    const added = await refresh(!initial);
    if (added === null || disposed || document.visibilityState === 'hidden') return;
    consecutiveEmptyPolls = pollError.value ? consecutiveEmptyPolls + 1 : 0;
    // 正常空响应已在服务器等待；异常提前返回时限速，避免代理或旧服务造成空转。
    if (pollError.value || (!initial && added === 0 && Date.now() - startedAt < 1_000)) scheduleRefresh();
    else timer = setTimeout(() => void pollMessages(), 0);
  }

  function retryRefresh() {
    if (refreshing.value || disposed) return;
    consecutiveEmptyPolls = 0;
    return pollMessages();
  }

  function refreshOnActivation() {
    if (document.visibilityState === 'hidden') return;
    if (pollRequest && !pollRequest.signal.aborted) return;
    if (Date.now() - lastActivationRefreshAt < 500) return;
    lastActivationRefreshAt = Date.now();
    consecutiveEmptyPolls = 0;
    void pollMessages();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      clearRefreshTimer();
      pollRequest?.abort();
      historyRequest?.abort();
      historyRequest = null;
      loadingOlder.value = false;
      scroll.finishHistoryLoad();
      return;
    }
    refreshOnActivation();
  }

  function refreshAfterSend() {
    consecutiveEmptyPolls = 0;
    scheduleRefresh();
  }

  onScopeDispose(() => {
    disposed = true;
    if (cacheWriteTimer) {
      clearTimeout(cacheWriteTimer);
      cacheWriteTimer = null;
      writeMessageCache();
    }
    pollRequest?.abort();
    historyRequest?.abort();
    historyRequest = null;
    clearRefreshTimer();
  });

  return { messages, pollError, historyError, initialLoaded, refreshing, loadingOlder, hasMore,
    refresh, loadOlder, appendMessages, pollMessages, retryRefresh, refreshAfterSend, refreshOnActivation, handleVisibilityChange };
}

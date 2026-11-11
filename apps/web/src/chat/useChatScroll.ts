import { computed, nextTick, onScopeDispose, ref } from 'vue';

export function useChatScroll(loadOlder: () => void) {
  const atBottom = ref(true);
  const followingScroll = ref(false);
  const unreadMessageIds = ref<string[]>([]);
  const unseenMessages = computed(() => unreadMessageIds.value.length);
  const returningToLatest = ref(false);
  const moreThanScreenAway = ref(false);
  const list = ref<HTMLElement | null>(null);
  const HISTORY_TOP_THRESHOLD = 80;
  const RETURN_SCROLL_THRESHOLD = 48;
  let lastScrollTop = 0;
  let downwardScrollDistance = 0;
  let jumpingToUnread = false;
  let layoutObserver: ResizeObserver | undefined;
  let previousListHeight: number | undefined;
  let previousTopPadding = 0;
  let layoutScrollRemainder = 0;
  let disposed = false;
  let scrollPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

  const showMessageJump = computed(() => !followingScroll.value && (unseenMessages.value > 0
    || (!atBottom.value && returningToLatest.value && moreThanScreenAway.value)));
  const messageJumpLabel = computed(() => unseenMessages.value
    ? `${unseenMessages.value} 条新消息 · 跳转到未读` : '回到最新');
  function isAtBottom() {
    const element = list.value;
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  }

  async function scrollToBottom(behavior: ScrollBehavior = 'smooth', force = false) {
    await nextTick();
    if (disposed || (!force && !atBottom.value && !followingScroll.value)) return;
    const element = list.value;
    if (!element) return;
    const reduce = scrollPreference?.matches;
    jumpingToUnread = false;
    downwardScrollDistance = 0;
    returningToLatest.value = false;
    followingScroll.value = !reduce && behavior === 'smooth'
      && element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : behavior });
    // 发起滚动不代表已读到最新；中途停止时必须保留尚未看到的计数。
    atBottom.value = isAtBottom();
    if (atBottom.value) unreadMessageIds.value = [];
    lastScrollTop = element.scrollTop;
  }

  function updateReadMessages() {
    const element = list.value;
    if (!element || followingScroll.value || jumpingToUnread || document.visibilityState === 'hidden'
        || !unreadMessageIds.value.length) return;
    if (isAtBottom()) { unreadMessageIds.value = []; return; }
    const bounds = visibleMessageBounds(element);
    const unread = new Set(unreadMessageIds.value);
    for (const message of element.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = message.dataset.messageId!;
      if (!unread.has(id)) continue;
      const rect = message.getBoundingClientRect();
      if (rect.top < bounds.bottom && rect.bottom > bounds.top) unread.delete(id);
    }
    unreadMessageIds.value = unreadMessageIds.value.filter(id => unread.has(id));
  }

  function visibleMessageBounds(element: HTMLElement) {
    const bounds = element.getBoundingClientRect();
    const overlay = element.parentElement?.closest('.group-main')?.querySelector<HTMLElement>('.voice-panel');
    const top = Math.max(bounds.top, overlay?.getBoundingClientRect().bottom ?? bounds.top);
    return { top: Math.min(top, bounds.bottom), bottom: bounds.bottom };
  }

  function syncChatLayout() {
    const element = list.value;
    if (disposed || !element || !layoutObserver) return false;
    const conversation = element.closest('.group-conversation');
    const owner = element.ownerDocument.defaultView!;
    const offset = conversation ? element.getBoundingClientRect().top - conversation.getBoundingClientRect().top : 0;
    element.style.setProperty('--chat-list-offset', `${offset}px`);
    const padding = Number.parseFloat(owner.getComputedStyle(element).paddingTop);
    const height = element.clientHeight;
    const previousHeight = previousListHeight;
    const paddingDelta = padding - previousTopPadding;
    previousListHeight = height;
    previousTopPadding = padding;
    if (previousHeight === undefined) { lastScrollTop = element.scrollTop; return false; }
    if (height === previousHeight && Math.abs(paddingDelta) < 0.01) return false;
    // 输入框收起与新消息滚动可同时进行，不能用位置补偿打断正在跟随最新消息的滚动。
    if (followingScroll.value) {
      void scrollToBottom('smooth', true);
      return true;
    }
    // 顶部留白只增加可滚动范围；底部控制栏改变高度时，消息与输入框一起移动。
    const target = atBottom.value ? element.scrollHeight - height : Math.max(0,
      Math.min(element.scrollHeight - height, lastScrollTop + layoutScrollRemainder + paddingDelta + previousHeight - height));
    element.scrollTop = target;
    // 滚动位置可能按整像素取整，保留余量，避免连续动画逐帧累积偏移。
    layoutScrollRemainder = target - element.scrollTop;
    lastScrollTop = element.scrollTop;
    atBottom.value = isAtBottom();
    const bounds = visibleMessageBounds(element);
    moreThanScreenAway.value = element.scrollHeight - element.scrollTop - height > bounds.bottom - bounds.top;
    updateReadMessages();
    return true;
  }

  async function jumpToMessages() {
    const firstUnread = unreadMessageIds.value[0];
    if (!firstUnread) { await scrollToBottom('smooth', true); return; }
    await nextTick();
    const element = list.value;
    if (disposed || !element) return;
    const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(message => message.dataset.messageId === firstUnread);
    if (!target) return;
    // 仅滚动消息容器，不能让整个页面或语音覆盖区一起移动。
    const top = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
      element.scrollTop + target.getBoundingClientRect().top - visibleMessageBounds(element).top));
    followingScroll.value = false;
    downwardScrollDistance = 0;
    returningToLatest.value = false;
    jumpingToUnread = !scrollPreference?.matches && Math.abs(top - element.scrollTop) > 1;
    element.scrollTo({ top, behavior: scrollPreference?.matches ? 'auto' : 'smooth' });
    atBottom.value = isAtBottom();
    lastScrollTop = element.scrollTop;
    if (!jumpingToUnread) updateReadMessages();
  }

  function onScroll() {
    const element = list.value;
    if (!element) return;
    if (syncChatLayout()) return;
    const scrollDelta = element.scrollTop - lastScrollTop;
    if (scrollDelta !== 0) layoutScrollRemainder = 0;
    const movingUp = scrollDelta < -1;
    lastScrollTop = element.scrollTop;
    // 自动跟随期间不把中途的位置当作主动翻历史，避免“回到最新”短暂闪现。
    if (followingScroll.value || jumpingToUnread) return;
    // 同方向累计一小段距离再展示，忽略触控板细小回弹；未读入口不受此门槛影响。
    if (movingUp) downwardScrollDistance = 0;
    else if (scrollDelta > 0) downwardScrollDistance += scrollDelta;
    returningToLatest.value = downwardScrollDistance >= RETURN_SCROLL_THRESHOLD;
    const bounds = visibleMessageBounds(element);
    moreThanScreenAway.value = element.scrollHeight - element.scrollTop - element.clientHeight > bounds.bottom - bounds.top;
    atBottom.value = isAtBottom();
    updateReadMessages();
    if (movingUp && element.scrollTop <= HISTORY_TOP_THRESHOLD) loadOlder();
  }

  function onScrollEnd() {
    syncChatLayout();
    const element = list.value;
    if (followingScroll.value && element && element.scrollHeight - element.clientHeight - element.scrollTop > 1) {
      void scrollToBottom('smooth', true);
      return;
    }
    followingScroll.value = false;
    jumpingToUnread = false;
    atBottom.value = isAtBottom();
    updateReadMessages();
  }

  function stopAnimatedScroll() {
    const element = list.value;
    if (!scrollPreference?.matches || !element) return;
    followingScroll.value = false;
    jumpingToUnread = false;
    element.scrollTo({ top: element.scrollTop, behavior: 'auto' });
    onScrollEnd();
  }

  function onWheel(event: WheelEvent) {
    if (jumpingToUnread || event.deltaY < 0) cancelScrollFollow();
    if (event.deltaY < 0 && list.value && list.value.scrollTop <= HISTORY_TOP_THRESHOLD) loadOlder();
  }

  function cancelScrollFollow() {
    followingScroll.value = false;
    jumpingToUnread = false;
  }

  function preserveHistoryPosition() {
    const element = list.value;
    if (!element) return () => {};
    // 日期分割线会随历史插入变化，优先保持当前可见消息的位置。
    const bounds = visibleMessageBounds(element);
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(message => message.getBoundingClientRect().bottom > bounds.top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    return () => {
      if (disposed || list.value !== element) return;
      if (anchor && anchorTop !== undefined) element.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      else element.scrollTop = previousTop + element.scrollHeight - previousHeight;
      lastScrollTop = element.scrollTop;
    };
  }

  function finishHistoryLoad() { atBottom.value = isAtBottom(); }

  function resetReadingPosition() {
    cancelScrollFollow();
    unreadMessageIds.value = [];
    downwardScrollDistance = 0;
    returningToLatest.value = false;
    moreThanScreenAway.value = false;
    atBottom.value = true;
  }

  function start() {
    layoutObserver = new list.value!.ownerDocument.defaultView!.ResizeObserver(syncChatLayout);
    syncChatLayout();
    layoutObserver.observe(list.value!);
    scrollPreference = list.value!.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)');
    scrollPreference.addEventListener('change', stopAnimatedScroll);
  }

  onScopeDispose(() => {
    disposed = true;
    layoutObserver?.disconnect();
    scrollPreference.removeEventListener('change', stopAnimatedScroll);
  });

  return { list, atBottom, followingScroll, unreadMessageIds, unseenMessages, showMessageJump, messageJumpLabel,
    scrollToBottom, updateReadMessages, jumpToMessages, onScroll, onScrollEnd, onWheel, cancelScrollFollow,
    stopAnimatedScroll, preserveHistoryPosition, finishHistoryLoad, resetReadingPosition, start };
}

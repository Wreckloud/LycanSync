<script setup lang="ts">
import '../chat/chat.css';
import { computed, inject, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { ApiRequestError } from '../auth/authApi';
import { ArrowDown, MessageSquareText, Plus, Send, X } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import { findMessages, sendFile, sendMessage, type ChatMessage } from '../chat/chatApi';
import { messagePollDelay } from '../chat/messagePolling';
import { compressChatImage } from '../chat/messageImage';
import { formatFullMessageTime, formatMessageDate, formatMessageTime, localDateKey } from '../chat/messageTime';
import type { GroupMember, GroupSummary } from '../group/groupApi';
import ChatImage from './ChatImage.vue';
import ChatFileCard from './ChatFileCard.vue';

type MessageSegment = { text: string; href?: string };
type PendingAttachment = {
  id: string;
  kind: 'IMAGE' | 'FILE';
  file: File;
  previewUrl: string;
  state: 'pending' | 'uploading' | 'failed' | 'sent';
  progress: number;
  error: string;
};

const props = defineProps<{ group: GroupSummary; members: GroupMember[]; user: AuthUser }>();
const emit = defineEmits<{ initialLoad: [groupId: string] }>();
const cache = inject(ACCOUNT_CACHE, null);
let cacheLoaded = false;
let initialLoadNotified = false;
let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
const messages = ref<ChatMessage[]>([]);
const text = ref('');
const pendingAttachments = ref<PendingAttachment[]>([]);
const busy = ref(false);
const preparing = ref(false);
const error = ref('');
const pollError = ref('');
const historyError = ref('');
const initialLoaded = ref(false);
const refreshing = ref(false);
const loadingOlder = ref(false);
const hasMore = ref(false);
const atBottom = ref(true);
const followingScroll = ref(false);
const unreadMessageIds = ref<string[]>([]);
const unseenMessages = computed(() => unreadMessageIds.value.length);
const returningToLatest = ref(false);
const moreThanScreenAway = ref(false);
const calendarNow = ref(new Date());
const list = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const MESSAGE_GROUP_MAX_GAP_MS = 5 * 60_000;
const HISTORY_TOP_THRESHOLD = 80;
let pollRequest: AbortController | null = null;
let historyRequest: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let calendarTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let latestFetchedMessageId: string | undefined;
let consecutiveEmptyPolls = 0;
let lastActivationRefreshAt = 0;
let lastScrollTop = 0;
let jumpingToUnread = false;
let scrollPreference: MediaQueryList | undefined;

const members = computed(() => new Map(props.members.map((member) => [member.userId, member])));
const showMessageJump = computed(() => !followingScroll.value && (unseenMessages.value > 0
  || (!atBottom.value && returningToLatest.value && moreThanScreenAway.value)));
const messageJumpLabel = computed(() => unseenMessages.value
  ? `${unseenMessages.value} 条新消息 · 跳转到未读` : '回到最新消息');
const canSend = computed(() => !busy.value && !preparing.value
  && (text.value.trim().length > 0 || pendingAttachments.value.some((item) => item.state !== 'sent')));
let activeUpload: AbortController | null = null;
let preparationGeneration = 0;
let sendGeneration = 0;

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
  jumpingToUnread = !scrollPreference?.matches && Math.abs(top - element.scrollTop) > 1;
  element.scrollTo({ top, behavior: scrollPreference?.matches ? 'auto' : 'smooth' });
  atBottom.value = isAtBottom();
  lastScrollTop = element.scrollTop;
  if (!jumpingToUnread) updateReadMessages();
}

// 短会话尚未产生滚动条时，补上新消息把旧消息向上推开的过渡。
function captureMessagePositions() {
  const element = list.value;
  if (!element?.isConnected || !atBottom.value || scrollPreference?.matches
      || element.scrollHeight > element.clientHeight) return [];
  return [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
    .map(message => ({ message, top: message.getBoundingClientRect().top }));
}
const messageAnimations = new Set<Animation>();
async function animateMessagePositions(positions: ReturnType<typeof captureMessagePositions>) {
  if (!positions.length) return;
  await nextTick();
  if (disposed || scrollPreference?.matches) return;
  for (const { message, top } of positions) {
    if (!message.isConnected) continue;
    const offset = top - message.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    const animation = message.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
      { duration: 180, easing: 'ease-out' });
    messageAnimations.add(animation);
    animation.onfinish = animation.oncancel = () => { messageAnimations.delete(animation); };
  }
}

function appendMessages(incoming: ChatMessage[], forceScroll = false, behavior: ScrollBehavior = 'smooth') {
  const known = new Set(messages.value.map((message) => message.id));
  const added = incoming.filter((message) => {
    if (known.has(message.id)) return false;
    known.add(message.id);
    return true;
  });
  if (!added.length) return 0;
  const positions = captureMessagePositions();
  messages.value = [...messages.value, ...added];
  void animateMessagePositions(positions);
  if (forceScroll || atBottom.value || followingScroll.value) void scrollToBottom(behavior, forceScroll);
  return added.length;
}

function writeMessageCache() {
  const confirmedEnd = latestFetchedMessageId ? messages.value.findIndex(message => message.id === latestFetchedMessageId) + 1 : 0;
  if (!confirmedEnd) return;
  const confirmed = messages.value.slice(0, confirmedEnd);
  void cache?.write('messages', props.group.id, {
    messages: confirmed.slice(-500), hasMore: hasMore.value || confirmed.length > 500,
  });
}

function saveMessageCache() {
  if (!cache || cacheWriteTimer) return;
  // 连续消息合并落盘，切群时再补最后一份快照。
  cacheWriteTimer = setTimeout(() => { cacheWriteTimer = null; writeMessageCache(); }, 1_000);
}

async function refresh(wait = false) {
  pollRequest?.abort();
  const controller = new AbortController();
  pollRequest = controller;
  refreshing.value = true;
  const groupId = props.group.id;
  const initial = !initialLoaded.value;
  try {
    let restoredIds: Set<string> | null = null;
    if (!cacheLoaded) {
      cacheLoaded = true;
      const cached = cache ? await cache.read<{ messages: ChatMessage[]; hasMore: boolean }>('messages', groupId) : null;
      if (controller.signal.aborted || disposed || pollRequest !== controller) return null;
      if (cached && Array.isArray(cached.messages) && cached.messages.length && cached.messages.length <= 500
          && cached.messages.every(message => typeof message.id === 'string' && typeof message.content === 'string')) {
        const cachedIds = new Set(cached.messages.map(message => message.id));
        restoredIds = cachedIds;
        messages.value = [...cached.messages, ...messages.value.filter(message => !cachedIds.has(message.id))];
        hasMore.value = Boolean(cached.hasMore);
        latestFetchedMessageId = cached.messages.at(-1)?.id;
        initialLoaded.value = true;
        void scrollToBottom('auto', true);
      }
    }
    // 只有查询结果能推进轮询游标；本机发送成功不代表游标之前的其他消息已经读完。
    let latestId = latestFetchedMessageId;
    let page = await findMessages(groupId, latestId ? { afterMessageId: latestId } : undefined, controller.signal, wait);
    if (controller.signal.aborted || disposed || pollRequest !== controller || props.group.id !== groupId) return null;
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
    const positions = added && !initial ? captureMessagePositions() : [];
    messages.value = [...prefix, ...orderedPage,
      ...messages.value.slice(prefixEnd).filter((message) => !snapshotIds.has(message.id))];
    void animateMessagePositions(positions);
    latestFetchedMessageId = page.messages.at(-1)?.id ?? latestId;
    if (added || initial) saveMessageCache();
    if (!initial) {
      unreadMessageIds.value.push(...newMessages.filter(message => message.senderUserId !== props.user.id)
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
        emit('initialLoad', groupId);
      }
    }
  }
}

async function loadOlder() {
  const element = list.value;
  const cursor = messages.value[0]?.id;
  if (!element || !cursor || !initialLoaded.value || !hasMore.value || loadingOlder.value || disposed) return;
  const controller = new AbortController();
  historyRequest = controller;
  loadingOlder.value = true;
  historyError.value = '';
  atBottom.value = false;
  const groupId = props.group.id;
  try {
    const page = await findMessages(groupId, { beforeMessageId: cursor }, controller.signal);
    if (controller.signal.aborted || disposed || historyRequest !== controller || props.group.id !== groupId) return;
    const known = new Set(messages.value.map((message) => message.id));
    const older = page.messages.filter((message) => {
      if (known.has(message.id)) return false;
      known.add(message.id);
      return true;
    });
    hasMore.value = page.hasMore && older.length > 0;
    if (!older.length) return;
    // 日期分割线可能因插入旧消息而变化，锚定当前可见消息比只计算列表高度更稳定。
    const listBounds = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((message) => message.getBoundingClientRect().bottom > listBounds.top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    messages.value = [...older, ...messages.value];
    saveMessageCache();
    await nextTick();
    if (controller.signal.aborted || disposed || list.value !== element) return;
    if (anchor && anchorTop !== undefined) {
      element.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    } else {
      element.scrollTop = previousTop + element.scrollHeight - previousHeight;
    }
    lastScrollTop = element.scrollTop;
  } catch (reason) {
    if (!controller.signal.aborted && !disposed && historyRequest === controller) {
      historyError.value = reason instanceof Error ? reason.message : '无法读取更早消息';
    }
  } finally {
    if (historyRequest === controller) {
      historyRequest = null;
      loadingOlder.value = false;
      atBottom.value = isAtBottom();
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
  refreshCalendar();
  if (pollRequest && !pollRequest.signal.aborted) return;
  if (Date.now() - lastActivationRefreshAt < 500) return;
  lastActivationRefreshAt = Date.now();
  consecutiveEmptyPolls = 0;
  void pollMessages();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    clearRefreshTimer();
    if (calendarTimer) clearTimeout(calendarTimer);
    calendarTimer = null;
    pollRequest?.abort();
    historyRequest?.abort();
    historyRequest = null;
    loadingOlder.value = false;
    atBottom.value = isAtBottom();
    return;
  }
  refreshOnActivation();
}

function revokePreview(item: PendingAttachment) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

function clearPendingAttachments() {
  for (const item of pendingAttachments.value) revokePreview(item);
  pendingAttachments.value = [];
}

function removePendingAttachment(id: string) {
  const item = pendingAttachments.value.find((attachment) => attachment.id === id);
  if (!item) return;
  if (item.state === 'uploading') activeUpload?.abort();
  revokePreview(item);
  pendingAttachments.value = pendingAttachments.value.filter((attachment) => attachment.id !== id);
}

async function enqueueFiles(files: File[], compressSupportedImages: boolean) {
  if (busy.value || preparing.value || !files.length) return;
  error.value = '';
  if (!compressSupportedImages) {
    pendingAttachments.value.push(...files.map((file) => ({ id: crypto.randomUUID(), kind: 'FILE' as const,
      file, previewUrl: '', state: 'pending' as const, progress: 0, error: '' })));
    return;
  }
  const generation = ++preparationGeneration;
  preparing.value = true;
  const preparedItems: PendingAttachment[] = [];
  try {
    for (const file of files) {
      const imageType = file.type === 'image/png' || file.type === 'image/jpeg';
      const prepared = imageType ? await compressChatImage(file) : file;
      preparedItems.push({ id: crypto.randomUUID(), kind: imageType ? 'IMAGE' : 'FILE', file: prepared,
        previewUrl: imageType ? URL.createObjectURL(prepared) : '', state: 'pending', progress: 0, error: '' });
      if (generation !== preparationGeneration || disposed) {
        for (const item of preparedItems) revokePreview(item);
        return;
      }
    }
    pendingAttachments.value.push(...preparedItems);
  } catch (reason) {
    for (const item of preparedItems) revokePreview(item);
    error.value = reason instanceof Error ? reason.message : '图片处理失败';
  } finally {
    if (generation === preparationGeneration) preparing.value = false;
  }
}

function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...input.files ?? []];
  input.value = '';
  void enqueueFiles(files, false);
}

function handlePaste(event: ClipboardEvent) {
  const files = [...event.clipboardData?.files ?? []];
  if (files.length) {
    event.preventDefault();
    void enqueueFiles(files, true);
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const files = [...event.dataTransfer?.files ?? []];
  if (files.length) void enqueueFiles(files, true);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

function resizeMessageInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  element.style.height = '42px';
  element.style.height = `${Math.min(element.scrollHeight, 122)}px`;
}

async function submit() {
  if (!canSend.value) return;
  const generation = ++sendGeneration;
  busy.value = true;
  error.value = '';
  try {
    const groupId = props.group.id;
    const queued = pendingAttachments.value.filter((item) => item.state !== 'sent');
    if (!queued.length) {
      const controller = new AbortController();
      activeUpload = controller;
      const message = await sendMessage(groupId, text.value, undefined, controller.signal);
      if (disposed || generation !== sendGeneration || props.group.id !== groupId) return;
      activeUpload = null;
      text.value = '';
      appendMessages([message], true);
    } else {
      let content = text.value;
      for (const item of queued) {
        if (!pendingAttachments.value.some((attachment) => attachment.id === item.id)) continue;
        const controller = new AbortController();
        activeUpload = controller;
        item.state = 'uploading';
        item.error = '';
        item.progress = 0;
        try {
          const message = item.kind === 'IMAGE'
            ? await sendMessage(groupId, content, item.file, controller.signal, item.id)
            : await sendFile(groupId, item.file, content, item.id, controller.signal,
              (loaded) => { item.progress = loaded; });
          if (disposed || generation !== sendGeneration || props.group.id !== groupId || controller.signal.aborted) return;
          item.state = 'sent';
          revokePreview(item);
          item.previewUrl = '';
          appendMessages([message], true);
          content = '';
          text.value = '';
        } catch (reason) {
          if (disposed || generation !== sendGeneration || props.group.id !== groupId) return;
          item.state = controller.signal.aborted ? 'pending' : 'failed';
          item.error = controller.signal.aborted ? '已取消，可继续发送' : reason instanceof Error ? reason.message : '文件发送失败';
          break;
        } finally {
          if (activeUpload === controller) activeUpload = null;
        }
      }
      if (pendingAttachments.value.length && pendingAttachments.value.every((item) => item.state === 'sent')) {
        clearPendingAttachments();
      }
    }
    if (messageInput.value) messageInput.value.style.height = '42px';
    consecutiveEmptyPolls = 0;
    scheduleRefresh();
  } catch (reason) {
    if (!disposed && generation === sendGeneration) error.value = reason instanceof Error ? reason.message : '消息发送失败';
  } finally {
    if (generation === sendGeneration) {
      activeUpload = null;
      busy.value = false;
    }
  }
}

function cancelUpload() {
  activeUpload?.abort();
}

function senderName(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.nickname : message.senderNickname;
}

function senderAvatar(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.avatar : members.value.get(message.senderUserId)?.avatar ?? '';
}

function refreshCalendar() {
  if (calendarTimer) clearTimeout(calendarTimer);
  calendarTimer = null;
  calendarNow.value = new Date();
  if (disposed || document.visibilityState === 'hidden') return;
  const now = calendarNow.value;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  calendarTimer = setTimeout(refreshCalendar, midnight.getTime() - now.getTime() + 100);
}

function startsNewDate(message: ChatMessage, index: number) {
  return index === 0 || localDateKey(messages.value[index - 1].createdAt) !== localDateKey(message.createdAt);
}

function startsNewMessageGroup(message: ChatMessage, index: number) {
  if (startsNewDate(message, index)) return true;
  const previous = messages.value[index - 1];
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return previous.senderUserId !== message.senderUserId || gap < 0 || gap > MESSAGE_GROUP_MAX_GAP_MS;
}

function messageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  let position = 0;
  for (const match of content.matchAll(pattern)) {
    const rawUrl = match[0].replace(/[，。！？；：、,.!?;:]+$/u, '');
    const url = safeHttpUrl(rawUrl);
    if (!url || match.index === undefined) continue;
    if (match.index > position) segments.push({ text: content.slice(position, match.index) });
    segments.push({ text: rawUrl, href: url });
    const trailingText = match[0].slice(rawUrl.length);
    if (trailingText) segments.push({ text: trailingText });
    position = match.index + match[0].length;
  }
  if (position < content.length) segments.push({ text: content.slice(position) });
  return segments;
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function openLink(url: string) {
  if (window.lycanDesktop) {
    void window.lycanDesktop.openExternal(url).catch(() => { error.value = '无法打开默认浏览器。'; });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function onScroll() {
  const element = list.value;
  if (!element) return;
  const movingUp = element.scrollTop < lastScrollTop - 1;
  const movingDown = element.scrollTop > lastScrollTop + 1;
  lastScrollTop = element.scrollTop;
  // 自动跟随期间不把中途的位置当作主动翻历史，避免“回到最新”短暂闪现。
  if (followingScroll.value || jumpingToUnread) return;
  if (movingUp || movingDown) returningToLatest.value = movingDown;
  const bounds = visibleMessageBounds(element);
  moreThanScreenAway.value = element.scrollHeight - element.scrollTop - element.clientHeight > bounds.bottom - bounds.top;
  atBottom.value = isAtBottom();
  updateReadMessages();
  if (movingUp && element.scrollTop <= HISTORY_TOP_THRESHOLD) void loadOlder();
}

function onScrollEnd() {
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
  for (const animation of messageAnimations) animation.cancel();
  element.scrollTo({ top: element.scrollTop, behavior: 'auto' });
  onScrollEnd();
}

function onWheel(event: WheelEvent) {
  if (jumpingToUnread || event.deltaY < 0) cancelScrollFollow();
  if (event.deltaY < 0 && list.value && list.value.scrollTop <= HISTORY_TOP_THRESHOLD) void loadOlder();
}

function cancelScrollFollow() {
  followingScroll.value = false;
  jumpingToUnread = false;
}

onMounted(() => {
  scrollPreference = list.value!.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)');
  scrollPreference.addEventListener('change', stopAnimatedScroll);
  refreshCalendar();
  void pollMessages();
  window.addEventListener('focus', refreshOnActivation);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onScopeDispose(() => {
  // App 按群 ID 创建独立实例；切群统一在销毁处取消，观看布局不重建群聊。
  disposed = true;
  if (cacheWriteTimer) {
    clearTimeout(cacheWriteTimer);
    cacheWriteTimer = null;
    writeMessageCache();
  }
  for (const animation of messageAnimations) animation.cancel();
  pollRequest?.abort();
  historyRequest?.abort();
  historyRequest = null;
  clearRefreshTimer();
  if (calendarTimer) clearTimeout(calendarTimer);
  scrollPreference?.removeEventListener('change', stopAnimatedScroll);
  window.removeEventListener('focus', refreshOnActivation);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  activeUpload?.abort();
  sendGeneration++;
  preparationGeneration++;
  clearPendingAttachments();
});
</script>

<template>
  <section class="chat-panel" :aria-label="`${group.name}群聊`" @dragover.prevent @drop="handleDrop">
    <div class="chat-heading">
      <span class="chat-title"><MessageSquareText :size="15" /><span>群聊</span></span>
      <div v-if="initialLoaded && pollError" class="chat-sync-status" role="status" :aria-busy="refreshing">
        <span>{{ pollError }}</span><button type="button" class="chat-retry" :disabled="refreshing" @click="retryRefresh">{{ refreshing ? '重试中…' : '重试' }}</button>
      </div>
    </div>
    <div class="chat-timeline" :class="{ 'has-composer-feedback': Boolean(error) }">
      <div ref="list" class="message-list" @scroll="onScroll" @scrollend="onScrollEnd" @wheel="onWheel" @pointerdown="cancelScrollFollow">
        <div v-if="!initialLoaded" class="chat-initial-state" :class="{ 'is-empty': !messages.length }">
          <template v-if="pollError">
            <p class="chat-read-error" role="alert">{{ pollError }}</p>
            <button type="button" class="chat-retry" :disabled="refreshing" @click="retryRefresh">{{ refreshing ? '正在重试…' : '重新读取消息' }}</button>
          </template>
          <p v-else role="status">正在读取消息…</p>
        </div>
        <p v-else-if="!messages.length" class="chat-initial-state is-empty" role="status">还没有消息</p>
        <div v-if="initialLoaded && messages.length && (hasMore || loadingOlder || historyError)" class="chat-history-state" :aria-busy="loadingOlder">
          <span v-if="loadingOlder" role="status">正在读取更早消息…</span>
          <template v-else-if="historyError">
            <span class="chat-history-error" role="alert">{{ historyError }}</span>
            <button type="button" class="chat-retry" @click="loadOlder">重试</button>
          </template>
          <button v-else type="button" class="chat-retry" @click="loadOlder">查看更早消息</button>
        </div>
        <template v-for="(message, index) in messages" :key="message.id">
          <div v-if="startsNewDate(message, index)" class="chat-date-divider"><time :datetime="message.createdAt" :title="formatFullMessageTime(message.createdAt)">{{ formatMessageDate(message.createdAt, calendarNow) }}</time></div>
          <article class="chat-message" :data-message-id="message.id" :class="{ 'is-own': message.senderUserId === user.id, 'is-grouped': !startsNewMessageGroup(message, index) }">
            <template v-if="startsNewMessageGroup(message, index)">
              <img v-if="senderAvatar(message)" class="chat-message-avatar" :src="senderAvatar(message)" alt="" />
              <span v-else class="chat-message-avatar chat-message-initial">{{ senderName(message).slice(0, 1) }}</span>
            </template>
            <span v-else class="chat-message-avatar-placeholder" aria-hidden="true" />
            <div class="chat-message-body">
              <div v-if="startsNewMessageGroup(message, index)" class="chat-message-meta"><strong>{{ senderName(message) }}</strong><time :datetime="message.createdAt" :title="formatFullMessageTime(message.createdAt)">{{ formatMessageTime(message.createdAt, calendarNow) }}</time></div>
              <p v-if="message.content" class="chat-message-content"><template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex"><a v-if="segment.href" class="chat-message-link" :href="segment.href" @click.prevent="openLink(segment.href)">{{ segment.text }}</a><template v-else>{{ segment.text }}</template></template></p>
              <ChatImage v-if="message.type === 'IMAGE' && message.attachment" :group-id="group.id" :attachment-id="message.attachment.id"
                :width="message.attachment.width ?? 1" :height="message.attachment.height ?? 1" :alt="`${senderName(message)} 发送的图片`" />
              <ChatFileCard v-if="message.type === 'FILE' && message.attachment" :group-id="group.id" :attachment="message.attachment" />
            </div>
          </article>
        </template>
      </div>
      <button v-if="showMessageJump && messages.length" type="button" class="chat-jump" :aria-label="messageJumpLabel" @click="jumpToMessages">
        <ArrowDown :size="13" /><span>{{ messageJumpLabel }}</span>
      </button>
    </div>
    <div class="composer-shell">
      <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
      <form class="composer" @submit.prevent="submit">
        <input ref="fileInput" type="file" hidden multiple @change="chooseFiles" />
        <button type="button" aria-label="添加文件" :disabled="busy || preparing" @click="fileInput?.click()"><Plus :size="16" /></button>
        <div class="composer-content">
          <div v-if="preparing" class="chat-transfer-state" role="status">正在压缩图片…</div>
          <div v-if="pendingAttachments.length" class="composer-attachments">
            <div v-for="item in pendingAttachments" :key="item.id" class="composer-attachment">
              <img v-if="item.previewUrl" :src="item.previewUrl" alt="待发送图片" />
              <span class="composer-attachment-name">{{ item.file.name }}</span>
              <small>{{ item.kind === 'IMAGE' ? '已压缩' : (item.file.size / 1024 / 1024).toFixed(2) + ' MB' }}</small>
              <progress v-if="item.state === 'uploading' && item.kind === 'FILE'" :value="item.progress" :max="item.file.size" aria-label="文件上传进度" />
              <small v-if="item.error" class="chat-file-error" :role="item.state === 'failed' ? 'alert' : 'status'">{{ item.error }}</small>
              <button v-if="item.state === 'uploading'" type="button" aria-label="取消文件上传" @click="cancelUpload"><X :size="13" /></button>
              <button v-else-if="item.state !== 'sent'" type="button" :aria-label="`移除 ${item.file.name}`" @click="removePendingAttachment(item.id)"><X :size="13" /></button>
              <small v-else>已发送</small>
            </div>
          </div>
          <textarea ref="messageInput" v-model="text" aria-label="消息内容" maxlength="2000" rows="1" :disabled="busy || preparing" placeholder="发送消息" @input="resizeMessageInput" @keydown="handleKeydown" @paste="handlePaste" />
        </div>
        <button type="submit" aria-label="发送消息" :disabled="!canSend"><Send :size="15" /></button>
      </form>
    </div>
  </section>
</template>

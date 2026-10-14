<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { MessageSquareText, Plus, Send, X } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import { findMessages, sendFile, sendMessage, type ChatMessage } from '../chat/chatApi';
import { messagePollDelay } from '../chat/messagePolling';
import { compressChatImage } from '../chat/messageImage';
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
const messages = ref<ChatMessage[]>([]);
const text = ref('');
const pendingAttachments = ref<PendingAttachment[]>([]);
const busy = ref(false);
const preparing = ref(false);
const error = ref('');
const pollError = ref('');
const historyError = ref('');
const list = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const messageTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const messageDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric',
});
const MESSAGE_GROUP_MAX_GAP_MS = 5 * 60_000;
const HISTORY_TOP_THRESHOLD = 80;
let hasMore = false;
let loadingOlder = false;
let pollRequest: AbortController | null = null;
let historyRequest: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let initialLoaded = false;
let consecutiveEmptyPolls = 0;
let lastActivationRefreshAt = 0;
let atBottom = true;
let lastScrollTop = 0;

const members = computed(() => new Map(props.members.map((member) => [member.userId, member])));
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
  if (disposed || (!force && !atBottom)) return;
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior });
  atBottom = true;
}

function appendMessages(incoming: ChatMessage[], forceScroll = false, behavior: ScrollBehavior = 'smooth') {
  const known = new Set(messages.value.map((message) => message.id));
  const added = incoming.filter((message) => {
    if (known.has(message.id)) return false;
    known.add(message.id);
    return true;
  });
  if (!added.length) return 0;
  messages.value = [...messages.value, ...added];
  if (forceScroll || atBottom) void scrollToBottom(behavior, forceScroll);
  return added.length;
}

async function refresh() {
  pollRequest?.abort();
  const controller = new AbortController();
  pollRequest = controller;
  const groupId = props.group.id;
  const initial = !initialLoaded;
  try {
    const latestId = initial ? undefined : messages.value.at(-1)?.id;
    const page = await findMessages(groupId, latestId ? { afterMessageId: latestId } : undefined, controller.signal);
    if (controller.signal.aborted || disposed || pollRequest !== controller || props.group.id !== groupId) return null;
    pollError.value = '';
    if (!latestId) {
      hasMore = page.hasMore;
      initialLoaded = true;
    }
    // 历史或轮询可能晚于本机发送返回；游标之后先按服务端顺序合并，再补上快照之后发出的消息。
    const currentIds = new Set(messages.value.map((message) => message.id));
    const snapshotIds = new Set(page.messages.map((message) => message.id));
    const prefixEnd = latestId ? messages.value.findIndex((message) => message.id === latestId) + 1 : 0;
    const added = page.messages.filter((message) => !currentIds.has(message.id)).length;
    messages.value = [...messages.value.slice(0, prefixEnd), ...page.messages,
      ...messages.value.slice(prefixEnd).filter((message) => !snapshotIds.has(message.id))];
    if (added && (initial || atBottom)) void scrollToBottom(initial ? 'auto' : 'smooth', initial);
    return added;
  } catch (reason) {
    if (controller.signal.aborted || disposed || pollRequest !== controller) return null;
    pollError.value = reason instanceof Error ? reason.message : '无法读取群聊消息';
    return 0;
  } finally {
    if (pollRequest === controller) pollRequest = null;
  }
}

async function loadOlder() {
  const element = list.value;
  const cursor = messages.value[0]?.id;
  if (!element || !cursor || !initialLoaded || !hasMore || loadingOlder || disposed) return;
  const controller = new AbortController();
  historyRequest = controller;
  loadingOlder = true;
  historyError.value = '';
  atBottom = false;
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
    hasMore = page.hasMore && older.length > 0;
    if (!older.length) return;
    // 日期分割线可能因插入旧消息而变化，锚定当前可见消息比只计算列表高度更稳定。
    const listBounds = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((message) => message.getBoundingClientRect().bottom > listBounds.top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    messages.value = [...older, ...messages.value];
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
      loadingOlder = false;
      atBottom = isAtBottom();
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
  const initial = !initialLoaded;
  const added = await refresh();
  if (added === null || disposed || document.visibilityState === 'hidden') return;
  consecutiveEmptyPolls = initial || added > 0 ? 0 : consecutiveEmptyPolls + 1;
  scheduleRefresh();
}

function refreshOnActivation() {
  if (document.visibilityState === 'hidden' || Date.now() - lastActivationRefreshAt < 500) return;
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
    loadingOlder = false;
    atBottom = isAtBottom();
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
          if (!controller.signal.aborted) error.value = item.error;
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

watch(() => props.group.id, () => {
  pollRequest?.abort();
  historyRequest?.abort();
  activeUpload?.abort();
  activeUpload = null;
  sendGeneration++;
  busy.value = false;
  preparationGeneration++;
  preparing.value = false;
  clearPendingAttachments();
  messages.value = [];
  error.value = '';
  pollError.value = '';
  historyError.value = '';
  initialLoaded = false;
  hasMore = false;
  loadingOlder = false;
  historyRequest = null;
  clearRefreshTimer();
  void pollMessages();
});

function senderName(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.nickname : message.senderNickname;
}

function senderAvatar(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.avatar : members.value.get(message.senderUserId)?.avatar ?? '';
}

function formatTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const time = messageTimeFormatter.format(date);
  if (localDateKey(value) === localDateKey(now.toISOString())) return time;
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${dateLabel} ${time}`
    : `${date.getFullYear()}年${dateLabel} ${time}`;
}

function localDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
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

function formatDate(value: string) {
  return messageDateFormatter.format(new Date(value));
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
  lastScrollTop = element.scrollTop;
  atBottom = isAtBottom();
  if (movingUp && element.scrollTop <= HISTORY_TOP_THRESHOLD) void loadOlder();
}

function onWheel(event: WheelEvent) {
  if (event.deltaY < 0 && list.value && list.value.scrollTop <= HISTORY_TOP_THRESHOLD) void loadOlder();
}

onMounted(() => {
  void pollMessages();
  window.addEventListener('focus', refreshOnActivation);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onScopeDispose(() => {
  disposed = true;
  pollRequest?.abort();
  historyRequest?.abort();
  historyRequest = null;
  clearRefreshTimer();
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
    <div class="chat-heading"><MessageSquareText :size="15" /><span>群聊</span></div>
    <div ref="list" class="message-list" @scroll="onScroll" @wheel="onWheel">
      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="startsNewDate(message, index)" class="chat-date-divider"><span>{{ formatDate(message.createdAt) }}</span></div>
        <article class="chat-message" :data-message-id="message.id" :class="{ 'is-own': message.senderUserId === user.id, 'is-grouped': !startsNewMessageGroup(message, index) }">
          <template v-if="startsNewMessageGroup(message, index)">
            <img v-if="senderAvatar(message)" class="chat-message-avatar" :src="senderAvatar(message)" alt="" />
            <span v-else class="chat-message-avatar chat-message-initial">{{ senderName(message).slice(0, 1) }}</span>
          </template>
          <span v-else class="chat-message-avatar-placeholder" aria-hidden="true" />
          <div class="chat-message-body">
            <div v-if="startsNewMessageGroup(message, index)" class="chat-message-meta"><strong>{{ senderName(message) }}</strong><time>{{ formatTime(message.createdAt) }}</time></div>
            <p v-if="message.content" class="chat-message-content"><template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex"><a v-if="segment.href" class="chat-message-link" :href="segment.href" @click.prevent="openLink(segment.href)">{{ segment.text }}</a><template v-else>{{ segment.text }}</template></template></p>
            <ChatImage v-if="message.type === 'IMAGE' && message.attachment" :group-id="group.id" :attachment-id="message.attachment.id"
              :width="message.attachment.width ?? 1" :height="message.attachment.height ?? 1" :alt="`${senderName(message)} 发送的图片`" />
            <ChatFileCard v-if="message.type === 'FILE' && message.attachment" :group-id="group.id" :attachment="message.attachment" />
          </div>
        </article>
      </template>
    </div>
    <div class="composer-shell">
      <p v-if="error || historyError || pollError" class="chat-error" role="alert">{{ error || historyError || pollError }}</p>
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
              <small v-if="item.error" class="chat-file-error">{{ item.error }}</small>
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

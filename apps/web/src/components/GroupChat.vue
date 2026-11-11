<script setup lang="ts">
import '../chat/chat.css';
import { computed, inject, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { useChatScroll } from '../chat/useChatScroll';
import { useGroupMessages } from '../chat/useGroupMessages';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { useLoadingHint } from './useLoadingHint';
import { ArrowDown, MessageSquareText, Plus, Send, X } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import { sendFile, sendMessage, type ChatMessage } from '../chat/chatApi';
import { compressChatImage } from '../chat/messageImage';
import { formatFullMessageTime, formatMessageDateDivider, formatMessageTime, localDateKey } from '../chat/messageTime';
import type { GroupMember, GroupSummary } from '../group/groupApi';
import ChatImage from './ChatImage.vue';
import ProfilePopover from './ProfilePopover.vue';
import { findGroupMemberProfile, type GroupMemberProfile } from '../group/groupApi';
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
const historicalSender = ref<ChatMessage | null>(null);
const historicalAnchor = ref<HTMLElement | null>(null);
const historicalProfile = ref<GroupMemberProfile | null>(null);
const historicalError = ref('');
const historicalLoading = ref(false);
let historicalRequest: AbortController | undefined;
function closeHistoricalProfile() {
  historicalRequest?.abort(); historicalAnchor.value = null;
}
async function showHistoricalProfile(message: ChatMessage, anchor: HTMLElement) {
  closeHistoricalProfile();
  historicalSender.value = message; historicalAnchor.value = anchor;
  historicalProfile.value = null; historicalError.value = ''; historicalLoading.value = true;
  const request = historicalRequest = new AbortController();
  try {
    const profile = await findGroupMemberProfile(props.group.id, message.senderUserId, request.signal);
    if (!request.signal.aborted) historicalProfile.value = profile;
  } catch (reason) {
    if (!request.signal.aborted) historicalError.value = reason instanceof Error ? reason.message : '无法读取历史资料';
  } finally { if (!request.signal.aborted) historicalLoading.value = false; }
}
const text = ref('');
const pendingAttachments = ref<PendingAttachment[]>([]);
const busy = ref(false);
const preparing = ref(false);
const error = ref('');
const calendarNow = ref(new Date());
const fileInput = ref<HTMLInputElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const MESSAGE_GROUP_MAX_GAP_MS = 5 * 60_000;
let calendarTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

const members = computed(() => new Map(props.members.map((member) => [member.userId, member])));
const scroll = useChatScroll(() => { void loadOlder(); });
const { showMessageJump, messageJumpLabel, jumpToMessages, onScroll, onScrollEnd, onWheel, cancelScrollFollow } = scroll;
const synchronization = useGroupMessages({ getGroupId: () => props.group.id, getUserId: () => props.user.id, cache, scroll,
  onInitialLoad: groupId => emit('initialLoad', groupId) });
const { messages, initialLoaded, pollError, historyError, refreshing, loadingOlder, hasMore,
  appendMessages, loadOlder, retryRefresh } = synchronization;
const initialLoadingHint = useLoadingHint(() => !initialLoaded.value && !messages.value.length && !pollError.value);
const historyLoadingHint = useLoadingHint(() => loadingOlder.value);
const canSend = computed(() => !busy.value && !preparing.value
  && (text.value.trim().length > 0 || pendingAttachments.value.some((item) => item.state !== 'sent')));
let activeUpload: AbortController | null = null;
let preparationGeneration = 0;
let sendGeneration = 0;

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

function resizeMessageInput() {
  const element = messageInput.value;
  if (!element) return;
  const height = element.getBoundingClientRect().height;
  // 测量自然高度时暂时关闭过渡，再从当前显示高度平滑到新高度，支持中途继续输入。
  element.style.transition = 'none';
  element.style.height = '42px';
  const target = Math.min(element.scrollHeight, 122);
  element.style.height = `${height}px`;
  void element.offsetHeight;
  element.style.transition = '';
  element.style.height = `${target}px`;
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
    await nextTick();
    if (!disposed) resizeMessageInput();
    synchronization.refreshAfterSend();
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
  return message.senderUserId === props.user.id ? props.user.avatar : members.value.get(message.senderUserId)?.avatar ?? message.senderAvatar ?? '';
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

function refreshOnActivation() {
  if (document.visibilityState === 'hidden') return;
  refreshCalendar();
  synchronization.refreshOnActivation();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (calendarTimer) clearTimeout(calendarTimer);
    calendarTimer = null;
  } else refreshCalendar();
  synchronization.handleVisibilityChange();
}

onMounted(() => {
  scroll.start();
  refreshCalendar();
  void synchronization.pollMessages();
  window.addEventListener('focus', refreshOnActivation);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onScopeDispose(() => {
  // App 按群 ID 创建独立实例；切群统一在销毁处取消，观看布局不重建群聊。
  disposed = true;
  closeHistoricalProfile();
  if (calendarTimer) clearTimeout(calendarTimer);
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
      <div :ref="scroll.list" class="message-list" :class="{ 'group-content-ready': initialLoaded }"
        @scroll="onScroll" @scrollend="onScrollEnd" @wheel="onWheel" @pointerdown="cancelScrollFollow"
        @keydown="['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes($event.key) && cancelScrollFollow()">
        <div v-if="!initialLoaded && (pollError || initialLoadingHint)" class="chat-initial-state" :class="{ 'is-empty': !messages.length }">
          <template v-if="pollError">
            <p class="chat-read-error" role="alert">{{ pollError }}</p>
            <button type="button" class="chat-retry" :disabled="refreshing" @click="retryRefresh">{{ refreshing ? '正在重试…' : '重新读取消息' }}</button>
          </template>
          <p v-else role="status">正在读取消息…</p>
        </div>
        <p v-else-if="initialLoaded && !messages.length" class="chat-initial-state is-empty" role="status">还没有消息</p>
        <div v-if="initialLoaded && messages.length && (hasMore || loadingOlder || historyError)" class="chat-history-state" :aria-busy="loadingOlder">
          <span v-if="historyLoadingHint" role="status">正在读取更早消息…</span>
          <template v-else-if="historyError">
            <span class="chat-history-error" role="alert">{{ historyError }}</span>
            <button type="button" class="chat-retry" @click="loadOlder">重试</button>
          </template>
          <button v-else type="button" class="chat-retry" :disabled="loadingOlder" @click="loadOlder">查看更早消息</button>
        </div>
        <template v-for="(message, index) in messages" :key="message.id">
          <div v-if="startsNewDate(message, index)" class="chat-date-divider"><time :datetime="message.createdAt">{{ formatMessageDateDivider(message.createdAt) }}</time></div>
          <article class="chat-message" :data-message-id="message.id" :class="{ 'is-own': message.senderUserId === user.id, 'is-grouped': !startsNewMessageGroup(message, index) }">
            <template v-if="startsNewMessageGroup(message, index)">
              <img v-if="senderAvatar(message)" class="chat-message-avatar" :src="senderAvatar(message)" alt="" />
              <span v-else class="chat-message-avatar chat-message-initial">{{ senderName(message).slice(0, 1) }}</span>
            </template>
            <span v-else class="chat-message-avatar-placeholder" aria-hidden="true" />
            <div class="chat-message-body">
              <div v-if="startsNewMessageGroup(message, index)" class="chat-message-meta"><button v-if="message.senderDeletedAt" type="button" class="chat-historical-sender" @click="showHistoricalProfile(message, $event.currentTarget as HTMLElement)">{{ senderName(message) }}</button><strong v-else>{{ senderName(message) }}</strong><span v-if="message.senderDeletedAt" class="chat-deleted-account">已注销</span><time :datetime="message.createdAt" :title="formatFullMessageTime(message.createdAt)">{{ formatMessageTime(message.createdAt, calendarNow) }}</time></div>
              <p v-if="message.content" class="chat-message-content"><template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex"><a v-if="segment.href" class="chat-message-link" :href="segment.href" @click.prevent="openLink(segment.href)">{{ segment.text }}</a><template v-else>{{ segment.text }}</template></template></p>
              <ChatImage v-if="message.type === 'IMAGE' && message.attachment" :group-id="group.id" :attachment-id="message.attachment.id"
                :width="message.attachment.width ?? 1" :height="message.attachment.height ?? 1" :alt="`${senderName(message)} 发送的图片`" />
              <ChatFileCard v-if="message.type === 'FILE' && message.attachment" :group-id="group.id" :attachment="message.attachment" />
            </div>
          </article>
        </template>
      </div>
      <Transition name="surface-panel">
        <button v-if="showMessageJump && messages.length" type="button" class="chat-jump" :aria-label="messageJumpLabel" @click="jumpToMessages">
          <ArrowDown :size="13" /><span>{{ messageJumpLabel }}</span>
        </button>
      </Transition>
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
    <ProfilePopover :anchor="historicalAnchor" :profile-key="historicalSender?.senderUserId" placement="left" label="历史成员资料"
      :nickname="historicalSender?.senderNickname ?? ''" :avatar="historicalSender?.senderAvatar ?? ''"
      :deleted-at="historicalSender?.senderDeletedAt" :signature="historicalProfile?.signature" status="OFFLINE" status-label="已注销"
      :loading="historicalLoading" :error="historicalError" :voice-seconds="historicalProfile?.sharedVoiceSeconds"
      @close="closeHistoricalProfile" @retry="historicalSender && historicalAnchor && showHistoricalProfile(historicalSender, historicalAnchor)" />
  </section>
</template>

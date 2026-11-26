<script setup lang="ts">
import '../chat/chat.css';
import { computed, inject, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from 'vue';
import { useChatScroll } from '../chat/useChatScroll';
import { useComposerHeight } from '../chat/useComposerHeight';
import { useGroupMessages } from '../chat/useGroupMessages';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { useLoadingHint } from './useLoadingHint';
import { ArrowDown, LoaderCircle, MessageSquareText, Plus, Send, X } from '@lucide/vue';
import defaultAvatar from '../../../../services/api/src/main/resources/account/default.png';
import type { AuthUser } from '../auth/authApi';
import { uploadLimits, type ChatMessage } from '../chat/chatApi';
import { CHAT_TRANSFERS, type DraftAttachment } from '../chat/useChatTransfers';
import { chatUploadImageThumbnail, compressChatImage } from '../chat/messageImage';
import { formatFullMessageTime, formatMessageDateDivider, formatMessageTime, localDateKey } from '../chat/messageTime';
import type { GroupMember, GroupSummary } from '../group/groupApi';
import ChatTransferStatus from './ChatTransferStatus.vue';
import ChatImage from './ChatImage.vue';
import ProfilePopover from './ProfilePopover.vue';
import { findGroupMemberProfile, type GroupMemberProfile } from '../group/groupApi';
import ChatFileMedia from './ChatFileMedia.vue';
import ChatMediaViewer from './ChatMediaViewer.vue';
import RecordingThumbnail from './settings/RecordingThumbnail.vue';
import { chatMediaFormat, formatAttachmentSize } from '../chat/chatMedia';
import DialogTransition from './DialogTransition.vue';

type PendingAttachment = DraftAttachment & {
  preparing: boolean;
  originalFile?: File; optimizedImage?: File; sendOriginal?: boolean; originalLimit?: number; imageError?: boolean;
  thumbnailRequest?: AbortController;
  originalSizeError?: string;
};
type MessageSegment = { text: string; href?: string };
const props = defineProps<{ group: GroupSummary; members: GroupMember[]; user: AuthUser; syncError?: string; recordingAttachment?: RecordingLibraryEntry }>();
const emit = defineEmits<{ initialLoad: [groupId: string]; retrySync: []; recordingConsumed: [] }>();
const pendingPreview = ref<PendingAttachment | null>(null);
const cache = inject(ACCOUNT_CACHE, null);
const viewedMedia = ref<ChatMessage | null>(null);
const viewedMediaBlob = ref<Blob>();
const videoPercent = ref<number | null>(null);
function closeMedia() {
  viewedMedia.value = null;
  viewedMediaBlob.value = undefined;
  videoPercent.value = null;
}
function previewMedia(message: ChatMessage, blob?: Blob) {
  if (videoPercent.value !== null && viewedMedia.value?.id === message.id) { closeMedia(); return; }
  viewedMediaBlob.value = blob;
  viewedMedia.value = message;
  videoPercent.value = message.attachment && chatMediaFormat(message.attachment)?.kind === 'video' ? 0 : null;
}
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
const transfers = inject(CHAT_TRANSFERS)!;
const selection = new AbortController();
const preparing = computed(() => pendingAttachments.value.some(item => item.preparing));
const linkError = ref('');
const attachmentErrors = ref<string[]>([]);
let attachmentErrorTimer: ReturnType<typeof setTimeout> | undefined;
const calendarNow = ref(new Date());
const fileInput = ref<HTMLInputElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const composerViewport = ref<HTMLElement | null>(null);
const composerContent = ref<HTMLElement | null>(null);
const resizeMessageInput = useComposerHeight(messageInput, composerViewport, composerContent);
const MESSAGE_GROUP_MAX_GAP_MS = 5 * 60_000;
let calendarTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

const members = computed(() => new Map(props.members.map((member) => [member.userId, member])));
const scroll = useChatScroll(() => { void loadOlder(); });
const { showMessageJump, messageJumpLabel, jumpToMessages, onScroll, onScrollEnd, onWheel, cancelScrollFollow } = scroll;
const synchronization = useGroupMessages({ getGroupId: () => props.group.id, getUserId: () => props.user.id, cache, scroll,
  onInitialLoad: groupId => emit('initialLoad', groupId) });
const { messages: confirmed, initialLoaded, pollError, historyError, refreshing, loadingOlder, hasMore,
  appendMessages, loadOlder, retryRefresh } = synchronization;
const messages = computed(() => {
  if (!transfers.outgoing.size) return confirmed.value;
  const ids = new Set(confirmed.value.map(message => message.id));
  return [...confirmed.value, ...Array.from(transfers.outgoing.values())
    .filter(job => job.groupId === props.group.id && !ids.has(job.message.id)).map(job => job.message)];
});
function receiveSent(groupId: string, message: ChatMessage) {
  if (groupId !== props.group.id) return;
  const item = transfers.outgoing.get(message.id)?.item;
  if (item && 'type' in item.file && message.attachment && !message.attachment.transferStatus
      && (message.type === 'IMAGE' || chatMediaFormat(message.attachment)?.kind === 'image') && item.file.size <= 8 * 1024 * 1024) {
    const key = message.type === 'IMAGE' ? message.attachment.id : 'file:' + message.attachment.id;
    void cache?.write('image', groupId, item.file, key);
  }
  const index = confirmed.value.findIndex(previous => previous.id === message.id);
  if (index >= 0) confirmed.value[index] = message;
  else appendMessages([message], true);
}
transfers.listeners.add(receiveSent);
watch(confirmed, snapshot => {
  if (!transfers.outgoing.size) return;
  for (const message of snapshot) {
    const job = transfers.outgoing.get(message.id);
    if (job && !message.attachment?.transferStatus && message.senderUserId === props.user.id) transfers.acknowledge(job);
  }
});
// 首次消息读取失败仍在原读取区域展示，已有消息时与成员同步共用顶部反馈。
const syncError = computed(() => initialLoaded.value || !pollError.value ? pollError.value || props.syncError : '');
function retrySync() {
  if (props.syncError) emit('retrySync');
  void retryRefresh();
}
const initialLoadingHint = useLoadingHint(() => !initialLoaded.value && !messages.value.length && !pollError.value);
const historyLoadingHint = useLoadingHint(() => loadingOlder.value);
const attachmentPreparingHint = useLoadingHint(() => preparing.value);
const canSend = computed(() => !preparing.value && !pendingAttachments.value.some(item => item.imageError && !item.sendOriginal)
  && (text.value.trim().length > 0 || pendingAttachments.value.length > 0));

function sizeError(file: Pick<File, 'name' | 'size'>, limit: number) {
  return file.size <= limit ? '' : file.name + '（' + formatAttachmentSize(file.size) + '）超过单文件上限 ' + formatAttachmentSize(limit);
}

function clearAttachmentErrors() {
  clearTimeout(attachmentErrorTimer);
  attachmentErrors.value = [];
}

function scheduleAttachmentErrorDismissal() {
  clearTimeout(attachmentErrorTimer);
  if (attachmentErrors.value.length && document.visibilityState === 'visible') {
    attachmentErrorTimer = setTimeout(clearAttachmentErrors, 5000);
  }
}

function rejectAttachment(item: PendingAttachment, message: string) {
  removePendingAttachment(item.id);
  attachmentErrors.value.push(message);
  scheduleAttachmentErrorDismissal();
}

function revokePreview(item: PendingAttachment) {
  item.thumbnailRequest?.abort();
  if (pendingPreview.value?.id === item.id) pendingPreview.value = null;
  if (item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
}

// 草稿依次解码小图；发送只取此刻已完成的结果，后续消息不等待预览。
let preparingThumbnail = Promise.resolve();
function prepareThumbnail(item: PendingAttachment) {
  item.thumbnailRequest?.abort();
  item.thumbnail = undefined;
  if (item.recordingId !== undefined || (item.kind === 'IMAGE' && !item.sendOriginal)) return;
  const format = chatMediaFormat(attachmentInfo(item));
  if (!format || !['image/jpeg', 'image/png', 'image/gif'].includes(format.contentType)) return;
  const file = item.file;
  const request = item.thumbnailRequest = new AbortController();
  preparingThumbnail = preparingThumbnail.then(async () => {
    if (request.signal.aborted) return;
    const thumbnail = await chatUploadImageThumbnail(file, request.signal);
    if (!request.signal.aborted) item.thumbnail = thumbnail;
  });
}

function clearPendingAttachments() {
  for (const item of pendingAttachments.value) revokePreview(item);
  pendingAttachments.value = [];
}

function removePendingAttachment(id: string) {
  const item = pendingAttachments.value.find((attachment) => attachment.id === id);
  if (!item) return;
  revokePreview(item);
  pendingAttachments.value = pendingAttachments.value.filter((attachment) => attachment.id !== id);
}

let limitsRequest: ReturnType<typeof uploadLimits> | undefined;
let imagePreparation = Promise.resolve();

async function prepareAttachment(item: PendingAttachment) {
  pendingAttachments.value.push(item);
  try {
    limitsRequest ??= uploadLimits(selection.signal).finally(() => { limitsRequest = undefined; });
    const { maxFileBytes } = await limitsRequest;
    if (!pendingAttachments.value.includes(item)) return;
    item.originalLimit = maxFileBytes;
    const original = item.originalFile;
    if (original) {
      // 大图逐张解码，后加入的普通文件可以先就绪。
      imagePreparation = imagePreparation.then(async () => {
        if (!pendingAttachments.value.includes(item)) return;
        try {
          const optimized = await compressChatImage(original);
          if (!pendingAttachments.value.includes(item)) return;
          item.optimizedImage = new File([optimized], original.name, { type: optimized.type });
          item.file = item.optimizedImage;
        } catch {
          item.imageError = true;
        }
      });
      await imagePreparation;
      if (!pendingAttachments.value.includes(item)) return;
    }
    const tooLarge = sizeError(item.file, maxFileBytes);
    if (tooLarge) {
      rejectAttachment(item, tooLarge);
      return;
    }
    if (item.recordingId !== undefined) {
      item.previewUrl = `lycan://app/recordings/${encodeURIComponent(item.recordingId)}`;
    } else if (attachmentKind(item)) {
      item.previewUrl = URL.createObjectURL(item.file);
      prepareThumbnail(item);
    }
    item.preparing = false;
  } catch (reason) {
    if (!pendingAttachments.value.includes(item)) return;
    rejectAttachment(item, item.file.name + '：' + (reason instanceof Error ? reason.message : '添加附件失败'));
  }
}

async function enqueueFiles(files: File[], sendAsImageMessage: boolean) {
  if (!files.length) return;
  clearAttachmentErrors();
  await Promise.all(files.map(file => {
    const image = file.type === 'image/png' || file.type === 'image/jpeg';
    const item = reactive<PendingAttachment>({ id: crypto.randomUUID(), kind: image && sendAsImageMessage ? 'IMAGE' : 'FILE',
      file, originalFile: image ? file : undefined, previewUrl: '', preparing: true });
    if (image || attachmentKind(item) === 'video') item.sendOriginal = false;
    return prepareAttachment(item);
  }));
}

function selectOriginal(item: PendingAttachment, event: Event) {
  clearAttachmentErrors();
  const input = event.target as HTMLInputElement;
  item.originalSizeError = input.checked && item.originalFile ? sizeError(item.originalFile, item.originalLimit!) : '';
  if (item.originalSizeError) {
    input.checked = false;
    return;
  }
  item.sendOriginal = input.checked;
  if (item.originalFile && item.optimizedImage) {
    revokePreview(item);
    const file = input.checked ? item.originalFile : item.optimizedImage;
    item.file = file;
    item.previewUrl = URL.createObjectURL(file);
  }
  prepareThumbnail(item);
}

function attachmentInfo(item: PendingAttachment) {
  return { id: item.id, fileName: item.file.name, byteSize: item.file.size,
    contentType: 'type' in item.file ? item.file.type : 'video/x-matroska' };
}
function attachmentKind(item: PendingAttachment) { return chatMediaFormat(attachmentInfo(item))?.kind; }
watch(() => props.recordingAttachment, async entry => {
  if (!entry) return;
  clearAttachmentErrors();
  emit('recordingConsumed');
  const item = reactive<PendingAttachment>({ id: crypto.randomUUID(), kind: 'FILE', recordingId: entry.id,
    file: { name: entry.fileName || `${entry.applicationName || '录像'}.mkv`, size: entry.bytes! },
    previewUrl: '', sendOriginal: false, preparing: true });
  await prepareAttachment(item);
  await nextTick();
  if (pendingAttachments.value.includes(item)) { resizeMessageInput(); messageInput.value?.focus(); }
}, { immediate: true });

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
    void submit(true);
  }
}

async function submit(restoreFocus = false) {
  if (!canSend.value) return;
  const queued = pendingAttachments.value;
  const content = text.value;
  const groupId = props.group.id;
  pendingAttachments.value = [];
  pendingPreview.value = null;
  text.value = '';
  clearAttachmentErrors();
  linkError.value = '';
  if (queued.length) queued.forEach((draft, index) => {
    draft.thumbnailRequest?.abort();
    const attachment: DraftAttachment = draft.recordingId !== undefined
      ? { id: draft.id, recordingId: draft.recordingId, kind: 'FILE', file: draft.file, previewUrl: draft.previewUrl }
      : { id: draft.id, kind: draft.sendOriginal ? 'FILE' : draft.kind, file: draft.file, previewUrl: draft.previewUrl, thumbnail: draft.thumbnail };
    attachment.optimizeVideo = attachmentKind(draft) === 'video' && !draft.sendOriginal;
    transfers.enqueue(groupId, index === 0 ? content : '', attachment);
  });
  else transfers.enqueue(groupId, content);
  await nextTick();
  if (disposed) return;
  resizeMessageInput();
  const input = messageInput.value;
  if (restoreFocus && input?.isConnected && !input.closest('[inert]') && document.visibilityState !== 'hidden'
      && (document.activeElement === document.body || document.activeElement === input)) input.focus({ preventScroll: true });
  void scroll.scrollToBottom('smooth', true);
}

function senderName(message: ChatMessage) {
  if (message.senderDeletedAt) return '账号已注销';
  return message.senderUserId === props.user.id ? props.user.nickname : message.senderNickname;
}

function senderAvatar(message: ChatMessage) {
  if (message.senderDeletedAt) return defaultAvatar;
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
    void window.lycanDesktop.openExternal(url).catch(() => { linkError.value = '无法打开默认浏览器。'; });
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
  scheduleAttachmentErrorDismissal();
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
  // 切群清理草稿和本群订阅；已提交的任务由账号持有。
  disposed = true;
  clearTimeout(attachmentErrorTimer);
  closeHistoricalProfile();
  if (calendarTimer) clearTimeout(calendarTimer);
  window.removeEventListener('focus', refreshOnActivation);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  selection.abort();
  transfers.listeners.delete(receiveSent);
  clearPendingAttachments();
});
</script>

<template>
  <section class="chat-panel" :aria-label="`${group.name}群聊`" @dragover.prevent @drop="handleDrop">
    <div class="chat-heading">
      <span class="chat-title"><MessageSquareText :size="15" /><span>群聊</span></span>
      <div v-if="syncError" class="chat-sync-status" role="status" :aria-busy="refreshing">
        <span>{{ syncError }}</span><button type="button" class="chat-retry" :disabled="refreshing" @click="retrySync">{{ refreshing ? '重试中…' : '重试' }}</button>
      </div>
    </div>
    <div class="chat-timeline">
      <div :ref="scroll.list" class="message-list" :class="{ 'group-content-ready': initialLoaded }"
        @scroll="onScroll" @scrollend="onScrollEnd" @wheel="onWheel" @pointerdown="cancelScrollFollow"
        @keydown="['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes($event.key) && cancelScrollFollow()">
        <div v-if="!initialLoaded && (pollError || initialLoadingHint)" class="chat-initial-state" :class="{ 'is-empty': !messages.length }">
          <template v-if="pollError">
            <p class="chat-read-error" role="alert">{{ pollError }}</p>
            <button type="button" class="chat-retry" :disabled="refreshing" @click="retrySync">{{ refreshing ? '正在重试…' : '重新读取消息' }}</button>
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
          <article class="chat-message" :data-message-id="message.id" :class="{ 'is-own': message.senderUserId === user.id, 'is-text': message.type === 'TEXT', 'is-grouped': !startsNewMessageGroup(message, index) }">
            <template v-if="startsNewMessageGroup(message, index)">
              <img v-if="senderAvatar(message)" class="chat-message-avatar" :src="senderAvatar(message)" alt="" />
              <span v-else class="chat-message-avatar chat-message-initial">{{ senderName(message).slice(0, 1) }}</span>
            </template>
            <span v-else class="chat-message-avatar-placeholder" aria-hidden="true" />
            <div class="chat-message-body">
              <div v-if="startsNewMessageGroup(message, index)" class="chat-message-meta"><button v-if="message.senderDeletedAt" type="button" class="chat-historical-sender" @click="showHistoricalProfile(message, $event.currentTarget as HTMLElement)">{{ senderName(message) }}</button><strong v-else>{{ senderName(message) }}</strong><time :datetime="message.createdAt" :title="formatFullMessageTime(message.createdAt)">{{ formatMessageTime(message.createdAt, calendarNow) }}</time></div>
              <div class="chat-message-main">
                <p v-if="message.content" class="chat-message-content"><template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex"><a v-if="segment.href" class="chat-message-link" :href="segment.href" @click.prevent="openLink(segment.href)">{{ segment.text }}</a><template v-else>{{ segment.text }}</template></template></p>
                <ChatTransferStatus v-if="transfers.outgoing.has(message.id) || message.attachment?.transferStatus"
                  :group-id="group.id" :message="message" :job="transfers.outgoing.get(message.id)" @retry="transfers.retry" @dismiss="transfers.forget" />
                <ChatImage v-else-if="message.type === 'IMAGE' && message.attachment" :group-id="group.id" :attachment-id="message.attachment.id"
                  :width="message.attachment.width ?? 420" :height="message.attachment.height ?? 236" :byte-size="message.attachment.byteSize" :alt="`${senderName(message)} 发送的图片`" @preview="blob => previewMedia(message, blob)" />
                <ChatFileMedia v-else-if="message.type === 'FILE' && message.attachment" :group-id="group.id" :attachment="message.attachment"
                  :video-loading="viewedMedia?.id === message.id && videoPercent !== null" :video-percent="videoPercent ?? undefined" @preview="blob => previewMedia(message, blob)" />
              </div>
            </div>
          </article>
        </template>
      </div>
      <div class="chat-timeline-actions">
        <div v-if="linkError" class="chat-error">
          <span role="alert">{{ linkError }}</span>
          <button type="button" class="chat-retry" aria-label="关闭提示" @click="linkError = ''"><X :size="14" /></button>
        </div>
        <Transition name="surface-panel">
          <button v-if="showMessageJump && messages.length" type="button" class="chat-jump" :aria-label="messageJumpLabel" @click="jumpToMessages">
            <ArrowDown :size="13" /><span>{{ messageJumpLabel }}</span>
          </button>
        </Transition>
      </div>
    </div>
    <div class="composer-shell">
      <form class="composer" @submit.prevent="submit()">
        <input ref="fileInput" type="file" hidden multiple @change="chooseFiles" />
        <button type="button" aria-label="添加文件" @click="fileInput?.click()"><Plus :size="16" /></button>
        <div ref="composerViewport" class="composer-content">
          <div ref="composerContent">
            <div v-if="pendingAttachments.length" class="composer-attachments">
              <div v-for="item in pendingAttachments" :key="item.id" class="composer-attachment">
                <button type="button" class="composer-attachment-preview" :aria-label="`预览 ${item.file.name}`" :disabled="!attachmentKind(item) || !item.previewUrl" @click="pendingPreview = item">
                  <RecordingThumbnail v-if="attachmentKind(item) === 'video'" class="composer-video-cover" :source="item.previewUrl" :disabled="!item.previewUrl" hide-unavailable />
                  <img v-else-if="attachmentKind(item) === 'image' && item.previewUrl" :key="item.previewUrl" :src="item.previewUrl" alt="" @error="($event.target as HTMLImageElement).hidden = true" />
                  <span class="composer-attachment-name">{{ item.file.name }}</span>
                </button>
                <small>{{ formatAttachmentSize(item.file.size) }}</small>
                <label v-if="item.sendOriginal !== undefined" class="composer-original">
                  <input type="checkbox" :disabled="item.preparing" :checked="item.sendOriginal" @change="selectOriginal(item, $event)" />发送原文件
                </label>
                <button type="button" :aria-label="`移除 ${item.file.name}`" @click="clearAttachmentErrors(); removePendingAttachment(item.id)"><X :size="13" /></button>
                <span v-if="item.originalSizeError || (item.imageError && !item.sendOriginal)" class="composer-attachment-error" role="alert">{{ item.originalSizeError || '图片无法优化，勾选「发送原文件」后可发送。' }}</span>
              </div>
            </div>
            <div v-if="attachmentErrors.length" class="composer-attachment composer-add-error">
              <div role="alert">
                <div v-for="(message, index) in attachmentErrors" :key="index">{{ message }}</div>
              </div>
              <button type="button" aria-label="关闭添加失败提示" @click="clearAttachmentErrors"><X :size="13" /></button>
            </div>
            <textarea ref="messageInput" v-model="text" aria-label="消息内容" maxlength="2000" rows="1" placeholder="发送消息" @input="resizeMessageInput" @keydown="handleKeydown" @paste="handlePaste" />
          </div>
        </div>
        <button type="submit" aria-label="发送消息" :disabled="!canSend" :aria-busy="preparing" :title="attachmentPreparingHint ? '正在准备附件…' : undefined">
          <LoaderCircle v-if="attachmentPreparingHint" class="chat-pending-icon" :size="15" aria-hidden="true" />
          <Send v-else :size="15" />
        </button>
      </form>
    </div>
    <ProfilePopover :anchor="historicalAnchor" :profile-key="historicalSender?.senderUserId" placement="left" label="历史成员资料"
      :nickname="historicalSender?.senderNickname ?? ''" :avatar="historicalSender?.senderAvatar ?? ''"
      :deleted-at="historicalSender?.senderDeletedAt" :signature="historicalProfile?.signature" status="OFFLINE" status-label="已注销"
      :loading="historicalLoading" :error="historicalError" :voice-seconds="historicalProfile?.sharedVoiceSeconds ?? null"
      @close="closeHistoricalProfile" @retry="historicalSender && historicalAnchor && showHistoricalProfile(historicalSender, historicalAnchor)" />
    <DialogTransition>
      <ChatMediaViewer v-if="pendingPreview" :key="pendingPreview.id" :group-id="group.id" :attachment="attachmentInfo(pendingPreview)"
        :image-message="false" :local-source="pendingPreview.previewUrl" @close="pendingPreview = null" />
    </DialogTransition>
    <DialogTransition :defer-open="videoPercent !== null">
      <ChatMediaViewer v-if="viewedMedia?.attachment" :key="viewedMedia.id" :group-id="group.id" :attachment="viewedMedia.attachment"
        :image-message="viewedMedia.type === 'IMAGE'" :preview-blob="viewedMediaBlob" :inline-loading="videoPercent !== null"
        @progress="percent => { if (videoPercent !== null) videoPercent = percent; }" @ready="videoPercent = null" @close="closeMedia" />
    </DialogTransition>
  </section>
</template>

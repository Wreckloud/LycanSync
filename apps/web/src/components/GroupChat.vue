<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { MessageSquareText, Plus, Send, X } from '@lucide/vue';
import type { AuthUser } from '../auth/authApi';
import { findMessages, sendMessage, type ChatMessage } from '../chat/chatApi';
import { compressChatImage, prepareOriginalImage } from '../chat/messageImage';
import type { GroupMember, GroupSummary } from '../group/groupApi';
import ChatImage from './ChatImage.vue';

type MessageSegment = { text: string; href?: string };

const props = defineProps<{ group: GroupSummary; members: GroupMember[]; user: AuthUser }>();
const messages = ref<ChatMessage[]>([]);
const text = ref('');
const image = ref<File | null>(null);
const imagePreview = ref('');
const imageMode = ref<'optimized' | 'original' | null>(null);
const busy = ref(false);
const error = ref('');
const list = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const messageTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const messageDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric',
});
let request: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const refreshOnFocus = () => void refresh();
let atBottom = true;

const members = computed(() => new Map(props.members.map((member) => [member.userId, member])));
const canSend = computed(() => !busy.value && (text.value.trim().length > 0 || image.value !== null));

function isAtBottom() {
  const element = list.value;
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

async function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior });
  atBottom = true;
}

function appendMessages(incoming: ChatMessage[], forceScroll = false, behavior: ScrollBehavior = 'smooth') {
  const known = new Set(messages.value.map((message) => message.id));
  const added = incoming.filter((message) => !known.has(message.id));
  if (!added.length) return;
  messages.value = [...messages.value, ...added];
  if (forceScroll || atBottom) void scrollToBottom(behavior);
}

async function refresh(initial = false) {
  request?.abort();
  request = new AbortController();
  try {
    const latestId = initial ? undefined : messages.value.at(-1)?.id;
    const page = await findMessages(props.group.id, latestId, request.signal);
    if (!request.signal.aborted) appendMessages(page.messages, initial, initial ? 'auto' : 'smooth');
  } catch (reason) {
    if (!request.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取群聊消息';
  }
}

async function assignImage(file: File, mode: 'optimized' | 'original') {
  if (busy.value) return;
  if (image.value) {
    error.value = '当前每条消息只能发送一张图片，请先移除待发送图片。';
    return;
  }
  error.value = '';
  try {
    const prepared = mode === 'optimized' ? await compressChatImage(file) : await prepareOriginalImage(file);
    if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
    image.value = prepared;
    imagePreview.value = URL.createObjectURL(prepared);
    imageMode.value = mode;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '图片处理失败';
  }
}

function removeImage() {
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  image.value = null;
  imagePreview.value = '';
  imageMode.value = null;
}

function chooseOriginal(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void assignImage(file, 'original');
}

function handlePaste(event: ClipboardEvent) {
  const file = [...event.clipboardData?.files ?? []].find((item) => item.type.startsWith('image/'));
  if (file) {
    event.preventDefault();
    void assignImage(file, 'optimized');
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const files = [...event.dataTransfer?.files ?? []];
  const imageFile = files.find((file) => file.type.startsWith('image/'));
  if (imageFile) void assignImage(imageFile, 'optimized');
  else if (files.length) error.value = '文件发送将在后续版本开放；目前支持文本和 PNG/JPEG 图片。';
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
  busy.value = true;
  error.value = '';
  try {
    const message = await sendMessage(props.group.id, text.value, image.value ?? undefined);
    text.value = '';
    removeImage();
    if (messageInput.value) messageInput.value.style.height = '42px';
    appendMessages([message], true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '消息发送失败';
  } finally {
    busy.value = false;
  }
}

function senderName(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.nickname : message.senderNickname;
}

function senderAvatar(message: ChatMessage) {
  return message.senderUserId === props.user.id ? props.user.avatar : members.value.get(message.senderUserId)?.avatar ?? '';
}

function formatTime(value: string) {
  return messageTimeFormatter.format(new Date(value));
}

function localDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startsNewDate(message: ChatMessage, index: number) {
  return index === 0 || localDateKey(messages.value[index - 1].createdAt) !== localDateKey(message.createdAt);
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
  atBottom = isAtBottom();
}

onMounted(() => {
  void refresh(true);
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refresh();
  }, 2000);
  window.addEventListener('focus', refreshOnFocus);
});
onScopeDispose(() => {
  request?.abort();
  if (timer) clearInterval(timer);
  window.removeEventListener('focus', refreshOnFocus);
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
});
</script>

<template>
  <section class="chat-panel" :aria-label="`${group.name}群聊`" @dragover.prevent @drop="handleDrop">
    <div class="chat-heading"><MessageSquareText :size="15" /><span>群聊</span></div>
    <div ref="list" class="message-list" @scroll="onScroll">
      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="startsNewDate(message, index)" class="chat-date-divider"><span>{{ formatDate(message.createdAt) }}</span></div>
        <article class="chat-message" :class="{ 'is-own': message.senderUserId === user.id }">
          <img v-if="senderAvatar(message)" class="chat-message-avatar" :src="senderAvatar(message)" alt="" />
          <span v-else class="chat-message-avatar chat-message-initial">{{ senderName(message).slice(0, 1) }}</span>
          <div class="chat-message-body">
            <div class="chat-message-meta"><strong>{{ senderName(message) }}</strong><time>{{ formatTime(message.createdAt) }}</time></div>
            <p v-if="message.content" class="chat-message-content"><template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex"><a v-if="segment.href" class="chat-message-link" :href="segment.href" @click.prevent="openLink(segment.href)">{{ segment.text }}</a><template v-else>{{ segment.text }}</template></template></p>
            <ChatImage v-if="message.attachment" :group-id="group.id" :attachment-id="message.attachment.id" :alt="`${senderName(message)} 发送的图片`" />
          </div>
        </article>
      </template>
    </div>
    <form class="composer" @submit.prevent="submit">
      <input ref="fileInput" type="file" hidden accept="image/png,image/jpeg" @change="chooseOriginal" />
      <button type="button" aria-label="选择原图" :disabled="busy" @click="fileInput?.click()"><Plus :size="16" /></button>
      <div class="composer-content">
        <div v-if="image" class="composer-image-preview"><img :src="imagePreview" alt="待发送图片" /><span>{{ imageMode === 'optimized' ? '已压缩' : '原图' }}</span><button type="button" aria-label="移除待发送图片" @click="removeImage"><X :size="13" /></button></div>
        <textarea ref="messageInput" v-model="text" aria-label="消息内容" maxlength="2000" rows="1" :disabled="busy" placeholder="发送消息" @input="resizeMessageInput" @keydown="handleKeydown" @paste="handlePaste" />
      </div>
      <button type="submit" aria-label="发送消息" :disabled="!canSend"><Send :size="15" /></button>
    </form>
    <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
  </section>
</template>

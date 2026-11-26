<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Download, Music2, X } from '@lucide/vue';
import { desktopMediaUrl, fetchAttachment, fetchFilePreview, fetchCompatibleVideo, videoPreviewStatus, type ChatAttachment } from '../chat/chatApi';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { CHAT_TRANSFERS } from '../chat/useChatTransfers';
import { chatMediaFormat, formatAttachmentSize, CHAT_IMAGE_CACHE_LIMIT } from '../chat/chatMedia';
import { useLoadingHint } from './useLoadingHint';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';
import MediaVideoSurface from './MediaVideoSurface.vue';
import ChatImageSurface from './ChatImageSurface.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; imageMessage: boolean; previewBlob?: Blob; thumbnail?: boolean; localSource?: string; inlineLoading?: boolean }>();
const emit = defineEmits<{ close: []; progress: [percent: number]; ready: [] }>();
const format = computed(() => chatMediaFormat(props.attachment));
const title = computed(() => props.attachment.fileName || '图片');
const source = ref('');
const error = ref('');
const previewFailed = ref(false);
const loading = ref(false);
const transfers = inject(CHAT_TRANSFERS)!;
const cache = inject(ACCOUNT_CACHE, null);
const downloadTask = computed(() => transfers.downloads.get(props.attachment.id));
const downloading = computed(() => Boolean(downloadTask.value?.controller));
const converting = ref(false);
const compatible = ref(false);
const conversionStatus = ref('');
const conversionHint = useLoadingHint(() => converting.value);
const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const player = ref<HTMLMediaElement | null>(null);
const loadingHint = useLoadingHint(() => loading.value);
const backdropEvents = useBackdropDismiss(close);
let request: AbortController | undefined;
let conversionRequest: AbortController | undefined;
let originalVideoCache: { revision: number; pending?: Blob } | undefined;
let disposed = false;
const original = ref<{ url: string; width: number; height: number }>();
const originalPercent = ref<number>();
const originalError = ref('');
let originalTask: Promise<void> | undefined;
let originalRequest: AbortController | undefined;

async function readOriginal(signal: AbortSignal, cachedOnly: boolean) {
  const attachment = props.attachment;
  const key = props.imageMessage ? attachment.id : 'file:' + attachment.id;
  const revision = cache?.revision;
  let url = '';
  let cached: Blob | null = null;
  try {
    cached = await cache?.read<Blob>('image', props.groupId, key) ?? null;
    if (signal.aborted || (!cached && cachedOnly)) return;
    const progress = (bytes: number) => {
      if (!signal.aborted && attachment.byteSize > 0) originalPercent.value = Math.min(99, Math.floor(bytes * 100 / attachment.byteSize));
    };
    const blob = cached ?? await (props.imageMessage ? fetchAttachment : fetchFilePreview)(props.groupId, attachment.id, signal, progress);
    if (signal.aborted) return;
    url = URL.createObjectURL(blob.slice(0, blob.size, format.value?.contentType || blob.type));
    const image = new Image();
    image.src = url;
    await image.decode();
    if (signal.aborted) return;
    original.value = { url, width: image.naturalWidth, height: image.naturalHeight };
    url = '';
    if (!cached && blob.size <= CHAT_IMAGE_CACHE_LIMIT && cache?.revision === revision) void cache?.write('image', props.groupId, blob, key);
  } catch {
    if (signal.aborted) return;
    if (cached) await cache?.discard('image', props.groupId, key);
    if (!cachedOnly) originalError.value = '原图加载失败，点击 HD 重试';
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function loadOriginal(cachedOnly = false) {
  if (disposed || original.value) return;
  if (!cachedOnly && originalTask) return originalTask;
  originalRequest?.abort();
  const controller = originalRequest = new AbortController();
  originalError.value = '';
  if (!cachedOnly) originalPercent.value = 0;
  const task = readOriginal(controller.signal, cachedOnly).finally(() => {
    if (originalRequest === controller) { originalPercent.value = undefined; originalTask = undefined; }
  });
  if (!cachedOnly) originalTask = task;
  return task;
}

function release() {
  originalRequest?.abort();
  if (original.value) URL.revokeObjectURL(original.value.url);
  original.value = undefined;
  originalVideoCache = undefined;
  player.value?.pause();
  player.value?.removeAttribute('src');
  player.value?.load();
  if (source.value.startsWith('blob:') && source.value !== props.localSource) URL.revokeObjectURL(source.value);
  source.value = '';
}

function close() {
  disposed = true;
  request?.abort();
  conversionRequest?.abort();
  release();
  emit('close');
}

async function load(refresh = false) {
  if (disposed) return;
  request?.abort();
  conversionRequest?.abort();
  compatible.value = false;
  const current = request = new AbortController();
  const retrying = previewFailed.value && Boolean(source.value);
  release();
  error.value = '';
  previewFailed.value = false;
  loading.value = true;
  try {
    if (retrying) await nextTick();
    if (current.signal.aborted || disposed) return;
    if (props.localSource) { source.value = props.localSource; return; }
    const streamUrl = format.value?.kind === 'video' || format.value?.kind === 'audio'
      ? desktopMediaUrl(props.groupId, props.attachment.id) : null;
    if (streamUrl) { source.value = streamUrl; return; }
    const smallVideo = cache && format.value?.kind === 'video' && props.attachment.byteSize > 0
      && props.attachment.byteSize <= 8 * 1024 * 1024;
    const revision = cache?.revision;
    const cached = smallVideo && !refresh ? await cache.read<Blob>('video', props.groupId, props.attachment.id) : null;
    if (current.signal.aborted || disposed) return;
    const blob = (smallVideo && refresh ? null : props.previewBlob) ?? cached ?? (props.imageMessage
      ? await fetchAttachment(props.groupId, props.attachment.id, current.signal)
      : await fetchFilePreview(props.groupId, props.attachment.id, current.signal, props.inlineLoading
        ? bytes => { if (!current.signal.aborted) emit('progress', Math.min(99, Math.floor(bytes * 100 / (props.attachment.byteSize || 1)))); }
        : undefined));
    if (disposed || current.signal.aborted || request !== current) return;
    if (smallVideo && revision !== undefined && cache.revision === revision && (cached || blob.size === props.attachment.byteSize)) {
      originalVideoCache = { revision, pending: cached ? undefined : blob };
    }
    source.value = URL.createObjectURL(blob.slice(0, blob.size, props.thumbnail ? blob.type : format.value?.contentType || blob.type));
    if (props.thumbnail) void loadOriginal(true);
  } catch (reason) {
    if (!current.signal.aborted && !disposed) {
      error.value = reason instanceof Error ? reason.message : '无法加载文件，请重试。';
      emit('ready');
    }
  } finally {
    if (request === current) loading.value = false;
  }
}

function videoPlayable() {
  if (disposed || previewFailed.value) return;
  const entry = originalVideoCache;
  if (entry?.pending && cache?.revision === entry.revision) {
    void cache.write('video', props.groupId, entry.pending, props.attachment.id);
    entry.pending = undefined;
  }
  emit('ready');
}

async function convertVideo() {
  if (converting.value || disposed) return;
  const current = conversionRequest = new AbortController();
  converting.value = true;
  conversionStatus.value = '正在准备播放…';
  error.value = '';
  try {
    let status = await videoPreviewStatus(props.groupId, props.attachment.id, true, current.signal);
    if (disposed || current.signal.aborted || conversionRequest !== current) return;
    const deadline = Date.now() + 330_000;
    while (status.status === 'processing') {
      if (Date.now() > deadline) throw new Error('视频仍在转换，请稍后重新打开。');
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(current.signal.reason); };
        const timer = setTimeout(() => { current.signal.removeEventListener('abort', cancel); resolve(); }, 1000);
        current.signal.addEventListener('abort', cancel, { once: true });
        if (current.signal.aborted) cancel();
      });
      status = await videoPreviewStatus(props.groupId, props.attachment.id, false, current.signal);
      if (disposed || current.signal.aborted || conversionRequest !== current) return;
    }
    if (status.status !== 'ready') throw new Error(status.message || '兼容预览已清理，请重新转换。');
    conversionStatus.value = '正在加载视频…';
    const url = desktopMediaUrl(props.groupId, props.attachment.id, true);
    const blob = url ? null : await fetchCompatibleVideo(props.groupId, props.attachment.id, current.signal);
    if (disposed || current.signal.aborted || conversionRequest !== current) return;
    release();
    compatible.value = true;
    previewFailed.value = false;
    source.value = url || URL.createObjectURL(blob!);
  } catch {
    if (!disposed && !current.signal.aborted) error.value = '暂时无法播放，可重试或下载后打开。';
  } finally {
    if (conversionRequest === current) converting.value = false;
  }
}

let savingImage = false;
async function download() {
  if (downloading.value) return;
  if (props.imageMessage) {
    if (!source.value || savingImage) return;
    if (props.thumbnail) {
      savingImage = true;
      try { await loadOriginal(); } finally { savingImage = false; }
      if (!original.value || disposed) return;
    }
    const link = document.createElement('a');
    link.href = original.value?.url ?? source.value;
    link.download = props.attachment.fileName || `图片.${props.attachment.contentType === 'image/png' ? 'png' : 'jpg'}`;
    link.click();
    return;
  }
  await transfers.download(props.groupId, props.attachment);
}

function playbackFailed(code?: number | Event) {
  if (!disposed) {
    const entry = originalVideoCache;
    originalVideoCache = undefined;
    if (entry && !entry.pending && cache?.revision === entry.revision && code !== 2) {
      void cache.discard('video', props.groupId, props.attachment.id);
    }
    emit('ready');
    previewFailed.value = true;
    if (props.localSource) { error.value = '此文件暂时无法在应用中预览，仍可作为附件发送。'; return; }
    if (code === 2) { error.value = '视频加载中断，请重试。'; return; }
    if (format.value?.kind === 'video' && !compatible.value) { void convertVideo(); return; }
    error.value = '这个文件暂时无法预览，可以下载后打开。';
  }
}
watch(() => props.inlineLoading, async (waiting, previous) => {
  if (!waiting && previous) { await nextTick(); dialog.value?.focus({ preventScroll: true }); }
});
onMounted(() => { closeButton.value?.focus(); void load(); });
onScopeDispose(() => {
  disposed = true;
  request?.abort();
  conversionRequest?.abort();
  release();
});
</script>

<template>
  <div v-show="!inlineLoading" class="dialog-backdrop chat-media-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="chat-media-viewer" :class="{ 'media-viewer-shell': format?.kind === 'image' || format?.kind === 'video' }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header v-if="format?.kind === 'audio' || !source || (previewFailed && format?.kind === 'image')">
        <strong id="chat-media-title" :title="title">{{ title }}</strong>
        <button ref="closeButton" type="button" aria-label="关闭查看器" title="关闭查看器" @click="close"><X :size="18" /></button>
      </header>
      <div class="chat-media-stage" :aria-busy="loading">
        <ChatImageSurface v-if="source && format?.kind === 'image' && !previewFailed" :source="source" :title="title" :downloadable="!localSource"
          :original-label="thumbnail ? '查看原图 · ' + formatAttachmentSize(attachment.byteSize) : undefined" :original="original"
          :percent="originalPercent" :original-error="originalError" @original-request="loadOriginal()" @close="close" @download="download" @error="playbackFailed" />
        <MediaVideoSurface v-else-if="source && format?.kind === 'video'" :key="source" :source="source" :downloadable="!localSource" :downloading="downloading"
          :buffer-for-preview="inlineLoading" @buffered="percent => { if (!source.startsWith('blob:')) emit('progress', percent); }" @playable="videoPlayable" @close="close" @download="download" @error="playbackFailed" />
        <div v-else-if="source && format?.kind === 'audio'" class="chat-media-audio">
          <Music2 :size="64" aria-hidden="true" />
          <audio ref="player" :src="source" controls preload="metadata" tabindex="0" @error="playbackFailed" />
        </div>
        <span v-else-if="loadingHint" role="status">正在加载…</span>
      </div>
      <div v-if="!localSource && (format?.kind === 'audio' || !source || (previewFailed && format?.kind === 'image'))" class="media-fallback-tools">
        <button type="button" aria-label="下载文件" title="下载文件" :disabled="downloading || (imageMessage && !source)" @click="download"><Download :size="20" /></button>
      </div>
      <footer v-if="error || downloadTask?.error || conversionHint" class="chat-media-feedback">
        <span v-if="error || downloadTask?.error" role="alert">{{ error || downloadTask?.error }}</span>
        <span v-else-if="conversionHint" class="conversion-status" role="status">{{ conversionStatus }}</span>
        <button v-if="error && !localSource && !converting" type="button" @click="load(true)">重试</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.chat-media-viewer { display: flex; flex-direction: column; width: min(1100px, calc(100vw - 48px)); height: min(780px, calc(100dvh - 48px)); min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.chat-media-viewer header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.chat-media-viewer header strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.chat-media-viewer header button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted); }
.chat-media-viewer header button:hover { background: var(--panel-raised); color: var(--text); }
.chat-media-stage { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 0; overflow: auto; background: var(--background); color: var(--muted); }
.chat-media-viewer.media-viewer-shell { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0; background: transparent; }
.chat-media-viewer.media-viewer-shell .chat-media-stage { background: transparent; }
.chat-media-viewer.media-viewer-shell .chat-media-feedback { position: absolute; z-index: 2; bottom: 76px; align-self: center; max-width: calc(100vw - 48px); border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
.chat-media-audio { display: grid; justify-items: center; gap: 28px; width: min(440px, 90%); }
.chat-media-audio audio { width: 100%; }
.media-fallback-tools { display: flex; justify-content: center; padding: 12px; }
.media-fallback-tools button { display: grid; place-items: center; width: 42px; height: 42px; padding: 0; }
.chat-media-feedback { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border); color: var(--danger); font-size: 13px; }
.conversion-status { color: var(--muted); }
.chat-media-feedback button { flex-shrink: 0; }
</style>

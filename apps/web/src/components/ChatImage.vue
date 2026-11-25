<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref, watch } from 'vue';
import { chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { Download } from '@lucide/vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import { fetchAttachment, fetchChatThumbnail, fetchFilePreview } from '../chat/chatApi';
import { ApiRequestError } from '../auth/authApi';

const props = defineProps<{ groupId: string; attachmentId: string; width: number; height: number; byteSize: number; alt: string; fileContentType?: string }>();
const emit = defineEmits<{ preview: [blob: Blob]; unpreviewable: [] }>();
const cache = inject(ACCOUNT_CACHE, null);
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const thumbnail = ref(false);
const error = ref('');
const loaded = ref<number | null>(null);
const frameStyle = computed(() => chatMediaFrameStyle(props.width, props.height));
const cacheId = computed(() => props.fileContentType ? `file:${props.attachmentId}` : props.attachmentId);
let activeUrl = '';
let activeBlob: Blob | undefined;
let controller: AbortController | null = null;
let observer: IntersectionObserver | null = null;
let retentionObserver: IntersectionObserver | null = null;
let prefetchVisible = false;
let nearby = true;
let disposed = false;
let cachedSource = false;
const originalCacheLimit = 32 * 1024 * 1024;
const originalAction = computed(() => props.byteSize > originalCacheLimit ? '临时查看原图' : '加载原图');
let previewState: 'ready' | 'retryOnEntry' | 'unavailable' = 'ready';
let transientFailures = 0;
let openedOriginal = false;

function clearSource() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = '';
  activeBlob = undefined;
  source.value = '';
  thumbnail.value = false;
}

async function load(skipCache = false, previewOnly = false) {
  if (disposed) return;
  if (!previewOnly) openedOriginal = true;
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  error.value = '';
  loaded.value = previewOnly ? null : 0;
  const cacheRevision = cache?.revision;
  const current = () => !currentController.signal.aborted && controller === currentController;
  try {
    const groupId = props.groupId;
    const attachmentId = props.attachmentId;
    const fileType = props.fileContentType;
    const originalKey = cacheId.value;
    const cached = cache && !skipCache ? await cache.read<Blob>('image', groupId, originalKey) : null;
    if (!current()) return;
    let blob = cached;
    const isThumbnail = !(cached instanceof Blob) && previewOnly;
    if (isThumbnail) {
      blob = cache ? await cache.read<Blob>('image', groupId, `thumb:${originalKey}`) : null;
      if (!current()) return;
      if (!(blob instanceof Blob)) {
        blob = await fetchChatThumbnail(groupId, attachmentId, currentController.signal, fileType ? 'file' : 'image');
        if (current() && !blob) previewState = 'unavailable';
        if (current() && blob && cache?.revision === cacheRevision) void cache?.write('image', groupId, blob, `thumb:${originalKey}`);
      }
    } else if (!(blob instanceof Blob)) {
      const progress = (bytes: number) => { if (current()) loaded.value = bytes; };
      blob = fileType ? await fetchFilePreview(groupId, attachmentId, currentController.signal, progress)
        : await fetchAttachment(groupId, attachmentId, currentController.signal, progress);
      if (fileType) blob = blob.slice(0, blob.size, fileType);
      if (current() && blob.size <= originalCacheLimit && cache?.revision === cacheRevision) {
        void cache?.write('image', groupId, blob, originalKey);
      }
    }
    if (!current() || !(blob instanceof Blob)) return;
    previewState = 'ready';
    transientFailures = 0;
    clearSource();
    cachedSource = cached instanceof Blob;
    thumbnail.value = isThumbnail;
    activeUrl = URL.createObjectURL(blob);
    if (!isThumbnail) activeBlob = blob;
    source.value = activeUrl;
  } catch (reason) {
    if (!current()) return;
    if (previewOnly) {
      const transient = !(reason instanceof ApiRequestError) || reason.status === 408 || reason.status === 429 || reason.status >= 500;
      transientFailures++;
      previewState = transient && transientFailures === 1 ? 'retryOnEntry' : 'unavailable';
    } else {
      error.value = reason instanceof Error ? reason.message : '图片加载失败';
    }
  } finally {
    if (controller === currentController) { controller = null; loaded.value = null; }
  }
}

function openImage() {
  if (activeBlob) emit('preview', activeBlob);
  else void load();
}

async function imageFailed(failedSource?: string) {
  if (failedSource && failedSource !== activeUrl) return;
  const wasThumbnail = thumbnail.value;
  if (wasThumbnail) previewState = 'unavailable';
  const retry = cachedSource;
  cachedSource = false;
  clearSource();
  if (!wasThumbnail && (openedOriginal || !retry)) error.value = '图片加载失败';
  const groupId = props.groupId;
  const key = cacheId.value;
  await cache?.discard('image', groupId, wasThumbnail ? `thumb:${key}` : key);
  if (disposed || controller || source.value || groupId !== props.groupId || key !== cacheId.value || wasThumbnail) return;
  if (retry && (openedOriginal || nearby)) await load(true, !openedOriginal);
  else if (props.fileContentType) emit('unpreviewable');
}

function observeFrame() {
  if (disposed || !frame.value) return;
  observer?.disconnect();
  retentionObserver?.disconnect();
  prefetchVisible = false;
  nearby = true;
  const currentObserver = new IntersectionObserver((entries) => {
    // disconnect 不撤回已排队的回调；旧观察器不能重开请求或断开新的观察器。
    if (disposed || observer !== currentObserver) return;
    const visible = entries.at(-1)?.isIntersecting === true;
    if (visible && !prefetchVisible && previewState === 'retryOnEntry') previewState = 'ready';
    prefetchVisible = visible;
    loadIfNeeded();
  }, { root: frame.value.closest('.message-list'), rootMargin: '180px 0px' });
  const currentRetentionObserver = new IntersectionObserver((entries) => {
    if (disposed || retentionObserver !== currentRetentionObserver) return;
    nearby = entries.at(-1)?.isIntersecting === true;
    if (nearby) { loadIfNeeded(); return; }
    // 保留邻近图片避免滚动抖动；远离视口后解除 Blob 和图片引用，不改变消息尺寸。
    controller?.abort();
    controller = null;
    loaded.value = null;
    clearSource();
  }, { root: frame.value.closest('.message-list'), rootMargin: '1200px 0px' });
  observer = currentObserver;
  retentionObserver = currentRetentionObserver;
  currentObserver.observe(frame.value);
  currentRetentionObserver.observe(frame.value);
}

function loadIfNeeded() {
  if (nearby && prefetchVisible && !source.value && !controller && !error.value && previewState === 'ready') void load(false, true);
}

watch(() => [props.groupId, props.attachmentId, props.fileContentType], () => {
  observer?.disconnect();
  observer = null;
  retentionObserver?.disconnect();
  retentionObserver = null;
  controller?.abort();
  controller = null;
  previewState = 'ready';
  transientFailures = 0;
  openedOriginal = false;
  clearSource();
  error.value = '';
  loaded.value = null;
  observeFrame();
});
onMounted(observeFrame);
onScopeDispose(() => {
  disposed = true;
  observer?.disconnect();
  observer = null;
  retentionObserver?.disconnect();
  retentionObserver = null;
  controller?.abort();
  clearSource();
});
</script>

<template>
  <div ref="frame" class="chat-image-frame" :style="frameStyle">
    <span v-if="!source" class="chat-media-placeholder" aria-hidden="true" />
    <button type="button" class="chat-image-open" :aria-label="source && !thumbnail ? '查看图片' : originalAction"
      :disabled="loaded !== null || !!error" @click="openImage">
      <img v-if="source" :key="source" class="chat-image" :src="source" :alt="alt" @error="imageFailed(($event.currentTarget as HTMLImageElement).src)" />
      <span v-if="(!source || thumbnail) && loaded === null && !error" class="chat-media-play chat-image-download"
        :class="{ 'chat-image-temporary': byteSize > originalCacheLimit }"><template v-if="byteSize > originalCacheLimit">{{ originalAction }}</template><Download v-else :size="20" /></span>
    </button>
    <ChatMediaProgress v-if="loaded !== null" :percent="byteSize ? Math.min(99, Math.floor(100 * loaded / byteSize)) : undefined" label="原图加载进度"><Download :size="20" /></ChatMediaProgress>
    <button v-else-if="error" class="chat-image-error" type="button" @click="load(true)">图片加载失败，点击重试</button>
  </div>
</template>

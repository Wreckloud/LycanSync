<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref, watch } from 'vue';
import { chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import { fetchAttachment } from '../chat/chatApi';

const props = defineProps<{ groupId: string; attachmentId: string; width: number; height: number; alt: string; fileName?: string }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const cache = inject(ACCOUNT_CACHE, null);
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const error = ref('');
const frameStyle = computed(() => chatMediaFrameStyle(props.width, props.height));
let activeUrl = '';
let activeBlob: Blob | undefined;
let controller: AbortController | null = null;
let observer: IntersectionObserver | null = null;
let retentionObserver: IntersectionObserver | null = null;
let prefetchVisible = false;
let nearby = true;
let disposed = false;
let cachedSource = false;

function clearSource() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = '';
  activeBlob = undefined;
  source.value = '';
}

async function load(skipCache = false) {
  if (disposed) return;
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  clearSource();
  error.value = '';
  cachedSource = false;
  const cacheRevision = cache?.revision;
  try {
    const groupId = props.groupId;
    const attachmentId = props.attachmentId;
    const cached = cache && !skipCache ? await cache.read<Blob>('image', groupId, attachmentId) : null;
    if (currentController.signal.aborted || controller !== currentController) return;
    const blob = cached instanceof Blob ? cached : await fetchAttachment(groupId, attachmentId, currentController.signal);
    if (currentController.signal.aborted || controller !== currentController) return;
    cachedSource = cached instanceof Blob;
    if (!cachedSource && cache?.revision === cacheRevision) void cache?.write('image', groupId, blob, attachmentId);
    activeUrl = URL.createObjectURL(blob);
    activeBlob = blob;
    source.value = activeUrl;
  } catch (reason) {
    if (!currentController.signal.aborted && controller === currentController) {
      error.value = reason instanceof Error ? reason.message : '图片加载失败';
    }
  } finally {
    if (controller === currentController) controller = null;
  }
}

async function imageFailed() {
  const retry = cachedSource;
  cachedSource = false;
  clearSource();
  error.value = '图片加载失败';
  const groupId = props.groupId;
  const attachmentId = props.attachmentId;
  await cache?.discard('image', groupId, attachmentId);
  if (retry && !disposed && groupId === props.groupId && attachmentId === props.attachmentId) await load(true);
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
    prefetchVisible = entries.some((entry) => entry.isIntersecting);
    loadIfNeeded();
  }, { root: frame.value.closest('.message-list'), rootMargin: '180px 0px' });
  const currentRetentionObserver = new IntersectionObserver((entries) => {
    if (disposed || retentionObserver !== currentRetentionObserver) return;
    nearby = entries.some((entry) => entry.isIntersecting);
    if (nearby) { loadIfNeeded(); return; }
    // 保留邻近图片避免滚动抖动；远离视口后解除 Blob 和图片引用，不改变消息尺寸。
    controller?.abort();
    controller = null;
    clearSource();
  }, { root: frame.value.closest('.message-list'), rootMargin: '1200px 0px' });
  observer = currentObserver;
  retentionObserver = currentRetentionObserver;
  currentObserver.observe(frame.value);
  currentRetentionObserver.observe(frame.value);
}

function loadIfNeeded() {
  if (nearby && prefetchVisible && !source.value && !controller && !error.value) void load();
}

watch(() => [props.groupId, props.attachmentId], () => {
  observer?.disconnect();
  observer = null;
  retentionObserver?.disconnect();
  retentionObserver = null;
  controller?.abort();
  controller = null;
  clearSource();
  error.value = '';
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
    <button v-if="source" type="button" class="chat-image-open" aria-label="查看图片" @click="emit('preview', activeBlob)"><img class="chat-image" :src="source" :alt="alt" @error="imageFailed" /></button>
    <button v-else-if="error" class="chat-image-error" type="button" @click="load(true)">图片加载失败，点击重试</button>
  </div>
  <button v-if="fileName" type="button" class="chat-media-name" :aria-label="`预览 ${fileName}`" @click="emit('preview', activeBlob)">{{ fileName }}</button>
</template>

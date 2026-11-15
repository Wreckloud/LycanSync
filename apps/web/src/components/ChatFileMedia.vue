<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { Maximize2 } from '@lucide/vue';
import { fetchFilePreview, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';
import ChatFileCard from './ChatFileCard.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const format = computed(() => chatMediaFormat(props.attachment));
const frame = ref<HTMLElement | null>(null);
const player = ref<HTMLMediaElement | null>(null);
const source = ref('');
const dimensions = ref({ width: 420, height: 236.25 });
const frameStyle = computed(() => format.value?.kind === 'audio' ? undefined : chatMediaFrameStyle(dimensions.value.width, dimensions.value.height));
const failed = ref(false);
const loadingFailed = ref(false);
let blob: Blob | undefined;
let controller: AbortController | undefined;
let observer: IntersectionObserver | undefined;
let visibilityObserver: IntersectionObserver | undefined;
let disposed = false;

function release() {
  controller?.abort(); controller = undefined;
  player.value?.pause(); player.value?.removeAttribute('src'); player.value?.load();
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = ''; blob = undefined;
}
async function load() {
  if (disposed || source.value || controller || failed.value || !format.value) return;
  const request = controller = new AbortController();
  loadingFailed.value = false;
  try {
    const fetched = await fetchFilePreview(props.groupId, props.attachment.id, request.signal);
    if (disposed || request.signal.aborted || controller !== request) return;
    blob = fetched.slice(0, fetched.size, format.value.contentType);
    source.value = URL.createObjectURL(blob);
  } catch {
    if (!disposed && !request.signal.aborted) loadingFailed.value = true;
  } finally { if (controller === request) controller = undefined; }
}
function decodeFailed() { failed.value = true; release(); }
function showFirstFrame() {
  const video = player.value as HTMLVideoElement | null;
  if (video?.videoWidth && video.videoHeight) dimensions.value = { width: video.videoWidth, height: video.videoHeight };
  if (video && Number.isFinite(video.duration) && video.duration > 0.01) video.currentTime = Math.min(0.1, video.duration / 2);
}
function imageLoaded(event: Event) {
  const image = event.target as HTMLImageElement;
  dimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
}
onMounted(() => {
  if (!frame.value || !format.value) return;
  observer = new IntersectionObserver(entries => {
    if (disposed) return;
    if (entries.some(entry => entry.isIntersecting)) { if (!loadingFailed.value) void load(); }
    else release();
  }, { root: frame.value.closest('.message-list'), rootMargin: '240px 0px' });
  visibilityObserver = new IntersectionObserver(entries => {
    if (!disposed && !entries.some(entry => entry.isIntersecting)) player.value?.pause();
  }, { root: frame.value.closest('.message-list') });
  observer.observe(frame.value); visibilityObserver.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); visibilityObserver?.disconnect(); release(); });
</script>

<template>
  <div ref="frame" class="chat-file-media">
    <ChatFileCard v-if="!format || failed" :group-id="groupId" :attachment="attachment" :preview-disabled="failed" />
    <template v-else>
      <div class="chat-inline-media" :style="frameStyle" :class="{ 'is-audio': format.kind === 'audio' }">
        <button v-if="source && format.kind === 'image'" class="chat-inline-image" type="button" aria-label="查看图片" @click="emit('preview', blob)">
          <img :src="source" :alt="attachment.fileName" @load="imageLoaded" @error="decodeFailed" />
        </button>
        <video v-else-if="source && format.kind === 'video'" ref="player" :src="source" muted playsinline preload="metadata" @loadedmetadata="showFirstFrame" @click="emit('preview', blob)" @error="decodeFailed" />
        <audio v-else-if="source && format.kind === 'audio'" ref="player" :src="source" controls preload="metadata" @error="decodeFailed" />
        <button v-else-if="loadingFailed" class="chat-media-retry" type="button" @click="load">预览加载失败，点击重试</button>
        <button v-if="source && format.kind === 'video'" class="chat-media-expand" type="button" title="放大观看" aria-label="放大观看" @click="player?.pause(); emit('preview', blob)"><Maximize2 :size="16" /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-file-media { width: min(420px, 100%); }
.chat-inline-media { position: relative; width: 100%; margin-top: 6px; overflow: hidden; border-radius: 8px; background: var(--panel-soft); }
.chat-inline-image { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; }
.chat-inline-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
.chat-inline-media video { display: block; width: 100%; height: 100%; object-fit: contain; cursor: pointer; }
.chat-inline-media.is-audio { display: grid; align-items: center; min-height: 64px; padding: 8px; }
.chat-inline-media audio { width: 100%; }
.chat-media-expand { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; background: #10161dcc; color: #fff; border-radius: 5px; }
.chat-media-retry { display: block; width: 100%; min-height: 100px; border: 0; background: transparent; color: var(--muted); }
</style>

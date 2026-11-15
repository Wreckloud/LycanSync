<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { Maximize2 } from '@lucide/vue';
import { fetchFilePreview, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat } from '../chat/chatMedia';
import ChatFileCard from './ChatFileCard.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const format = computed(() => chatMediaFormat(props.attachment));
const frame = ref<HTMLElement | null>(null);
const player = ref<HTMLMediaElement | null>(null);
const source = ref('');
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
  const video = player.value;
  if (video && Number.isFinite(video.duration) && video.duration > 0.01) video.currentTime = Math.min(0.1, video.duration / 2);
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
      <div class="chat-inline-media" :class="{ 'is-audio': format.kind === 'audio' }">
        <button v-if="source && format.kind === 'image'" class="chat-inline-image" type="button" aria-label="查看图片" @click="emit('preview', blob)">
          <img :src="source" :alt="attachment.fileName" @error="decodeFailed" />
        </button>
        <video v-else-if="source && format.kind === 'video'" ref="player" :src="source" controls playsinline preload="metadata" @loadedmetadata="showFirstFrame" @error="decodeFailed" />
        <audio v-else-if="source && format.kind === 'audio'" ref="player" :src="source" controls preload="metadata" @error="decodeFailed" />
        <button v-else-if="loadingFailed" class="chat-media-retry" type="button" @click="load">预览加载失败，点击重试</button>
        <button v-if="source && format.kind === 'video'" class="chat-media-expand" type="button" title="放大观看" aria-label="放大观看" @click="player?.pause(); emit('preview', blob)"><Maximize2 :size="16" /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-file-media { width: min(420px, 100%); }
.chat-inline-media { position: relative; width: 100%; min-height: 100px; margin-top: 6px; overflow: hidden; border-radius: 8px; background: var(--panel-soft); }
.chat-inline-media:has(> video), .chat-inline-media:empty { aspect-ratio: 16 / 9; }
.chat-inline-image { display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.chat-inline-image img { display: block; max-width: 100%; max-height: 340px; margin: auto; }
.chat-inline-media video { display: block; width: 100%; height: 100%; max-height: 340px; }
.chat-inline-media.is-audio { display: grid; align-items: center; min-height: 64px; padding: 8px; }
.chat-inline-media audio { width: 100%; }
.chat-media-expand { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; background: #10161dcc; color: #fff; border-radius: 5px; opacity: 0; }
.chat-inline-media:hover .chat-media-expand, .chat-media-expand:focus-visible { opacity: 1; }
.chat-media-retry { display: block; width: 100%; min-height: 100px; border: 0; background: transparent; color: var(--muted); }
</style>

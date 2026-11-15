<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue';
import { Play } from '@lucide/vue';
import { fetchFilePreview, fetchVideoThumbnail, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import ChatFileCard from './ChatFileCard.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const cache = inject(ACCOUNT_CACHE, null);
const format = computed(() => chatMediaFormat(props.attachment));
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const dimensions = ref({ width: 420, height: 236.25 });
const frameStyle = computed(() => chatMediaFrameStyle(dimensions.value.width, dimensions.value.height));
const failed = ref(false);
const loadingFailed = ref(false);
const cacheId = computed(() => `${format.value?.kind === 'video' ? 'cover' : 'file'}:${props.attachment.id}`);
let blob: Blob | undefined;
let controller: AbortController | undefined;
let observer: IntersectionObserver | undefined;
let disposed = false;

function release() {
  controller?.abort(); controller = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = ''; blob = undefined;
}
async function load() {
  if (disposed || source.value || controller || failed.value || !format.value || format.value.kind === 'audio') return;
  const request = controller = new AbortController();
  loadingFailed.value = false;
  const revision = cache?.revision;
  try {
    const cached = cache ? await cache.read<Blob>('image', props.groupId, cacheId.value) : null;
    if (disposed || request.signal.aborted || controller !== request) return;
    const fetched = cached instanceof Blob ? cached : format.value.kind === 'video'
      ? await fetchVideoThumbnail(props.groupId, props.attachment.id, request.signal)
      : await fetchFilePreview(props.groupId, props.attachment.id, request.signal);
    if (disposed || request.signal.aborted || controller !== request) return;
    if (!fetched) { failed.value = true; return; }
    blob = fetched.slice(0, fetched.size, format.value.kind === 'video' ? 'image/jpeg' : format.value.contentType);
    source.value = URL.createObjectURL(blob);
    // 封面与小动图共用现有账号缓存，整段音视频不写入聊天缓存。
    if (!(cached instanceof Blob) && fetched.size <= 8 * 1024 * 1024 && cache?.revision === revision) {
      void cache?.write('image', props.groupId, blob, cacheId.value);
    }
  } catch {
    if (!disposed && !request.signal.aborted && controller === request) loadingFailed.value = true;
  } finally { if (controller === request) controller = undefined; }
}
function decodeFailed() {
  failed.value = true;
  release();
  void cache?.discard('image', props.groupId, cacheId.value);
}
function imageLoaded(event: Event) {
  const image = event.target as HTMLImageElement;
  dimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
}
onMounted(() => {
  if (!frame.value || !format.value || format.value.kind === 'audio') return;
  observer = new IntersectionObserver(entries => {
    if (disposed) return;
    if (entries.some(entry => entry.isIntersecting)) { if (!loadingFailed.value) void load(); }
    else release();
  }, { root: frame.value.closest('.message-list'), rootMargin: '240px 0px' });
  observer.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); release(); });
</script>

<template>
  <div ref="frame" class="chat-file-media">
    <ChatFileCard v-if="!format || format.kind === 'audio' || failed || (format.kind === 'video' && loadingFailed)"
      :group-id="groupId" :attachment="attachment" :preview-disabled="failed && format?.kind === 'image'" @preview="emit('preview')" />
    <div v-else class="chat-inline-media" :style="frameStyle">
      <button v-if="format.kind === 'video'" class="chat-inline-image" type="button" aria-label="播放视频" @click="emit('preview')">
        <img v-if="source" :src="source" alt="" @load="imageLoaded" @error="decodeFailed" />
        <span class="chat-media-play"><Play :size="24" fill="currentColor" /></span>
      </button>
      <button v-else-if="source" class="chat-inline-image" type="button" aria-label="查看图片" @click="emit('preview', blob)">
        <img :src="source" :alt="attachment.fileName" @load="imageLoaded" @error="decodeFailed" />
      </button>
      <button v-else-if="loadingFailed" class="chat-media-retry" type="button" @click="load">预览加载失败，点击重试</button>
    </div>
  </div>
</template>

<style scoped>
.chat-file-media { width: min(420px, 100%); }
.chat-inline-media { position: relative; width: 100%; margin-top: 6px; overflow: hidden; border-radius: 8px; background: var(--panel-soft); }
.chat-inline-image { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; }
.chat-inline-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
.chat-media-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: grid; place-items: center; width: 48px; height: 48px; padding-left: 3px; background: #10161dcc; color: #fff; border-radius: 50%; }
.chat-inline-image:hover .chat-media-play { background: #252e39ee; }
.chat-media-retry { display: block; width: 100%; min-height: 100px; border: 0; background: transparent; color: var(--muted); }
</style>

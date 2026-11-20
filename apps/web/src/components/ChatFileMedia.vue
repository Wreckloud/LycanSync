<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue';
import RecordingThumbnail from './settings/RecordingThumbnail.vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import { Download, Play } from '@lucide/vue';
import { fetchFilePreview, fetchVideoThumbnail, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import ChatFileCard from './ChatFileCard.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; pending?: boolean; localPreview?: string; videoLoading?: boolean; videoPercent?: number }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const cache = inject(ACCOUNT_CACHE, null);
const format = computed(() => chatMediaFormat(props.attachment));
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const frameStyle = computed(() => chatMediaFrameStyle(props.attachment.width ?? 420, props.attachment.height ?? 236.25));
const failed = ref(false);
const loadingFailed = ref(false);
const loaded = ref<number | null>(null);
const imagePercent = computed(() => loaded.value !== null && props.attachment.byteSize
  ? Math.min(99, Math.floor(100 * loaded.value / props.attachment.byteSize)) : undefined);
const cacheId = computed(() => `${format.value?.kind === 'video' ? 'cover' : 'file'}:${props.attachment.id}`);
let blob: Blob | undefined;
let controller: AbortController | undefined;
let observer: IntersectionObserver | undefined;
let disposed = false;

function release() {
  controller?.abort(); controller = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = ''; blob = undefined; loaded.value = null;
}
async function load(cacheOnly = false) {
  if (props.pending && (props.localPreview || format.value?.kind !== 'video')) return;
  if (disposed || source.value || controller || failed.value || !format.value || format.value.kind === 'audio') return;
  const request = controller = new AbortController();
  loadingFailed.value = false;
  const revision = cache?.revision;
  try {
    const cached = cache && !props.pending ? await cache.read<Blob>('image', props.groupId, cacheId.value) : null;
    if (disposed || request.signal.aborted || controller !== request) return;
    if (cacheOnly && !(cached instanceof Blob)) return;
    if (!(cached instanceof Blob) && format.value.kind === 'image') loaded.value = 0;
    const fetched = cached instanceof Blob ? cached : format.value.kind === 'video'
      ? await fetchVideoThumbnail(props.groupId, props.attachment.id, request.signal, props.pending)
      : await fetchFilePreview(props.groupId, props.attachment.id, request.signal, bytes => { if (controller === request) loaded.value = bytes; });
    if (disposed || request.signal.aborted || controller !== request) return;
    if (!fetched) { failed.value = true; return; }
    blob = fetched.slice(0, fetched.size, format.value.kind === 'video' ? 'image/jpeg' : format.value.contentType);
    source.value = URL.createObjectURL(blob);
    // 封面与小动图共用现有账号缓存，整段音视频不写入聊天缓存。
    if (!props.pending && !(cached instanceof Blob) && fetched.size <= 8 * 1024 * 1024 && cache?.revision === revision) {
      void cache?.write('image', props.groupId, blob, cacheId.value);
    }
  } catch {
    if (!disposed && !request.signal.aborted && controller === request) loadingFailed.value = true;
  } finally { if (controller === request) { controller = undefined; loaded.value = null; } }
}
function decodeFailed() {
  failed.value = true;
  release();
  void cache?.discard('image', props.groupId, cacheId.value);
}
function openPreview() {
  if (format.value?.kind === 'image' && !blob) {
    if (loaded.value === null) { release(); void load(); }
    return;
  }
  emit('preview', format.value?.kind === 'image' ? blob : undefined);
}
onMounted(() => {
  if (!frame.value || !format.value || format.value.kind === 'audio') return;
  observer = new IntersectionObserver(entries => {
    if (disposed) return;
    if (entries.some(entry => entry.isIntersecting)) { if (!loadingFailed.value) void load(format.value?.kind === 'image'); }
    else release();
  }, { root: frame.value.closest('.message-list'), rootMargin: '240px 0px' });
  observer.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); release(); });
</script>

<template>
  <div ref="frame" class="chat-file-media">
    <div v-if="pending" class="chat-inline-media" :style="frameStyle" :aria-label="attachment.fileName">
      <RecordingThumbnail v-if="localPreview && format?.kind === 'video'" :source="localPreview" :disabled="false">
        <span class="chat-media-placeholder" aria-hidden="true" />
      </RecordingThumbnail>
      <img v-else-if="localPreview || source" :src="localPreview || source" alt="" />
      <span v-else class="chat-media-placeholder" aria-hidden="true" />
      <slot />
    </div>
    <ChatFileCard v-else-if="!format || format.kind === 'audio' || (failed && format.kind === 'image')"
      :group-id="groupId" :attachment="attachment" :preview-disabled="failed && format?.kind === 'image'" @preview="openPreview" />
    <div v-else class="chat-inline-media" :style="frameStyle">
      <button class="chat-inline-image" type="button" :aria-label="videoLoading ? '取消加载视频' : format.kind === 'video' ? '播放视频' : source ? '查看图片' : '加载图片'" @click="openPreview">
        <img v-if="source" :src="source" :alt="format.kind === 'image' ? attachment.fileName : ''" @error="decodeFailed" />
        <span v-else class="chat-media-placeholder" aria-hidden="true" />
        <ChatMediaProgress v-if="videoLoading || loaded !== null" :percent="videoLoading ? videoPercent : imagePercent" label="媒体加载进度"><Download :size="20" /></ChatMediaProgress>
        <span v-else-if="format.kind === 'video' || !source" class="chat-media-play"><component :is="format.kind === 'video' ? Play : Download" :size="24" /></span>
      </button>
      <button v-if="loadingFailed && !videoLoading" class="chat-cover-retry" type="button" @click="load()">{{ format.kind === 'video' ? '封面' : '图片' }}加载失败，点击重试</button>
    </div>
  </div>
</template>

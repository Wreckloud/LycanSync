<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue';
import RecordingThumbnail from './settings/RecordingThumbnail.vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import { Download, Play, RotateCcw } from '@lucide/vue';
import { fetchChatThumbnail, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import ChatFileCard from './ChatFileCard.vue';
import ChatImage from './ChatImage.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; pending?: boolean; localPreview?: string; videoLoading?: boolean; videoPercent?: number }>();
const emit = defineEmits<{ preview: [blob?: Blob] }>();
const cache = inject(ACCOUNT_CACHE, null);
const format = computed(() => chatMediaFormat(props.attachment));
const canLoadCover = computed(() => format.value?.kind === 'video'
  || (props.pending && !props.localPreview && format.value?.kind === 'image'));
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const frameStyle = computed(() => chatMediaFrameStyle(props.attachment.width ?? 420, props.attachment.height ?? 236.25));
const failed = ref(false);
const loadingFailed = ref(false);
const cacheId = computed(() => `cover:${props.attachment.id}`);
let controller: AbortController | undefined;
let observer: IntersectionObserver | undefined;
let disposed = false;
let pendingMiss = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function release() {
  clearTimeout(retryTimer); retryTimer = undefined;
  controller?.abort(); controller = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}
async function load() {
  if (props.pending && props.localPreview) return;
  if (disposed || source.value || controller || retryTimer !== undefined || failed.value || !canLoadCover.value) return;
  const request = controller = new AbortController();
  loadingFailed.value = false;
  const revision = cache?.revision;
  try {
    const cached = cache && !props.pending ? await cache.read<Blob>('image', props.groupId, cacheId.value) : null;
    if (disposed || request.signal.aborted || controller !== request) return;
    const fetched = cached instanceof Blob ? cached
      : await fetchChatThumbnail(props.groupId, props.attachment.id, request.signal, 'file', props.pending);
    if (disposed || request.signal.aborted || controller !== request) return;
    if (!fetched) {
      // 上传登记可能先于临时封面到达。离屏会取消定时器，完成消息使用正式封面。
      if (props.pending && props.attachment.transferStatus !== 'FAILED' && !pendingMiss) {
        pendingMiss = true;
        retryTimer = setTimeout(() => { retryTimer = undefined; void load(); }, 500);
      } else failed.value = true;
      return;
    }
    const blob = fetched.slice(0, fetched.size, 'image/jpeg');
    source.value = URL.createObjectURL(blob);
    // 列表只缓存封面与小图，正片在用户打开后读取。
    if (!props.pending && !(cached instanceof Blob) && fetched.size <= 8 * 1024 * 1024 && cache?.revision === revision) {
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
onMounted(() => {
  if (!frame.value || !canLoadCover.value) return;
  observer = new IntersectionObserver(entries => {
    if (disposed) return;
    if (entries.at(-1)?.isIntersecting) { if (!loadingFailed.value) void load(); }
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
    <ChatImage v-else-if="format?.kind === 'image' && !failed" :group-id="groupId" :attachment-id="attachment.id"
      :width="attachment.width ?? 420" :height="attachment.height ?? 236.25" :byte-size="attachment.byteSize"
      :alt="attachment.fileName || '图片'" :file-content-type="format.contentType"
      @preview="emit('preview', $event)" @unpreviewable="failed = true" />
    <ChatFileCard v-else-if="!format || format.kind === 'audio' || failed || (format.kind === 'video' && loadingFailed)"
      :group-id="groupId" :attachment="attachment" :preview-disabled="failed && format?.kind === 'image'" @preview="emit('preview')">
      <button v-if="format?.kind === 'video' && loadingFailed && !failed && !videoLoading" type="button"
        aria-label="重试视频封面" title="重试视频封面" @click="load()"><RotateCcw :size="15" /></button>
      <progress v-if="videoLoading" max="100" :value="videoPercent" aria-label="视频加载进度" />
    </ChatFileCard>
    <div v-else class="chat-inline-media" :style="frameStyle">
      <button class="chat-inline-image" type="button" :aria-label="videoLoading ? '取消加载视频' : '播放视频'" @click="emit('preview')">
        <img v-if="source" :src="source" alt="" @error="decodeFailed" />
        <span v-else class="chat-media-placeholder" aria-hidden="true" />
        <ChatMediaProgress v-if="videoLoading" :percent="videoPercent" label="媒体加载进度"><Download :size="20" /></ChatMediaProgress>
        <span v-else class="chat-media-play"><Play :size="24" /></span>
      </button>
    </div>
  </div>
</template>

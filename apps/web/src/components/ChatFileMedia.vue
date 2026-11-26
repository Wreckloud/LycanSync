<script setup lang="ts">
import AppProgress from './AppProgress.vue';
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue';
import RecordingThumbnail from './settings/RecordingThumbnail.vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import { Download, Play } from '@lucide/vue';
import { ApiRequestError } from '../auth/authApi';
import { fetchChatThumbnail, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat, chatMediaFrameStyle } from '../chat/chatMedia';
import { ACCOUNT_CACHE } from '../cache/localCache';
import ChatFileCard from './ChatFileCard.vue';
import ChatImage from './ChatImage.vue';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; pending?: boolean; localPreview?: string; videoLoading?: boolean; videoPercent?: number }>();
const emit = defineEmits<{ preview: [blob?: Blob, thumbnail?: boolean] }>();
const cache = inject(ACCOUNT_CACHE, null);
const format = computed(() => chatMediaFormat(props.attachment));
const canLoadCover = computed(() => format.value?.kind === 'video'
  || (props.pending && !props.localPreview && format.value?.kind === 'image'));
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const frameStyle = computed(() => chatMediaFrameStyle(props.attachment.width ?? 420, props.attachment.height ?? 236.25));
const coverState = ref<'ready' | 'retry' | 'unavailable'>('ready');
const cacheId = computed(() => `cover:${props.attachment.id}`);
let controller: AbortController | undefined;
let observer: IntersectionObserver | undefined;
let disposed = false;
let pendingMiss = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const retryDelays = [2000, 8000];
let retries = 0;
let inRange = false;

function release() {
  clearTimeout(retryTimer); retryTimer = undefined;
  if (controller && coverState.value === 'retry' && retries >= retryDelays.length) {
    coverState.value = 'unavailable';
    stopObserving();
  }
  controller?.abort(); controller = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}
async function load() {
  if (props.pending && props.localPreview) return;
  if (disposed || source.value || controller || retryTimer !== undefined || coverState.value === 'unavailable' || !canLoadCover.value) return;
  const request = controller = new AbortController();
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
      } else coverState.value = 'unavailable';
      return;
    }
    const blob = fetched.slice(0, fetched.size, 'image/jpeg');
    source.value = URL.createObjectURL(blob);
    if (coverState.value === 'retry') {
      coverState.value = 'ready';
      retries = 0;
      observeCover();
    }
    // 列表只缓存封面与小图，正片在用户打开后读取。
    if (!props.pending && !(cached instanceof Blob) && fetched.size <= 8 * 1024 * 1024 && cache?.revision === revision) {
      void cache?.write('image', props.groupId, blob, cacheId.value);
    }
  } catch (reason) {
    if (disposed || request.signal.aborted || controller !== request) return;
    const transient = !(reason instanceof ApiRequestError) || reason.status === 408 || reason.status === 429 || reason.status >= 500;
    if (props.pending || !transient || retries >= retryDelays.length) coverState.value = 'unavailable';
    else if (coverState.value !== 'retry') {
      coverState.value = 'retry';
      observeCover();
    }
  } finally {
    if (controller === request) {
      controller = undefined;
      if (coverState.value === 'unavailable') stopObserving();
      else if (coverState.value === 'retry') refreshCover();
    }
  }
}
function decodeFailed() {
  coverState.value = 'unavailable';
  stopObserving();
  release();
  void cache?.discard('image', props.groupId, cacheId.value);
}
function refreshCover() {
  if (disposed || !inRange) return;
  if (document.hidden) { if (!source.value) release(); return; }
  if (source.value || coverState.value === 'unavailable' || controller || retryTimer !== undefined) return;
  if (coverState.value !== 'retry') { void load(); return; }
  const delay = retryDelays[retries];
  if (delay === undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!inRange || disposed || document.hidden) return;
    // 已发起的补试计入额度，滚出再滚回也不能反复启动同一请求。
    retries++;
    void load();
  }, delay + Math.random() * 500);
}

function stopObserving() {
  observer?.disconnect();
  observer = undefined;
  document.removeEventListener('visibilitychange', refreshCover);
  inRange = false;
}
function observeCover() {
  if (!frame.value || !canLoadCover.value) return;
  stopObserving();
  const current = new IntersectionObserver(entries => {
    if (disposed || observer !== current) return;
    inRange = entries.at(-1)?.isIntersecting === true;
    if (inRange) {
      document.addEventListener('visibilitychange', refreshCover);
      refreshCover();
    } else {
      document.removeEventListener('visibilitychange', refreshCover);
      release();
    }
  }, { root: frame.value.closest('.message-list'), rootMargin: coverState.value === 'retry' ? '0px' : '240px 0px' });
  observer = current;
  current.observe(frame.value);
}
onMounted(observeCover);
onScopeDispose(() => {
  disposed = true;
  stopObserving();
  release();
});
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
    <ChatImage v-else-if="format?.kind === 'image' && coverState !== 'unavailable'" :group-id="groupId" :attachment-id="attachment.id"
      :width="attachment.width ?? 420" :height="attachment.height ?? 236.25" :byte-size="attachment.byteSize"
      :alt="attachment.fileName || '图片'" :file-content-type="format.contentType"
      @preview="(blob, thumbnail) => emit('preview', blob, thumbnail)" @unpreviewable="coverState = 'unavailable'" />
    <ChatFileCard v-else-if="!format || format.kind === 'audio' || coverState !== 'ready'"
      :group-id="groupId" :attachment="attachment" :preview-disabled="coverState === 'unavailable' && format?.kind === 'image'" @preview="emit('preview')">
      <AppProgress v-if="videoLoading" :percent="videoPercent" label="视频加载进度" />
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

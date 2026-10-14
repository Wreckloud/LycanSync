<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { fetchAttachment } from '../chat/chatApi';

const props = defineProps<{ groupId: string; attachmentId: string; width: number; height: number; alt: string }>();
const frame = ref<HTMLElement | null>(null);
const source = ref('');
const error = ref('');
const frameStyle = computed(() => ({
  width: `min(100%, 420px, ${Math.min(props.width, 340 * props.width / props.height)}px)`,
  aspectRatio: `${props.width} / ${props.height}`,
}));
let activeUrl = '';
let controller: AbortController | null = null;
let observer: IntersectionObserver | null = null;
let disposed = false;

function clearSource() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = '';
  source.value = '';
}

async function load() {
  if (disposed) return;
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  clearSource();
  error.value = '';
  try {
    const blob = await fetchAttachment(props.groupId, props.attachmentId, currentController.signal);
    if (currentController.signal.aborted || controller !== currentController) return;
    activeUrl = URL.createObjectURL(blob);
    source.value = activeUrl;
  } catch (reason) {
    if (!currentController.signal.aborted && controller === currentController) {
      error.value = reason instanceof Error ? reason.message : '图片加载失败';
    }
  } finally {
    if (controller === currentController) controller = null;
  }
}

function observeFrame() {
  if (disposed || !frame.value) return;
  observer?.disconnect();
  const currentObserver = new IntersectionObserver((entries) => {
    // disconnect 不撤回已排队的回调；旧观察器不能重开请求或断开新的观察器。
    if (disposed || observer !== currentObserver || !entries.some((entry) => entry.isIntersecting)) return;
    currentObserver.disconnect();
    observer = null;
    void load();
  }, { root: frame.value.closest('.message-list'), rootMargin: '180px 0px' });
  observer = currentObserver;
  currentObserver.observe(frame.value);
}

watch(() => [props.groupId, props.attachmentId], () => {
  observer?.disconnect();
  observer = null;
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
  controller?.abort();
  clearSource();
});
</script>

<template>
  <div ref="frame" class="chat-image-frame" :style="frameStyle">
    <img v-if="source" class="chat-image" :src="source" :alt="alt" />
    <button v-else-if="error" class="chat-image-error" type="button" @click="load">图片加载失败，点击重试</button>
  </div>
</template>

<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { fetchAttachment } from '../chat/chatApi';

const props = defineProps<{ groupId: string; attachmentId: string; alt: string }>();
const source = ref('');
const error = ref('');
let activeUrl = '';
let controller: AbortController | null = null;

function clearSource() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = '';
  source.value = '';
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  clearSource();
  error.value = '';
  try {
    const blob = await fetchAttachment(props.groupId, props.attachmentId, controller.signal);
    if (controller.signal.aborted) return;
    activeUrl = URL.createObjectURL(blob);
    source.value = activeUrl;
  } catch (reason) {
    if (!controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '图片加载失败';
  }
}

watch(() => [props.groupId, props.attachmentId], () => void load(), { immediate: true });
onScopeDispose(() => { controller?.abort(); clearSource(); });
</script>

<template>
  <img v-if="source" class="chat-image" :src="source" :alt="alt" />
  <p v-else-if="error" class="chat-image-error" role="status">{{ error }}</p>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { Download, Eye, X } from '@lucide/vue';
import { downloadFile, type ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat } from '../chat/chatMedia';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; previewDisabled?: boolean }>();
const emit = defineEmits<{ preview: [] }>();
const previewable = computed(() => !props.previewDisabled && Boolean(chatMediaFormat(props.attachment)));
const controller = ref<AbortController | null>(null);
const loadedBytes = ref(0);
const error = ref('');
const downloading = ref(false);
const progress = () => props.attachment.byteSize > 0
  ? Math.min(100, Math.floor(loadedBytes.value / props.attachment.byteSize * 100)) : 0;

async function download() {
  if (downloading.value) return;
  const current = new AbortController();
  controller.value = current;
  downloading.value = true;
  loadedBytes.value = 0;
  error.value = '';
  try {
    await downloadFile(props.groupId, props.attachment, current.signal, (loaded) => { loadedBytes.value = loaded; });
  } catch (reason) {
    if (!current.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError')) {
      error.value = reason instanceof Error ? reason.message : '文件下载失败';
    }
  } finally {
    if (controller.value === current) controller.value = null;
    downloading.value = false;
  }
}

function cancel() {
  controller.value?.abort();
}

onScopeDispose(cancel);
</script>

<template>
  <div class="chat-file-card">
    <div class="chat-file-icon" aria-hidden="true"><Download :size="17" /></div>
    <div class="chat-file-details">
      <strong>{{ attachment.fileName }}</strong>
      <small>{{ (attachment.byteSize / 1024 / 1024).toFixed(2) }} MB</small>
      <small v-if="previewDisabled">无法预览，可下载后打开</small>
      <progress v-if="downloading" :value="progress()" max="100" aria-label="文件下载进度" />
      <small v-if="error" class="chat-file-error" role="alert">{{ error }}</small>
    </div>
    <button v-if="previewable" type="button" aria-label="预览文件" title="预览文件" @click="emit('preview')"><Eye :size="16" /></button>
    <button v-if="downloading" type="button" aria-label="取消文件下载" @click="cancel"><X :size="15" /></button>
    <button v-else type="button" :aria-label="error ? '重试文件下载' : '下载文件'" @click="download"><Download :size="15" /></button>
  </div>
</template>

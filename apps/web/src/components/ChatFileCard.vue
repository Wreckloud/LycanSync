<script setup lang="ts">
import { computed, inject } from 'vue';
import { Download, Eye, X } from '@lucide/vue';
import { CHAT_TRANSFERS } from '../chat/useChatTransfers';
import type { ChatAttachment } from '../chat/chatApi';
import { chatMediaFormat } from '../chat/chatMedia';

const props = defineProps<{ groupId: string; attachment: ChatAttachment; previewDisabled?: boolean }>();
const emit = defineEmits<{ preview: [] }>();
const previewable = computed(() => !props.previewDisabled && Boolean(chatMediaFormat(props.attachment)));
const transfers = inject(CHAT_TRANSFERS)!;
const task = computed(() => transfers.downloads.get(props.attachment.id));
const downloading = computed(() => Boolean(task.value?.controller));
const error = computed(() => task.value?.error ?? '');
function progress() {
  return props.attachment.byteSize ? Math.floor((task.value?.loaded ?? 0) * 100 / props.attachment.byteSize) : 0;
}
function download() { return transfers.download(props.groupId, props.attachment); }
function cancel() { task.value?.controller?.abort(); }
</script>

<template>
  <div class="chat-file-card">
    <component :is="previewable ? 'button' : 'div'" class="chat-file-summary" :type="previewable ? 'button' : undefined"
      :aria-label="previewable ? `预览 ${attachment.fileName || '文件'}` : undefined" @click="previewable && emit('preview')">
      <span class="chat-file-icon" aria-hidden="true"><component :is="previewable ? Eye : Download" :size="17" /></span>
      <span class="chat-file-details">
        <strong>{{ attachment.fileName }}</strong>
        <small>{{ (attachment.byteSize / 1024 / 1024).toFixed(2) }} MB</small>
        <small v-if="previewDisabled">无法预览，可下载后打开</small>
        <progress v-if="downloading" :value="progress()" max="100" aria-label="文件下载进度" />
        <small v-if="error" class="chat-file-error" role="alert">{{ error }}</small>
      </span>
    </component>
    <button v-if="downloading" type="button" aria-label="取消文件下载" @click="cancel"><X :size="15" /></button>
    <button v-else type="button" :aria-label="error ? '重试文件下载' : '下载文件'" @click="download"><Download :size="15" /></button>
  </div>
</template>

<script setup lang="ts">
import AppProgress from './AppProgress.vue';
import { computed } from 'vue';
import { RotateCcw, X } from '@lucide/vue';
import { chatMediaFormat, formatAttachmentSize } from '../chat/chatMedia';
import ChatFileMedia from './ChatFileMedia.vue';
import ChatFileCard from './ChatFileCard.vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import type { ChatMessage } from '../chat/chatApi';
import type { Outgoing } from '../chat/useChatTransfers';
import { useLoadingHint } from './useLoadingHint';

const props = defineProps<{ groupId: string; message: ChatMessage; job?: Outgoing }>();
defineEmits<{ retry: [job: Outgoing]; dismiss: [job: Outgoing] }>();
const kind = computed(() => props.message.type === 'IMAGE' ? 'image' : props.message.attachment && chatMediaFormat(props.message.attachment)?.kind);
const visual = computed(() => kind.value === 'video' || kind.value === 'image');
const sendingText = useLoadingHint(() => !props.message.attachment && Boolean(props.job && props.job.state !== 'failed'));
const uploaded = computed(() => props.job?.state === 'sending' && props.job.item
  && props.job.progress >= props.job.item.file.size);
const percent = computed(() => props.job?.state === 'sending' && props.job.item?.file.size && !uploaded.value
  ? Math.floor(100 * props.job.progress / props.job.item.file.size) : undefined);
const statusText = computed(() => {
  if (!props.job) return props.message.attachment?.transferStatus === 'FAILED' ? '上传未完成' : '文件上传中…';
  if (props.job?.error) return props.job.error;
  if (uploaded.value) return props.job?.item?.optimizeVideo ? '正在处理视频…' : '等待发送确认…';
  if (percent.value !== undefined) return visual.value && props.job.item
    ? `${formatAttachmentSize(props.job.progress)} / ${formatAttachmentSize(props.job.item.file.size)}`
    : `正在上传 ${percent.value}%`;
  return '发送中…';
});
</script>

<template>
  <ChatFileCard v-if="message.attachment && !visual" :group-id="groupId" :attachment="message.attachment" pending>
    <template #status>
      <small :class="{ 'chat-file-error': job?.error }" :role="job?.error ? 'alert' : 'status'">{{ statusText }}</small>
    </template>
    <template #actions>
      <template v-if="job?.state === 'failed'">
        <button type="button" aria-label="重试" title="重试上传" @click="$emit('retry', job)"><RotateCcw :size="15" /></button>
        <button type="button" aria-label="关闭" title="关闭" @click="$emit('dismiss', job)"><X :size="15" /></button>
      </template>
      <button v-else-if="job?.item?.kind === 'FILE'" type="button" aria-label="取消上传" title="取消上传" @click="job.controller.abort()"><X :size="15" /></button>
    </template>
    <AppProgress v-if="job ? job.state !== 'failed' : message.attachment.transferStatus !== 'FAILED'"
      :percent="percent" :label="uploaded ? statusText : '文件上传进度'" />
  </ChatFileCard>
  <template v-else-if="visual && message.attachment">
    <ChatFileMedia class="chat-transfer-media" :group-id="groupId" :attachment="message.attachment" pending :local-preview="job?.item?.previewUrl">
      <button v-if="job?.state === 'failed'" type="button" class="chat-inline-image chat-media-retry-overlay" aria-label="重试上传" @click="$emit('retry', job)">
        <span class="chat-media-play"><RotateCcw :size="20" /></span>
      </button>
      <ChatMediaProgress v-else-if="message.attachment?.transferStatus !== 'FAILED' || job"
        :percent="percent" :label="uploaded ? statusText : '文件上传进度'" />
      <div v-if="job?.state !== 'failed'" class="chat-media-transfer-footer">
        <small :role="percent === undefined ? 'status' : undefined">{{ statusText }}</small>
        <button v-if="job?.item" type="button" aria-label="取消发送" title="取消发送" @click="job.controller.abort()"><X :size="17" /></button>
      </div>
    </ChatFileMedia>
  </template>
  <div v-if="job?.state === 'failed' && (visual || !message.attachment)" class="chat-transfer-state">
    <small role="alert">{{ statusText }}</small>
    <button v-if="!visual" type="button" class="chat-retry" @click="$emit('retry', job)">重试</button>
    <button type="button" class="chat-retry" @click="$emit('dismiss', job)">关闭</button>
  </div>
  <small v-else-if="sendingText" class="chat-send-pending" role="status">发送中</small>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Download, FileWarning, Upload, RotateCcw, X } from '@lucide/vue';
import { chatMediaFormat } from '../chat/chatMedia';
import ChatFileMedia from './ChatFileMedia.vue';
import ChatFileCard from './ChatFileCard.vue';
import ChatMediaProgress from './ChatMediaProgress.vue';
import type { ChatMessage } from '../chat/chatApi';
import type { Outgoing } from '../chat/useChatTransfers';

const props = defineProps<{ groupId: string; message: ChatMessage; job?: Outgoing }>();
defineEmits<{ retry: [job: Outgoing]; dismiss: [job: Outgoing] }>();
const kind = computed(() => props.message.type === 'IMAGE' ? 'image' : props.message.attachment && chatMediaFormat(props.message.attachment)?.kind);
const visual = computed(() => kind.value === 'video' || kind.value === 'image');
const uploaded = computed(() => props.job?.state === 'sending' && props.job.item
  && props.job.progress >= props.job.item.file.size);
const percent = computed(() => props.job?.state === 'sending' && props.job.item?.file.size && !uploaded.value
  ? Math.floor(100 * props.job.progress / props.job.item.file.size) : undefined);
const statusText = computed(() => {
  if (!props.job) return props.message.attachment?.transferStatus === 'FAILED' ? '上传未完成' : '文件上传中…';
  if (props.job?.error) return props.job.error;
  if (uploaded.value) return props.job?.item?.optimizeVideo ? '正在处理视频…' : '等待发送确认…';
  if (percent.value !== undefined) return `正在上传 ${percent.value}%`;
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
    <progress v-if="job ? job.state !== 'failed' : message.attachment.transferStatus !== 'FAILED'"
      :value="percent" max="100" :aria-label="uploaded ? statusText : '文件上传进度'" />
  </ChatFileCard>
  <div v-else :class="{ 'chat-transfer-media': visual }">
    <ChatFileMedia v-if="visual && message.attachment" :group-id="groupId" :attachment="message.attachment" pending :local-preview="job?.item?.previewUrl">
      <button v-if="job?.state === 'failed'" type="button" class="chat-inline-image chat-media-retry-overlay" aria-label="重试上传" @click="$emit('retry', job)">
        <span class="chat-media-play"><RotateCcw :size="20" /></span>
      </button>
      <ChatMediaProgress v-else-if="message.attachment?.transferStatus !== 'FAILED' || job"
        :percent="percent" :label="uploaded ? statusText : '文件上传进度'"><component :is="job ? Upload : Download" :size="20" /></ChatMediaProgress>
      <span v-else class="chat-media-play" aria-hidden="true"><FileWarning :size="20" /></span>
    </ChatFileMedia>
    <div class="chat-transfer-state">
      <template v-if="job">
        <small :role="job.error ? 'alert' : 'status'">{{ statusText }}</small>
        <template v-if="job.state === 'failed'">
          <button v-if="!visual" type="button" class="chat-retry" @click="$emit('retry', job)">重试</button>
          <button type="button" class="chat-retry" @click="$emit('dismiss', job)">关闭</button>
        </template>
        <button v-else-if="job.item?.kind === 'FILE'" type="button" class="chat-retry" @click="job.controller.abort()">取消上传</button>
      </template>
      <small v-else>{{ statusText }}</small>
    </div>
  </div>
</template>

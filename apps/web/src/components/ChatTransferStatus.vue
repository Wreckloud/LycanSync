<script setup lang="ts">
import type { ChatMessage } from '../chat/chatApi';
import type { Outgoing } from '../chat/useChatTransfers';

defineProps<{ message: ChatMessage; job?: Outgoing }>();
defineEmits<{ retry: [job: Outgoing]; dismiss: [job: Outgoing] }>();
</script>

<template>
  <div class="chat-transfer-state">
    <strong v-if="message.attachment">{{ message.attachment.fileName }}</strong>
    <template v-if="job">
      <progress v-if="job.state === 'sending' && job.item" :value="job.progress" :max="job.item.file.size || 1" aria-label="文件上传进度" />
      <small :role="job.error ? 'alert' : 'status'">{{ job.error || (job.state === 'sending' ? '正在上传' : '发送中…') }}</small>
      <template v-if="job.state === 'failed'">
        <button type="button" class="chat-retry" @click="$emit('retry', job)">重试</button>
        <button type="button" class="chat-retry" @click="$emit('dismiss', job)">关闭</button>
      </template>
      <button v-else-if="job.item?.kind === 'FILE'" type="button" class="chat-retry" @click="job.controller.abort()">取消上传</button>
    </template>
    <small v-else>{{ message.attachment?.transferStatus === 'FAILED' ? '上传未完成' : '文件上传中…' }}</small>
  </div>
</template>

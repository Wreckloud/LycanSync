<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { GroupSummary } from '../../group/groupApi';
import type { useRecordingShare } from '../../recording/useRecordingShare';
import InlineFeedback from '../InlineFeedback.vue';
import RecordingThumbnail from './RecordingThumbnail.vue';
import { keepDialogFocus } from '../dialogFocus';
const dialog = ref<HTMLElement | null>(null);
onMounted(() => dialog.value?.focus());
defineProps<{ share: ReturnType<typeof useRecordingShare>; groups: GroupSummary[] }>();
</script>

<template>
  <div class="dialog-backdrop" @keydown.esc.stop="share.visible.value = false">
    <section ref="dialog" class="recording-share-dialog" role="dialog" aria-modal="true" aria-label="分享到群聊" tabindex="-1" @keydown="keepDialogFocus">
      <h2>分享到群聊</h2>
      <div v-if="share.entry.value" class="share-recording">
        <RecordingThumbnail passive :disabled="false" :source="`lycan://app/recordings/${share.entry.value.id}`" />
        <span>{{ share.entry.value.applicationName || '录像' }}<small v-if="share.entry.value.durationMs">{{ Math.round(share.entry.value.durationMs / 1000) }} 秒</small></span>
      </div>
      <label>发送到<select v-model="share.groupId.value" :disabled="share.busy.value" @change="share.resetUpload">
        <option value="" disabled>选择群聊</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
      </select></label>
      <textarea v-model="share.content.value" :disabled="share.busy.value" maxlength="2000" placeholder="添加留言（选填）" @input="share.resetUpload" />
      <InlineFeedback :message="share.error.value" :pending="share.busy.value ? `正在发送 ${share.progress.value}%…` : ''" />
      <footer class="card-actions">
        <button @click="share.visible.value = false">{{ share.busy.value ? '后台继续' : '取消' }}</button>
        <button v-if="share.busy.value" @click="share.cancel">取消上传</button>
        <button v-else class="confirm-button" :disabled="!share.groupId.value" @click="share.send">发送</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.recording-share-dialog { width: min(480px, calc(100vw - 32px)); padding: 24px; display: grid; gap: 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
h2 { margin: 0; } label { display: grid; gap: 8px; } select, textarea { width: 100%; box-sizing: border-box; } textarea { min-height: 64px; resize: vertical; }
.share-recording { display: flex; gap: 16px; align-items: center; } small { display: block; color: var(--muted); margin-top: 6px; }
</style>

<script lang="ts">
export interface ReceivedReport { id: string; nickname: string; uploadedAt: string; byteSize: number }
</script>

<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import { ApiRequestError, authenticatedFetch, readApiError } from '../../auth/authApi';
import InlineFeedback from '../InlineFeedback.vue';

defineProps<{ entries: ReceivedReport[] | null; loading: boolean; readError: string }>();
const emit = defineEmits<{ refresh: []; denied: [message: string] }>();
const receiving = ref('');
const feedback = ref('');
const error = ref('');
const lifetime = new AbortController();

async function receive(entry: ReceivedReport) {
  if (receiving.value) return;
  receiving.value = entry.id;
  error.value = feedback.value = '';
  try {
    if (window.lycanDesktop) {
      const path = await window.lycanDesktop.receiveDiagnosticReport(entry.id, entry.byteSize);
      feedback.value = '已保存至 ' + path;
    } else {
      const response = await authenticatedFetch('/api/diagnostics/reports/' + entry.id, { signal: lifetime.signal });
      if (!response.ok) throw await readApiError(response);
      const file = await response.blob();
      if (file.size !== entry.byteSize) throw new Error('报告未完整下载，请重试。');
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url; link.download = 'LycanSync-diagnostics-' + entry.id + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      feedback.value = '报告已交给浏览器下载。';
    }
  } catch (reason) {
    if (lifetime.signal.aborted) return;
    if (reason instanceof ApiRequestError && (reason.status === 401 || reason.status === 403)) emit('denied', reason.message);
    else error.value = reason instanceof Error ? reason.message : '接收日志失败，请重试。';
  } finally { receiving.value = ''; }
}
onScopeDispose(() => lifetime.abort());
</script>

<template>
  <section class="settings-block">
    <div class="settings-action-row">
      <h2>收到的日志</h2>
      <button type="button" class="settings-button" :aria-busy="loading" @click="error = ''; emit('refresh')">刷新</button>
    </div>
    <small>每位成员保留最近 3 份，全服最多 32 份。</small>
    <p v-if="entries?.length === 0">还没有成员上传日志。</p>
    <div v-for="entry in entries" :key="entry.id" class="settings-action-row">
      <div><strong>{{ entry.nickname }}</strong><small>{{ new Date(entry.uploadedAt).toLocaleString() }} · {{ (entry.byteSize / 1048576).toFixed(1) }} MiB</small></div>
      <button type="button" class="settings-button" :disabled="!!receiving" @click="receive(entry)">{{ receiving === entry.id ? '接收中…' : '接收日志' }}</button>
    </div>
    <small v-if="feedback" role="status" class="received-path">{{ feedback }}</small>
    <InlineFeedback :message="error || readError" :pending="loading && entries === null ? '正在读取日志…' : ''" />
  </section>
</template>

<style scoped>
.received-path { overflow-wrap: anywhere; user-select: text; }
</style>

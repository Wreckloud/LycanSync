<script lang="ts">
export interface ReceivedReport { id: string; userId?: string; nickname: string; uploadedAt: string; byteSize: number; savedPath?: string | null }
</script>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { FolderOpen } from '@lucide/vue';
import { ApiRequestError, authenticatedFetch, readApiError } from '../../auth/authApi';
import { formatAttachmentSize } from '../../chat/chatMedia';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ entries: ReceivedReport[] | null; loading: boolean; readError: string }>();
const emit = defineEmits<{ denied: [message: string] }>();
const desktop = window.lycanDesktop;
const receiving = ref('');
const received = reactive(new Map<string, string>());
const failures = reactive(new Map<string, string>());
const revealError = ref('');
const feedback = ref('');
const lifetime = new AbortController();
const members = computed(() => {
  const byUser = new Map<string, { nickname: string; days: Map<string, ReceivedReport[]> }>();
  for (const entry of props.entries ?? []) {
    const key = entry.userId ?? entry.nickname;
    const member = byUser.get(key) ?? { nickname: entry.nickname, days: new Map<string, ReceivedReport[]>() };
    const day = new Date(entry.uploadedAt).toLocaleDateString();
    if (!member.days.has(day)) member.days.set(day, []);
    member.days.get(day)!.push(entry);
    byUser.set(key, member);
  }
  return byUser;
});

async function receive(entry: ReceivedReport) {
  if (receiving.value) return;
  receiving.value = entry.id;
  failures.delete(entry.id);
  feedback.value = '';
  try {
    if (desktop) {
      const path = await desktop.receiveDiagnosticReport(entry.id, entry.byteSize, entry.userId, entry.uploadedAt);
      if (!lifetime.signal.aborted) received.set(entry.id, path);
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
    else failures.set(entry.id, reason instanceof Error ? reason.message : '接收日志失败，请重试。');
  } finally { receiving.value = ''; }
}

async function reveal(id: string) {
  revealError.value = '';
  try { await desktop?.revealDiagnosticReport(id); }
  catch (reason) { revealError.value = reason instanceof Error ? reason.message : '无法打开日志所在目录。'; }
}

async function receiveMissing() {
  if (!desktop || receiving.value) return;
  while (!lifetime.signal.aborted && !document.hidden && !props.loading && !props.readError) {
    const next = props.entries?.find(entry => !entry.savedPath && !received.has(entry.id) && !failures.has(entry.id));
    if (!next) break;
    await receive(next);
  }
}
watch(() => [props.entries, props.loading], () => {
  const ids = new Set(props.entries?.map(entry => entry.id));
  for (const id of failures.keys()) if (!ids.has(id)) failures.delete(id);
  // 桌面核对到磁盘文件后，交回磁盘状态负责；之后移走文件也能再次接收。
  for (const id of received.keys()) if (!ids.has(id) || props.entries?.some(entry => entry.id === id && entry.savedPath)) received.delete(id);
  void receiveMissing();
}, { immediate: true });
onScopeDispose(() => lifetime.abort());
</script>

<template>
  <section class="settings-block">
    <h2>收到的日志</h2>
    <small>每位成员保留最近 3 份，全服最多 32 份。</small>
    <p v-if="entries?.length === 0">还没有成员上传日志。</p>
    <section v-for="[key, member] in members" :key="key" class="report-member">
      <h3>{{ member.nickname }}</h3>
      <section v-for="[date, items] in member.days" :key="date" class="report-day">
        <h4>{{ date }}</h4>
        <div v-for="entry in items" :key="entry.id">
          <div class="settings-action-row">
            <time :datetime="entry.uploadedAt">{{ new Date(entry.uploadedAt).toLocaleTimeString() }} · {{ formatAttachmentSize(entry.byteSize) }}</time>
            <button v-if="desktop && (entry.savedPath || received.has(entry.id))" type="button" class="settings-button report-file"
              aria-label="在文件夹中显示" :title="entry.savedPath || received.get(entry.id)" @click="reveal(entry.id)"><FolderOpen :size="16" /></button>
            <button v-else-if="!desktop || failures.has(entry.id)" type="button" class="settings-button" :disabled="!!receiving"
              @click="receive(entry)">{{ receiving === entry.id ? '接收中…' : failures.has(entry.id) ? '重试接收' : '下载日志' }}</button>
            <small v-else>{{ receiving === entry.id ? '接收中…' : '等待接收' }}</small>
          </div>
          <InlineFeedback :message="failures.get(entry.id)" />
        </div>
      </section>
    </section>
    <InlineFeedback :status="feedback" :message="readError || revealError" :pending="loading && entries === null ? '正在读取日志…' : ''" />
  </section>
</template>

<style scoped>
.report-member { margin-top: 16px; }
.report-member h3 { margin: 0; font-size: 14px; }
.report-day h4 { margin: 10px 0 4px; color: var(--muted); font-size: 12px; font-weight: 400; }
.report-day time { flex-shrink: 0; font-size: 13px; }
.report-file { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; }
</style>

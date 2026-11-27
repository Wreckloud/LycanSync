<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { FolderOpen, Trash2 } from '@lucide/vue';
import { authenticatedFetch, readApiError } from '../../auth/authApi';
import { formatAttachmentSize } from '../../chat/chatMedia';
import { useSettingsRead } from '../../settings/useSettingsRead';
import { keepDialogFocus } from '../dialogFocus';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { useLoadingHint } from '../useLoadingHint';
import InlineFeedback from '../InlineFeedback.vue';

interface ReceivedReport { id: string; userId?: string; nickname: string; uploadedAt: string; byteSize: number; savedPath?: string | null }
const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ close: []; denied: [message: string] }>();
const desktop = window.lycanDesktop;
const dialog = ref<HTMLElement>();
const includeOwn = ref(false);
const activeId = ref('');
const feedback = ref('');
const error = ref('');
const cleanupError = ref('');
const lifetime = new AbortController();
const backdrop = useBackdropDismiss(() => emit('close'));
const reports = useSettingsRead(async signal => {
  const response = await authenticatedFetch('/api/diagnostics/reports', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw await readApiError(response);
  return await response.json() as ReceivedReport[];
}, '无法读取日志列表', message => emit('denied', message));
const { value: entries, error: readError, loading } = reports;
const reading = useLoadingHint(() => loading.value && entries.value === null);
const members = computed(() => {
  const byUser = new Map<string, { nickname: string; days: Map<string, ReceivedReport[]> }>();
  for (const entry of entries.value ?? []) {
    if (!includeOwn.value && entry.userId === props.userId) continue;
    const key = entry.userId ?? entry.nickname;
    const member = byUser.get(key) ?? { nickname: entry.nickname, days: new Map<string, ReceivedReport[]>() };
    const day = new Date(entry.uploadedAt).toLocaleDateString();
    if (!member.days.has(day)) member.days.set(day, []);
    member.days.get(day)!.push(entry);
    byUser.set(key, member);
  }
  return byUser;
});

let timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  clearTimeout(timer);
  if (document.hidden || lifetime.signal.aborted) return;
  await reports.refresh();
  clearTimeout(timer);
  if (!lifetime.signal.aborted && !document.hidden) timer = setTimeout(refresh, readError.value ? 30_000 : 5_000);
}
onMounted(async () => {
  dialog.value?.focus();
  document.addEventListener('visibilitychange', refresh);
  try { await desktop?.cleanDiagnosticCopies(); }
  catch { cleanupError.value = '部分日志副本未能清理，请检查目录权限或文件占用。'; }
  await refresh();
});
onScopeDispose(() => {
  lifetime.abort();
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', refresh);
  if (activeId.value) desktop?.cancelDiagnosticFile();
});

async function file(entry: ReceivedReport, action: 'open' | 'delete') {
  if (activeId.value) return;
  // 即将禁用行按钮，先把键盘焦点留在弹窗内。
  dialog.value?.focus({ preventScroll: true });
  activeId.value = entry.id;
  feedback.value = error.value = '';
  try {
    if (desktop) {
      await desktop.diagnosticFile(entry.id, action);
    } else {
      const response = await authenticatedFetch('/api/diagnostics/reports/' + entry.id, { signal: lifetime.signal });
      if (!response.ok) throw await readApiError(response);
      const blob = await response.blob();
      if (blob.size !== entry.byteSize) throw new Error('报告未完整下载，请重试。');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'LycanSync-diagnostics-' + entry.id + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      feedback.value = '报告已交给浏览器下载。';
    }
  } catch (reason) {
    if (!lifetime.signal.aborted) error.value = reason instanceof Error ? reason.message : '日志操作失败，请重试。';
  } finally {
    activeId.value = '';
    await refresh();
  }
}
</script>

<template>
  <div class="dialog-backdrop" v-on="backdrop" @keydown.esc.stop="emit('close')">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="report-library-title" tabindex="-1" class="report-dialog" @keydown="keepDialogFocus">
      <h2 id="report-library-title">日志管理器</h2>
      <label><input v-model="includeOwn" type="checkbox" /> 包含我的报告</label>
      <div class="report-content">
        <InlineFeedback :status="feedback" :message="error || readError || cleanupError" :pending="reading ? '正在读取日志…' : ''" />
        <p v-if="entries && !members.size">还没有成员上传日志。</p>
        <section v-for="[key, member] in members" :key="key" class="report-member">
          <h3>{{ member.nickname }}</h3>
          <section v-for="[date, items] in member.days" :key="date" class="report-day">
            <h4>{{ date }}</h4>
            <div v-for="entry in items" :key="entry.id" class="settings-action-row">
              <time :datetime="entry.uploadedAt">{{ new Date(entry.uploadedAt).toLocaleTimeString() }} · {{ formatAttachmentSize(entry.byteSize) }}</time>
              <div class="report-actions">
                <button class="settings-button" :disabled="!!activeId" @click="file(entry, 'open')">
                  {{ desktop ? '打开文件夹' : '下载日志' }}<FolderOpen v-if="desktop" :size="16" aria-hidden="true" />
                </button>
                <button v-if="desktop" class="settings-button report-delete" :disabled="!!activeId || !entry.savedPath"
                  title="删除本地副本" aria-label="删除本地副本" @click="file(entry, 'delete')"><Trash2 :size="16" /></button>
              </div>
            </div>
          </section>
        </section>
      </div>
      <footer><small>服务器每人保留最近 3 份，全服最多 32 份。<template v-if="desktop">本地自动副本保留 3 天，合计最多 128 MiB。</template></small>
        <button class="settings-button" @click="emit('close')">关闭</button></footer>
    </section>
  </div>
</template>

<style scoped>
.report-dialog { display: flex; flex-direction: column; gap: 16px; width: min(760px, calc(100vw - 32px)); height: min(700px, calc(100vh - 48px)); box-sizing: border-box; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
.report-content { flex: 1; min-height: 0; overflow-y: auto; }
.report-member h3 { margin: 12px 0 4px; font-size: 15px; }
.report-day h4, footer small { color: var(--muted); font-size: 12px; }
.report-day h4 { margin: 8px 0 4px; }
.report-actions, .report-actions button, footer { display: flex; align-items: center; gap: 6px; }
.report-actions button { justify-content: center; }
.report-delete:is(:hover,:focus-visible):enabled { color: var(--danger); }
footer { justify-content: space-between; }
</style>

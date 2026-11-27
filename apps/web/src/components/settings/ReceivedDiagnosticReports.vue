<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { ChevronRight, Download, FolderOpen, Trash2 } from '@lucide/vue';
import { authenticatedFetch, readApiError } from '../../auth/authApi';
import { formatAttachmentSize } from '../../chat/chatMedia';
import { useSettingsRead } from '../../settings/useSettingsRead';
import { keepDialogFocus } from '../dialogFocus';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { useLoadingHint } from '../useLoadingHint';
import MemberPicker, { type MemberOption } from '../MemberPicker.vue';
import { loadServerMembers } from '../../settings/loadServerMembers';
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
const choosingMember = ref(false);
const requesting = ref(false);
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
const requestButton = ref<HTMLButtonElement>();
const reportDays = computed(() => {
  const days = new Map<string, ReceivedReport[]>();
  // 收件列表已经按上传时间倒序，按本地日期分段即可保留跨成员的到达顺序。
  for (const entry of entries.value ?? []) {
    if (!includeOwn.value && entry.userId === props.userId) continue;
    const day = new Date(entry.uploadedAt).toLocaleDateString();
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(entry);
  }
  return days;
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

async function requestReport(member: MemberOption) {
  if (requesting.value) return;
  requesting.value = true;
  feedback.value = error.value = '';
  try {
    const response = await authenticatedFetch('/api/diagnostics/reports/request?memberId=' + encodeURIComponent(member.userId), {
      method: 'POST', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw await readApiError(response);
    choosingMember.value = false;
    feedback.value = `已请求 ${member.nickname} 的日志。请求有效期为两分钟，对方在线并允许上报时会自动上传。`;
  } catch (reason) {
    if (!lifetime.signal.aborted) error.value = reason instanceof Error ? reason.message : '请求日志失败，请重试。';
  } finally {
    requesting.value = false;
    if (!choosingMember.value) { await nextTick(); requestButton.value?.focus(); }
  }
}

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
      <header class="report-header">
        <h2 id="report-library-title">日志管理器</h2>
        <button ref="requestButton" class="request-switch" type="button" :disabled="requesting" :aria-expanded="choosingMember" @click="choosingMember = !choosingMember">
          {{ choosingMember ? '返回收件箱' : '请求成员日志' }}<ChevronRight :size="14" aria-hidden="true" />
        </button>
      </header>
      <InlineFeedback :status="feedback" :message="error || readError || cleanupError" :pending="reading ? '正在读取日志…' : ''" />
      <div v-if="choosingMember" class="report-content">
        <MemberPicker :load="loadServerMembers" :disabled="requesting" label="搜索服务器成员" action="请求日志" @select="requestReport" />
      </div>
      <template v-else>
        <div class="report-toolbar">
          <h3>最近收到</h3>
          <label><input v-model="includeOwn" type="checkbox" /> 包含我的报告</label>
        </div>
        <div class="report-content">
          <p v-if="entries && !reportDays.size" class="empty">还没有成员上传日志。</p>
          <section v-for="[date, items] in reportDays" :key="date" class="report-day">
            <h4>{{ date }}</h4>
            <div v-for="entry in items" :key="entry.id" class="report-row">
              <div class="report-info">
                <strong>{{ entry.nickname }}</strong>
                <small><time :datetime="entry.uploadedAt">{{ new Date(entry.uploadedAt).toLocaleTimeString() }}</time> · {{ formatAttachmentSize(entry.byteSize) }}</small>
              </div>
              <div class="report-actions">
                <button class="settings-button" :aria-label="desktop ? '打开文件夹' : '下载日志'" :disabled="!!activeId" @click="file(entry, 'open')">
                  <component :is="desktop ? FolderOpen : Download" :size="15" aria-hidden="true" /><span>{{ desktop ? '打开文件夹' : '下载日志' }}</span>
                </button>
                <button v-if="desktop && entry.savedPath" class="settings-button report-delete" :disabled="!!activeId"
                  title="删除本地副本" aria-label="删除本地副本" @click="file(entry, 'delete')"><Trash2 :size="15" /></button>
              </div>
            </div>
          </section>
        </div>
      </template>
      <footer>
        <details><summary>日志保留规则</summary><small>服务器每人保留最近 3 份，全服最多 32 份。<template v-if="desktop">本地自动副本保留 3 天，合计最多 128 MiB。</template></small></details>
        <button class="settings-button" @click="emit('close')">关闭</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.report-dialog { display: flex; flex-direction: column; gap: 12px; width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); box-sizing: border-box; padding: 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.report-header, .report-toolbar, .report-row, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2, h3, h4, p { margin: 0; }
h2 { font-size: 20px; }
h3 { font-size: 14px; }
.request-switch, .report-actions, .report-actions button { display: inline-flex; align-items: center; gap: 6px; }
.request-switch { padding: 4px 0; border: 0; background: transparent; color: var(--accent); font: inherit; }
.report-toolbar { padding-top: 10px; border-top: 1px solid var(--border); }
.report-toolbar label, h4, small, summary, .empty { color: var(--muted); font-size: 12px; }
.report-toolbar label { display: flex; align-items: center; gap: 5px; }
.report-content { min-height: 0; max-height: min(48vh, 420px); overflow-y: auto; }
.report-content :deep(.member-picker-list) { height: auto; max-height: min(30vh, 280px); }
.empty { padding: 24px 0; text-align: center; }
.report-day + .report-day { margin-top: 10px; }
h4 { padding: 4px 0; font-weight: 500; }
.report-row { padding: 6px 0; }
.report-info { display: grid; min-width: 0; gap: 2px; }
.report-info strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.report-info small { font-variant-numeric: tabular-nums; }
.report-actions { flex-shrink: 0; }
.report-delete:is(:hover,:focus-visible):enabled { color: var(--danger); }
footer { border-top: 1px solid var(--border); padding-top: 12px; }
footer summary { cursor: pointer; }
footer small { display: block; margin-top: 6px; }
@media (max-width: 480px) {
  .report-dialog { padding: 14px; }
  .report-actions button span { display: none; }
}
</style>

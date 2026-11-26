<script setup lang="ts">
import { onScopeDispose, ref, useId, watch } from 'vue';
import { ChevronRight } from '@lucide/vue';
import ExpandSection from '../ExpandSection.vue';
import { authenticatedFetch, authRequest, readApiError } from '../../auth/authApi';
import { useSettingsRead } from '../../settings/useSettingsRead';
import InlineFeedback from '../InlineFeedback.vue';
import { useLoadingHint } from '../useLoadingHint';
import AccountLifecycleSettings from './AccountLifecycleSettings.vue';
import MemberAccessSettings from './MemberAccessSettings.vue';
import UploadSettings from './UploadSettings.vue';
import QqLoginSettings from './QqLoginSettings.vue';
import ReceivedDiagnosticReports, { type ReceivedReport } from './ReceivedDiagnosticReports.vue';

const props = defineProps<{ active: boolean; leaving: boolean }>();
const emit = defineEmits<{ notice: [message: string]; qqSettingsSaved: [] }>();
interface ServerSettingsStatus {
  serverName: string;
  publicUrlConfigured: boolean;
  mediaConfigured: boolean;
}
const advancedOpen = ref(false);
const advancedId = useId();
const accessError = ref('');
const summary = useSettingsRead(signal => authRequest<ServerSettingsStatus>('server-settings', 'GET', undefined, signal),
  '无法读取服务器配置状态', revokeAccess);
const { value: status, error, loading } = summary;
const readingSummary = useLoadingHint(() => props.active && loading.value && !status.value);
const reports = useSettingsRead(async signal => {
  const response = await authenticatedFetch('/api/diagnostics/reports', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw await readApiError(response);
  return await response.json() as ReceivedReport[];
}, '无法读取日志列表', revokeAccess);
const { value: entries, loading: readingReports, error: reportsError } = reports;

function revokeAccess(message: string) {
  summary.clear();
  reports.clear();
  advancedOpen.value = false;
  accessError.value = message;
}

async function refreshOwner() {
  await Promise.all([summary.refresh(), reports.refresh()]);
  if (status.value && entries.value && !error.value && !reportsError.value) accessError.value = '';
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
function scheduleReports() {
  clearTimeout(refreshTimer);
  if (disposed || !props.active || accessError.value || document.hidden) return;
  refreshTimer = setTimeout(() => { void reports.refresh().then(scheduleReports); }, reportsError.value ? 30_000 : 5_000);
}
function visibilityChanged() {
  clearTimeout(refreshTimer);
  if (props.active && !document.hidden && !accessError.value) void reports.refresh().then(scheduleReports);
}
document.addEventListener('visibilitychange', visibilityChanged);
onScopeDispose(() => {
  disposed = true;
  clearTimeout(refreshTimer);
  document.removeEventListener('visibilitychange', visibilityChanged);
});
watch(() => [props.active, accessError.value], () => scheduleReports(), { immediate: true });
watch(() => props.active, (active) => {
  if (active) void refreshOwner();
  else advancedOpen.value = false;
}, { immediate: true });
</script>

<template>
  <section v-if="active && accessError" class="settings-section">
    <InlineFeedback :message="error || reportsError || accessError" />
    <button type="button" class="settings-button" :disabled="loading || readingReports" @click="refreshOwner">重试</button>
  </section>
  <section v-else-if="active" class="settings-section owner-settings">
    <MemberAccessSettings :active="active" @notice="emit('notice', $event)" />
    <ReceivedDiagnosticReports :entries="entries" :loading="readingReports" :read-error="reportsError"
      @denied="revokeAccess" />
    <section class="settings-block">
      <h2>服务器配置</h2>
      <dl class="owner-status" :aria-busy="loading && !status">
        <dt>服务器名称</dt><dd>{{ status?.serverName ?? (readingSummary ? '正在读取…' : '—') }}</dd>
        <dt>邀请入口地址</dt><dd>{{ status ? (status.publicUrlConfigured ? '已配置' : '未配置') : '—' }}</dd>
        <dt>媒体服务</dt><dd>{{ status ? (status.mediaConfigured ? '已配置' : '未配置') : '—' }}</dd>
      </dl>
      <InlineFeedback :message="error" />
      <button v-if="error" type="button" class="settings-button" :disabled="loading || leaving" @click="summary.refresh()">重试</button>
      <button type="button" class="disclosure-trigger" :aria-expanded="advancedOpen" :aria-controls="advancedId" @click="advancedOpen = !advancedOpen">
        <ChevronRight :size="12" class="disclosure-arrow" :class="{ 'is-open': advancedOpen }" aria-hidden="true" />高级配置
      </button>
      <ExpandSection :open="advancedOpen" :id="advancedId">
        <div class="advanced-settings">
          <QqLoginSettings :active="active && advancedOpen" :leaving="leaving" @saved="emit('qqSettingsSaved')" />
          <UploadSettings :active="active && advancedOpen" :leaving="leaving" @notice="emit('notice', $event)" />
        </div>
      </ExpandSection>
    </section>
    <AccountLifecycleSettings :active="active" :leaving="leaving" :administrator="true" section="owner" @notice="emit('notice', $event)" />
  </section>
</template>

<style scoped>
.advanced-settings { display: grid; gap: 20px; padding-top: 12px; }
.owner-status { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 10px 20px; margin: 12px 0; font-size: 14px; line-height: 20px; }
.owner-status dt { color: var(--muted); }
.owner-status dd { margin: 0; overflow-wrap: anywhere; }
.owner-settings > :last-child { border-bottom: 0; padding-bottom: 0; }
</style>

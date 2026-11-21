<script setup lang="ts">
import { onScopeDispose, ref, useId, watch } from 'vue';
import type { Room } from 'livekit-client';
import { ChevronRight } from '@lucide/vue';
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';
import ExpandSection from '../ExpandSection.vue';
import MediaDiagnostics from '../MediaDiagnostics.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; room: Room | null; active: boolean }>();
const { recording, automaticEnabled, reason, error, saving, notes,
  savedReport, savedSizeBytes, persistenceError } = props.report;
const desktop = Boolean(window.lycanDesktop);
const problemCategory = ref('audio-breakup');
const moreOpen = ref(false);
const chooseLocation = ref(false);
const diagnosticsOpen = ref(false);
const moreId = useId();
watch(() => props.active, active => { if (!active) { moreOpen.value = false; diagnosticsOpen.value = false; chooseLocation.value = false; } });
watch(() => props.room, room => { if (!room) diagnosticsOpen.value = false; });
watch(moreOpen, open => { if (!open) diagnosticsOpen.value = false; });
watch(diagnosticsOpen, open => props.report.setViewing(open));
onScopeDispose(() => props.report.setViewing(false));
function formatReportSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function updateAutomatic(event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  input.checked = automaticEnabled.value;
  props.report.setAutomatic(enabled);
}
</script>

<template>
  <section class="settings-block diagnostic-report-settings">
    <h2>应用日志</h2>
    <div class="settings-action-row">
      <div><strong>诊断报告</strong>
        <small>遇到声音断续、共享卡顿或应用异常退出时，可导出本机保留的运行记录，发给协助排查的人。报告不含通话声音和共享画面。</small>
      </div>
      <button type="button" class="settings-button" :disabled="saving || (!desktop && !recording && !reason)" @click="report.save(notes, chooseLocation)">导出全部报告</button>
    </div>
    <small v-if="report.exportStatus.value" class="export-status" role="status">{{ report.exportStatus.value }}</small>
    <button type="button" class="disclosure-trigger" :aria-expanded="moreOpen" :aria-controls="moreId" @click="moreOpen = !moreOpen">
      <ChevronRight :size="12" class="disclosure-arrow" :class="{ 'is-open': moreOpen }" aria-hidden="true" />{{ moreOpen ? '收起诊断选项' : '更多诊断选项' }}
    </button>
    <ExpandSection :open="moreOpen" :id="moreId">
      <div class="diagnostic-details">
        <label class="report-notes">体验说明（选填）
          <textarea v-model="notes" maxlength="2000" rows="2" placeholder="例如：共享画面后，队友听到的声音开始断续" />
        </label>
        <label v-if="desktop" class="settings-toggle">
          <span><strong>导出时选择保存位置</strong><small>默认保存到本机数据目录的 exports 文件夹。</small></span>
          <input v-model="chooseLocation" type="checkbox" />
        </label>
        <div class="button-actions">
          <select v-model="problemCategory" aria-label="问题类型">
            <option value="no-audio">没声音</option><option value="audio-breakup">声音断续或失真</option>
            <option value="video-stutter">画面卡顿</option><option value="other">其他问题</option>
          </select>
          <button type="button" :disabled="!recording || saving" @click="report.markProblem(problemCategory)">标记刚才的问题</button>
          <span v-if="report.problemMarkers?.value.length">最近标记：{{ new Date(report.problemMarkers.value.at(-1)!.time).toLocaleTimeString() }}</span>
        </div>
        <small>正在记录时可标记问题发生的时刻，方便在报告里找到那一段。</small>
        <div class="settings-toggle">
          <span><strong>自动记录诊断</strong><small>在本机记录版本、设备和通话质量信息，方便遇到问题时排查。</small></span>
          <input type="checkbox" aria-label="自动记录诊断" :checked="automaticEnabled" :disabled="saving" @change="updateAutomatic" />
        </div>
        <small v-if="desktop">关闭自动记录后，已有报告仍可导出或清除。</small>
        <small v-else>浏览器仅保留当前页面的记录，请在退出前导出。</small>
        <div class="settings-actions">
          <button v-if="!automaticEnabled && !recording" type="button" :disabled="!room || saving" @click="report.start()">{{ reason ? '开始新记录（替换本次）' : '开始记录' }}</button>
          <button v-else-if="!automaticEnabled" type="button" @click="report.stop()">结束记录</button>
          <button v-if="desktop" type="button" :disabled="recording || saving" @click="report.clearSaved()">清除详细报告</button>
        </div>
        <p v-if="desktop">{{ savedSizeBytes === null ? '尚未保存' : `文件大小 ${formatReportSize(savedSizeBytes)}` }}</p>
        <p v-if="desktop && savedReport">{{ savedReport.kind === 'screen-media' ? '最近共享与观看报告' : '上次使用报告' }}：{{ new Date(savedReport.endedAt).toLocaleString() }}<template v-if="savedReport.clientVersion"> · {{ savedReport.clientVersion }}</template> · {{ formatReportSize(savedReport.bytes) }}</p>
        <button type="button" class="settings-button diagnostics-toggle" :disabled="!room" :aria-expanded="diagnosticsOpen" @click="diagnosticsOpen = !diagnosticsOpen">{{ diagnosticsOpen ? '收起媒体诊断' : '查看媒体诊断' }}</button>
        <small role="status">{{ recording ? automaticEnabled ? '自动记录中' : '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }}<template v-if="!room"> · 加入语音后可查看媒体诊断</template></small>
        <ExpandSection :open="diagnosticsOpen">
          <MediaDiagnostics v-if="diagnosticsOpen && room" :room="room" :statistics="report.latest.value" />
        </ExpandSection>
      </div>
    </ExpandSection>
    <InlineFeedback :message="error" :pending="saving ? '正在导出报告…' : ''" />
    <InlineFeedback :message="persistenceError" />
  </section>
</template>

<style scoped>
.diagnostic-details { display: grid; gap: 8px; padding-top: 8px; }
.diagnostic-report-settings .settings-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.report-notes { display: grid; gap: 8px; }
.diagnostics-toggle { justify-self: start; }
.export-status { overflow-wrap: anywhere; user-select: text; }
.report-notes textarea { resize: vertical; min-height: 64px; }
</style>

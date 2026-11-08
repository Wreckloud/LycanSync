<script setup lang="ts">
import { ref } from 'vue';
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; canStart: boolean }>();
const { recording, automaticEnabled, reason, error, saving, notes,
  savedReport, savedSizeBytes, persistenceError } = props.report;
const desktop = Boolean(window.lycanDesktop);
const problemCategory = ref('audio-breakup');
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
    <h2>测试报告</h2>
    <label class="settings-toggle">
      <span><strong>自动记录诊断</strong><small>进入应用后自动记录，是否开启会保存在这台设备。</small></span>
      <input type="checkbox" aria-label="自动记录诊断" :checked="automaticEnabled" :disabled="saving" @change="updateAutomatic" />
    </label>
    <p>关闭开关保留已有记录，再次开启继续记录。</p>
    <p>记录版本、设备与通话质量等排查信息，成员使用临时编号。不包含昵称、链接或原始日志，不录制音视频，也不会自动上传。</p>
    <p v-if="desktop">关闭后停止详细记录，基础故障日志仍会保留。导出报告不会停止记录。</p>
    <p v-if="desktop">详细报告约每 15 秒自动保存至 data/diagnostics。共享结束后保留最近一次记录，退出账号或关闭应用后仍可导出。异常退出可能缺少最后一段记录；体验说明不会自动保存。</p>
    <p v-else>浏览器详细记录仅保存在页面内存，请在退出前导出。</p>
    <div class="settings-actions">
      <button v-if="!automaticEnabled && !recording" type="button" :disabled="!canStart || saving" @click="report.start()">
        {{ reason ? '开始新记录（替换本次）' : '开始记录' }}
      </button>
      <button v-else-if="!automaticEnabled" type="button" @click="report.stop()">结束记录</button>
      <button type="button" :disabled="(recording && !automaticEnabled) || (!reason && !desktop && !automaticEnabled) || saving" @click="report.save(notes)">导出报告</button>
      <button v-if="desktop" type="button" :disabled="!savedReport || saving" @click="report.savePrevious()">{{ savedReport?.kind === 'screen-media' ? '导出最近画面使用' : '导出上次使用' }}</button>
      <button v-if="desktop" type="button" :disabled="recording || saving" @click="report.clearSaved()">清除详细报告</button>
      <span role="status">{{ recording ? automaticEnabled ? '自动记录中' : '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }}<template v-if="desktop"> · {{ savedSizeBytes === null ? '尚未保存' : `文件大小 ${formatReportSize(savedSizeBytes)}` }}</template></span>
    </div>
    <p v-if="desktop && savedReport">{{ savedReport.kind === 'screen-media' ? '最近画面使用' : '上次使用' }}：{{ new Date(savedReport.endedAt).toLocaleString() }}<template v-if="savedReport.clientVersion"> · {{ savedReport.clientVersion }}</template> · {{ formatReportSize(savedReport.bytes) }}</p>
    <p v-if="desktop">报告默认导出至 data/exports，也可另选位置。清除记录前请关闭自动记录；只清除自动保存和当前记录，手动导出的文件、账号设置及基础故障日志会保留。</p>
    <label class="report-notes">体验说明（选填）
      <textarea v-model="notes" maxlength="2000" rows="2" placeholder="例如：四路观看时卡顿，单路观看恢复正常" />
    </label>
    <div class="button-actions">
      <select v-model="problemCategory" aria-label="问题类型">
        <option value="no-audio">没声音</option><option value="audio-breakup">声音断续或失真</option>
        <option value="video-stutter">画面卡顿</option><option value="other">其他问题</option>
      </select>
      <button type="button" :disabled="!recording || saving" @click="report.markProblem(problemCategory)">标记刚才的问题</button>
      <span v-if="report.problemMarkers?.value.length">最近标记：{{ new Date(report.problemMarkers.value.at(-1)!.time).toLocaleTimeString() }}</span>
    </div>
    <p>遇到问题时尽快标记，并在体验说明中描述现象。标记会随报告导出，不会录音；未开启记录时无法补回此前数据。</p>
    <InlineFeedback :message="error" :pending="saving ? '正在导出报告…' : ''" />
    <InlineFeedback :message="persistenceError" />
  </section>
</template>

<style scoped>
.report-notes { display: grid; gap: 8px; margin-top: 16px; }
.report-notes textarea { resize: vertical; min-height: 64px; }
</style>

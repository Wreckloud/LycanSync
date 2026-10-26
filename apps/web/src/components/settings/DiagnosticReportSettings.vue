<script setup lang="ts">
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; canStart: boolean }>();
const { recording, automaticEnabled, reason, error, saving, notes,
  savedReport, savedSizeBytes, persistenceError } = props.report;
const desktop = Boolean(window.lycanDesktop);
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
      <span><strong>自动记录诊断</strong><small>桌面测试版默认开启，记住本机选择；进入应用后自动记录，无需先加入语音。</small></span>
      <input type="checkbox" aria-label="自动记录诊断" :checked="automaticEnabled" :disabled="saving" @change="updateAutomatic" />
    </label>
    <p>关闭开关保留已有记录，再次开启继续记录。</p>
    <p>记录版本、媒体参数、帧率与丢包；桌面导出附带系统信息和精简故障阶段。成员使用临时编号，不附带昵称、链接或原始日志；不录制音视频，不自动上传。</p>
    <p v-if="desktop">关闭开关只停止详细采样；桌面启动后的有界关键阶段与故障日志仍保留。导出不会停止自动记录。</p>
    <p v-if="desktop">详细报告每约 15 秒保存在安装目录 data/diagnostics，正常关闭时补存；异常退出或后台节流可能缺少最后一个保存间隔。关闭应用或退出账号后仍可导出，仅重新打开设置不会覆盖上次使用。自动保存不包含体验说明。</p>
    <p v-else>浏览器详细记录仅保存在页面内存，请在退出前导出。</p>
    <div class="settings-actions">
      <button v-if="!automaticEnabled && !recording" type="button" :disabled="!canStart || saving" @click="report.start()">
        {{ reason ? '开始新记录（替换本次）' : '开始记录' }}
      </button>
      <button v-else-if="!automaticEnabled" type="button" @click="report.stop()">结束记录</button>
      <button type="button" :disabled="(recording && !automaticEnabled) || (!reason && !desktop && !automaticEnabled) || saving" @click="report.save(notes)">
        {{ saving ? '正在导出…' : '导出报告' }}
      </button>
      <button v-if="desktop" type="button" :disabled="!savedReport || saving" @click="report.savePrevious()">导出上次使用</button>
      <button v-if="desktop" type="button" :disabled="recording || saving" @click="report.clearSaved()">清除详细报告</button>
      <span role="status">{{ recording ? automaticEnabled ? '自动记录中' : '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }}<template v-if="desktop"> · {{ savedSizeBytes === null ? '尚未保存' : `文件大小 ${formatReportSize(savedSizeBytes)}` }}</template></span>
    </div>
    <p v-if="desktop && savedReport">上次使用：{{ new Date(savedReport.endedAt).toLocaleString() }}<template v-if="savedReport.clientVersion"> · {{ savedReport.clientVersion }}</template> · {{ formatReportSize(savedReport.bytes) }}</p>
    <p v-if="desktop">导出默认保存在安装目录 data/exports，每次仍可选择桌面等其他位置。清除前请先关闭自动记录；清除本次及上次详细报告和当前内存采样，不删除手动导出的文件，不影响账号、设置或有界基础故障日志。</p>
    <label class="report-notes">体验说明（选填）
      <textarea v-model="notes" maxlength="2000" rows="2" placeholder="例如：四路观看时卡顿，单路观看恢复正常" />
    </label>
    <InlineFeedback :message="error" />
    <InlineFeedback :message="persistenceError" />
  </section>
</template>

<style scoped>
.report-notes { display: grid; gap: 8px; margin-top: 16px; }
.report-notes textarea { resize: vertical; min-height: 64px; }
</style>

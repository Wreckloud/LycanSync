<script setup lang="ts">
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; canStart: boolean }>();
const { recording, automaticEnabled, discardedSamples, sampleCount, reason, error, saving, notes } = props.report;
const desktop = Boolean(window.lycanDesktop);
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
    <p>每 2 秒尝试采样，自动滚动保留最近 30 分钟，最多 900 份／6 MiB；关闭开关保留已有记录，再次开启继续记录。退出应用会清除未导出的详细采样。</p>
    <p>记录版本、媒体参数、帧率与丢包；桌面导出附带系统信息和精简故障阶段。成员使用临时编号，不附带昵称、链接或原始日志；不录制音视频，不自动上传。</p>
    <p v-if="desktop">关闭开关只停止详细采样；桌面启动后的有界关键阶段与故障日志仍保留。导出不会停止自动记录。</p>
    <div class="settings-actions">
      <button v-if="!automaticEnabled && !recording" type="button" :disabled="!canStart || saving" @click="report.start()">
        {{ reason ? '开始新记录（替换上次）' : '开始记录' }}
      </button>
      <button v-else-if="!automaticEnabled" type="button" @click="report.stop()">结束记录</button>
      <button type="button" :disabled="(recording && !automaticEnabled) || (!reason && !desktop && !automaticEnabled) || saving" @click="report.save(notes)">
        {{ saving ? '正在导出…' : '导出报告' }}
      </button>
      <span role="status">{{ recording ? automaticEnabled ? '自动记录中' : '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }} · {{ sampleCount }} 份统计<template v-if="discardedSamples"> · 已滚动移除 {{ discardedSamples }} 份旧统计</template></span>
    </div>
    <label class="report-notes">体验说明（选填）
      <textarea v-model="notes" maxlength="2000" rows="2" placeholder="例如：四路观看时卡顿，单路观看恢复正常" />
    </label>
    <InlineFeedback :message="error" />
  </section>
</template>

<style scoped>
.report-notes { display: grid; gap: 8px; margin-top: 16px; }
.report-notes textarea { resize: vertical; min-height: 64px; }
</style>

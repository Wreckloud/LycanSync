<script setup lang="ts">
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; canStart: boolean }>();
const { recording, sampleCount, reason, error, saving, notes } = props.report;
</script>

<template>
  <section class="settings-block diagnostic-report-settings">
    <h2>测试报告</h2>
    <p>主动记录后可以返回应用继续使用。每 2 秒尝试采样，最多 30 分钟；离房自动结束，退出应用会清除未导出的记录。</p>
    <p>记录版本、媒体参数、帧率与丢包；桌面导出附带系统信息和精简故障阶段。成员使用临时编号，不附带昵称、链接或原始日志；不录制音视频，不自动上传。</p>
    <div class="settings-actions">
      <button v-if="!recording" type="button" :disabled="!canStart || saving" @click="report.start()">
        {{ reason ? '开始新记录（替换上次）' : '开始记录' }}
      </button>
      <button v-else type="button" @click="report.stop()">结束记录</button>
      <button type="button" :disabled="recording || !reason || saving" @click="report.save(notes)">
        {{ saving ? '正在导出…' : '导出报告' }}
      </button>
      <span role="status">{{ recording ? '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }} · {{ sampleCount }} 份统计</span>
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

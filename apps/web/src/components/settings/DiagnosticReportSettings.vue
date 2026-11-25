<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, watch } from 'vue';
import type { Room } from 'livekit-client';
import { ChevronRight } from '@lucide/vue';
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import InlineFeedback from '../InlineFeedback.vue';
import ExpandSection from '../ExpandSection.vue';
import MediaDiagnostics from '../MediaDiagnostics.vue';
import SaveDirectorySetting from './SaveDirectorySetting.vue';

const props = defineProps<{ report: ReturnType<typeof useDiagnosticReport>; room: Room | null; active: boolean }>();
const { recording, automaticEnabled, reason, error, saving, notes,
  savedReport, savedSizeBytes, persistenceError } = props.report;
const desktop = Boolean(window.lycanDesktop);
const problemCategory = ref('audio-breakup');
const moreOpen = ref(false);
const diagnosticsOpen = ref(false);
const moreId = useId();
const deliveryDisabled = computed(() => saving.value || (!desktop && !recording.value && !reason.value));
watch(() => props.active, active => { if (!active) { moreOpen.value = false; diagnosticsOpen.value = false; } });
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
        <small>点击上传会将{{ desktop ? '当前和保留的历史报告' : '当前报告' }}发给服主，并{{ desktop ? '在本机保存副本' : '下载一份副本' }}。报告不含通话声音和共享画面。</small>
      </div>
      <button type="button" class="settings-button settings-control" :disabled="deliveryDisabled" @click="report.upload(notes)">上传日志</button>
    </div>
    <small v-if="report.exportStatus.value" class="export-status" role="status">{{ report.exportStatus.value }}</small>
    <button type="button" class="disclosure-trigger" :aria-expanded="moreOpen" :aria-controls="moreId" @click="moreOpen = !moreOpen">
      <ChevronRight :size="12" class="disclosure-arrow" :class="{ 'is-open': moreOpen }" aria-hidden="true" />{{ moreOpen ? '收起诊断选项' : '更多诊断选项' }}
    </button>
    <ExpandSection :open="moreOpen" :id="moreId">
      <div class="diagnostic-details">
        <label class="report-notes"><span>问题说明 <small>选填</small></span>
          <textarea v-model="notes" maxlength="2000" rows="3" :readonly="saving" placeholder="例如：刚才共享游戏时，队友能听到声音，但画面停住了。" />
        </label>
        <div class="settings-action-row">
          <div><strong>本地导出</strong><small>保存一份 JSON 报告，供自己查看。</small></div>
          <button type="button" class="settings-button settings-control" :disabled="deliveryDisabled" @click="report.save(notes)">导出全部报告</button>
        </div>
        <SaveDirectorySetting v-if="desktop && active && moreOpen" kind="diagnostics" label="日志保存位置" :disabled="saving" />
        <div class="settings-action-row">
          <div><strong>问题标记</strong><small>标出刚才发生问题的时刻。</small>
            <small v-if="report.problemMarkers?.value.length">最近标记：{{ new Date(report.problemMarkers.value.at(-1)!.time).toLocaleTimeString() }}</small>
          </div>
          <span class="settings-control settings-control-buttons">
            <select v-model="problemCategory" aria-label="问题类型">
              <option value="no-audio">没声音</option><option value="audio-breakup">声音断续或失真</option>
              <option value="video-stutter">画面卡顿</option><option value="other">其他问题</option>
            </select>
            <button type="button" class="settings-button" :disabled="!recording || saving" @click="report.markProblem(problemCategory)">标记刚才的问题</button>
          </span>
        </div>
        <div class="settings-toggle">
          <span><strong>自动记录诊断</strong><small>在本机记录版本、设备和通话质量信息，方便遇到问题时排查。</small></span>
          <input type="checkbox" aria-label="自动记录诊断" :checked="automaticEnabled" :disabled="saving" @change="updateAutomatic" />
        </div>
        <div v-if="!automaticEnabled" class="settings-action-row">
          <div><strong>手动记录</strong><small>{{ desktop ? '加入语音后可开始记录。' : '浏览器仅保留当前页面的记录。' }}</small></div>
          <button v-if="!recording" type="button" class="settings-button settings-control" :disabled="!room || saving" @click="report.start()">{{ reason ? '开始新记录（替换本次）' : '开始记录' }}</button>
          <button v-else type="button" class="settings-button settings-control" @click="report.stop()">结束记录</button>
        </div>
        <div v-if="desktop" class="settings-action-row">
          <div><strong>已保存的报告</strong>
            <small>{{ savedSizeBytes === null ? '尚未保存' : `文件大小 ${formatReportSize(savedSizeBytes)}` }}</small>
            <small v-if="savedReport">{{ savedReport.kind === 'screen-media' ? '最近共享与观看报告' : '上次使用报告' }}：{{ new Date(savedReport.endedAt).toLocaleString() }}<template v-if="savedReport.clientVersion"> · {{ savedReport.clientVersion }}</template> · {{ formatReportSize(savedReport.bytes) }}</small>
          </div>
          <button type="button" class="settings-button settings-control" :disabled="recording || saving" @click="report.clearSaved()">清除详细报告</button>
        </div>
        <div class="settings-action-row">
          <div><strong>媒体诊断</strong>
            <small role="status">{{ recording ? automaticEnabled ? '自动记录中' : '记录中' : reason === 'limit' ? '达到记录上限，已结束' : reason ? '记录已结束' : '尚未开始' }}<template v-if="!room"> · 加入语音后可查看媒体诊断</template></small>
          </div>
          <button type="button" class="settings-button settings-control" :disabled="!room" :aria-expanded="diagnosticsOpen" @click="diagnosticsOpen = !diagnosticsOpen">{{ diagnosticsOpen ? '收起媒体诊断' : '查看媒体诊断' }}</button>
        </div>
        <ExpandSection :open="diagnosticsOpen">
          <MediaDiagnostics v-if="diagnosticsOpen && room" :room="room" :statistics="report.latest.value" />
        </ExpandSection>
      </div>
    </ExpandSection>
    <InlineFeedback :message="error" :pending="saving ? '正在处理报告…' : ''" />
    <InlineFeedback :message="persistenceError" />
  </section>
</template>

<style scoped>
.diagnostic-details { display: grid; gap: 16px; padding-top: 8px; }
.report-notes { display: grid; gap: 6px; margin: 4px 0; }
.report-notes small { color: var(--muted); font-size: 12px; }
.report-notes textarea { width: 100%; height: 88px; padding: 10px; resize: none; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.report-notes textarea:focus { border-color: var(--subtle); }
.export-status { overflow-wrap: anywhere; user-select: text; }
</style>

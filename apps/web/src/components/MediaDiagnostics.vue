<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { Track, type Room } from 'livekit-client';
import { formatTrackTarget } from '../rtc/mediaStats';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';
import { isStaleVideoSourceError, resetVideoSourceSelection } from './mediaDiagnosticsSources';

const props = defineProps<{ room: Room; statistics: MediaDiagnosticsSnapshot | null }>();
const streams = computed(() => props.statistics?.streams ?? []);
const error = computed(() => props.statistics?.failures.length ? '部分统计暂时无法读取，缺失值不代表零。' : '');
const processMetrics = computed(() => props.statistics?.process ?? null);
function formatFpsInterval(intervalMs: number | null) {
  if (intervalMs === null) return '等待统计';
  const seconds = intervalMs / 1000;
  return seconds > 3 ? `约 ${Math.round(seconds)} 秒区间均值` : `约 ${seconds.toFixed(1)} 秒区间`;
}
const captureProbeAvailable = ref(false);
const captureProbeReason = ref('');
const videoCaptureAvailable = ref(false);
const videoSources = ref<NativeVideoSource[]>([]);
const selectedVideoSourceId = ref('');
const captureProbeSessionId = ref<string | null>(null);
const captureProbeState = ref<'idle' | 'starting' | 'running' | 'stopping' | 'failed'>('idle');
const captureProbeDiagnostics = ref<NativeCaptureDiagnostics | null>(null);
const captureProbeError = ref('');
const sourceListLoading = ref(false);
const captureProbeBusy = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;
let diagnosticsPolling = false;
let componentDisposed = false;

async function loadCaptureProbeCapability() {
  try {
    const capabilities = await window.lycanDesktop?.getNativeMediaCapabilities();
    if (componentDisposed) return;
    captureProbeAvailable.value = capabilities?.captureProbe.available ?? false;
    captureProbeReason.value = capabilities?.captureProbe.reason ?? 'desktopUnavailable';
    videoCaptureAvailable.value = capabilities?.videoCapture.available ?? false;
  } catch {
    if (componentDisposed) return;
    captureProbeAvailable.value = false;
    captureProbeReason.value = 'mediaHelperUnavailable';
  }
}

async function listVideoSources(sourceExpired = false) {
  if (componentDisposed || !window.lycanDesktop || sourceListLoading.value || captureProbeSessionId.value) return;
  const previousSelection = selectedVideoSourceId.value;
  sourceListLoading.value = true;
  captureProbeError.value = '';
  try {
    const snapshot = await window.lycanDesktop.listNativeVideoSources();
    if (componentDisposed) return;
    videoSources.value = snapshot.sources;
    // Helper 重启后来源 ID 可能复用；刷新时必须重新明确选择捕获目标。
    const selection = resetVideoSourceSelection(previousSelection);
    selectedVideoSourceId.value = selection.sourceId;
    if (sourceExpired) {
      captureProbeError.value = '原来源已过期，来源列表已刷新；请重新选择窗口或显示器后再启动探针。';
    } else if (selection.invalidated) {
      captureProbeError.value = '来源列表已刷新；请重新选择窗口或显示器后再启动探针。';
    }
  } catch {
    videoSources.value = [];
    selectedVideoSourceId.value = '';
    captureProbeError.value = '无法列出原生视频来源，请稍后刷新。';
  } finally {
    sourceListLoading.value = false;
  }
}

async function refreshCaptureProbeDiagnostics() {
  if (componentDisposed) return;
  if (!captureProbeSessionId.value) {
    captureProbeDiagnostics.value = props.statistics?.native ?? null;
    return;
  }
  if (!window.lycanDesktop || diagnosticsPolling) return;
  const sessionId = captureProbeSessionId.value;
  diagnosticsPolling = true;
  try {
    const diagnostics = await window.lycanDesktop.getNativeMediaDiagnostics();
    if (componentDisposed || captureProbeSessionId.value !== sessionId) return;
    captureProbeDiagnostics.value = diagnostics;
    captureProbeState.value = diagnostics.state;
    if (diagnostics.state === 'idle' && !diagnostics.sessionId) {
      captureProbeSessionId.value = null;
      captureProbeState.value = diagnostics.lastCaptureError ? 'failed' : 'idle';
    }
  } catch {
    if (componentDisposed || captureProbeSessionId.value !== sessionId) return;
    captureProbeState.value = 'failed';
    captureProbeError.value = '无法读取探针诊断，采集状态尚未确认；请停止探针后重试。';
  } finally {
    diagnosticsPolling = false;
  }
}

async function startCaptureProbe() {
  if (componentDisposed || !window.lycanDesktop || !captureProbeAvailable.value || !selectedVideoSourceId.value
      || sourceListLoading.value || captureProbeBusy.value || captureProbeSessionId.value) return;
  captureProbeBusy.value = true;
  captureProbeState.value = 'starting';
  captureProbeError.value = '';
  try {
    const result = await window.lycanDesktop.startNativeCaptureProbe(selectedVideoSourceId.value);
    captureProbeSessionId.value = result.sessionId;
    captureProbeState.value = 'running';
    if (componentDisposed) return;
    await refreshCaptureProbeDiagnostics();
  } catch (error) {
    if (componentDisposed) return;
    captureProbeState.value = 'failed';
    const sourceExpired = isStaleVideoSourceError(error);
    captureProbeError.value = sourceExpired
      ? '原来源已过期，正在刷新来源；请重新选择窗口或显示器后再启动探针。'
      : '探针启动失败；请刷新来源并检查原生媒体能力。';
    videoSources.value = [];
    selectedVideoSourceId.value = '';
    if (sourceExpired) await listVideoSources(true);
  } finally {
    captureProbeBusy.value = false;
    // 关闭可能发生在启动确认或首轮诊断等待期间；启动收尾后仍须回收已取得的会话。
    if (componentDisposed && captureProbeSessionId.value) await stopCaptureProbe();
  }
}

async function stopCaptureProbe() {
  const sessionId = captureProbeSessionId.value;
  if (!window.lycanDesktop || !sessionId || captureProbeBusy.value) return;
  captureProbeBusy.value = true;
  captureProbeState.value = 'stopping';
  captureProbeError.value = '';
  try {
    await window.lycanDesktop.stopNativeCaptureProbe(sessionId);
    captureProbeSessionId.value = null;
    captureProbeState.value = 'idle';
    if (!componentDisposed) {
      try { captureProbeDiagnostics.value = await window.lycanDesktop.getNativeMediaDiagnostics(); }
      catch { if (!componentDisposed) captureProbeError.value = '探针已停止，但暂时无法读取诊断。'; }
    }
  } catch {
    captureProbeState.value = 'failed';
    captureProbeError.value = '探针停止未确认；请重试停止，或退出应用完成清理。';
    if (componentDisposed) console.warn('诊断面板关闭后，视频探针停止未确认。');
  } finally {
    captureProbeBusy.value = false;
  }
}

onMounted(() => {
  void refreshCaptureProbeDiagnostics();
  void loadCaptureProbeCapability();
  timer = setInterval(() => {
    void refreshCaptureProbeDiagnostics();
  }, 2_000);
});
onScopeDispose(() => {
  componentDisposed = true;
  if (timer) clearInterval(timer);
  if (captureProbeSessionId.value) void stopCaptureProbe();
});
</script>

<template>
  <aside class="media-diagnostics" aria-label="媒体诊断">
    <strong>媒体诊断 <small>每 2 秒更新</small></strong>
    <p v-if="room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track && captureProbeDiagnostics">
      原生采集 {{ captureProbeDiagnostics.rawCaptureFps ?? '—' }} fps ·
      纹理输出 {{ captureProbeDiagnostics.videoOutputFps ?? '—' }} fps ·
      限帧／背压丢帧累计 {{ captureProbeDiagnostics.videoOutputDroppedFrames ?? '—' }}
    </p>
    <p v-if="processMetrics">Electron 进程（不含原生 helper）：CPU {{ processMetrics.cpuPercent }}% · 工作集合计 {{ processMetrics.memoryMb }} MB</p>
    <p v-if="statistics?.native?.state === 'running'">原生采集计数区间 FPS：
      <template v-if="statistics.nativeInterval">收到 {{ statistics.nativeInterval.receivedFps }} ·
        处理 {{ statistics.nativeInterval.processedFps }} · {{ formatFpsInterval(statistics.nativeInterval.elapsedMs) }}</template>
      <template v-else>等待统计</template>
    </p>
    <section class="native-capture-probe" aria-label="原生视频取帧探针">
      <b>原生视频取帧探针</b>
      <small>仅读取帧元数据，不输出或传输画面；不替代当前屏幕共享。</small>
      <small>WGC 探针：{{ captureProbeAvailable ? '可尝试' : '不可用' }}（{{ captureProbeReason }}） ·
        正式视频输出：{{ videoCaptureAvailable ? '可用' : '不可用' }}</small>
      <div class="native-capture-probe-controls">
        <button type="button" :disabled="sourceListLoading || captureProbeBusy || !!captureProbeSessionId"
          @click="listVideoSources()">{{ sourceListLoading ? '正在列出…' : '刷新来源' }}</button>
        <select v-model="selectedVideoSourceId" aria-label="原生视频探针来源"
          :disabled="sourceListLoading || captureProbeBusy || !!captureProbeSessionId || !videoSources.length">
          <option value="" disabled>选择窗口或显示器</option>
          <option v-for="source in videoSources" :key="source.sourceId" :value="source.sourceId">
            {{ source.kind === 'monitor' ? '显示器' : '窗口' }} · {{ source.title }} · {{ source.width }}×{{ source.height }}
          </option>
        </select>
        <button v-if="!captureProbeSessionId" type="button" :disabled="!captureProbeAvailable || !selectedVideoSourceId || sourceListLoading || captureProbeBusy"
          @click="startCaptureProbe">{{ captureProbeState === 'starting' ? '正在启动…' : '启动探针' }}</button>
        <button v-else type="button" :disabled="captureProbeBusy" @click="stopCaptureProbe">
          {{ captureProbeState === 'stopping' ? '正在停止…' : '停止探针' }}
        </button>
      </div>
      <small>探针状态：{{ captureProbeDiagnostics?.captureSuspended ? '窗口已最小化，等待恢复' : captureProbeState }}</small>
      <small v-if="captureProbeDiagnostics?.frameWidth && captureProbeDiagnostics.frameHeight">
        当前画面 {{ captureProbeDiagnostics.frameWidth }}×{{ captureProbeDiagnostics.frameHeight }} ·
        WGC 实际帧率 {{ captureProbeDiagnostics.rawCaptureFps ?? '—' }} fps ·
        元数据处理 {{ captureProbeDiagnostics.probeProcessedFps ?? '—' }} fps
      </small>
      <small v-if="captureProbeDiagnostics?.framesReceived !== null && captureProbeDiagnostics?.framesReceived !== undefined">
        已收到 {{ captureProbeDiagnostics.framesReceived }} 帧 · 已处理 {{ captureProbeDiagnostics.framesProcessed ?? '—' }} 帧 ·
        通知队列满 {{ captureProbeDiagnostics.droppedNotifications ?? 0 }} 次
      </small>
      <small v-if="captureProbeDiagnostics?.lastCaptureError">最近错误：{{ captureProbeDiagnostics.lastCaptureError }}</small>
      <small v-if="captureProbeDiagnostics?.lastFrameAgeMs !== null && captureProbeDiagnostics?.lastFrameAgeMs !== undefined">
        最近帧 {{ captureProbeDiagnostics.lastFrameAgeMs }} ms 前 · 内容尺寸变化 {{ captureProbeDiagnostics.sizeChanges ?? 0 }} 次 ·
        帧池重建 {{ captureProbeDiagnostics.framePoolRecreates ?? '—' }} 次
      </small>
      <p v-if="captureProbeError" role="status">{{ captureProbeError }}</p>
    </section>
    <p v-if="error" role="status">{{ error }}</p>
    <p v-else-if="streams.length === 0">当前没有屏幕共享。</p>
    <div v-for="stream in streams" :key="stream.identity" class="media-diagnostic-stream">
      <b>{{ stream.name }} · {{ stream.direction }}</b>
      <small v-if="stream.target">共享源 {{ stream.target.displaySurface ?? '未知' }} · 轨道设置（目标） {{ formatTrackTarget(stream.target) }}</small>
      <small v-if="stream.direction === '发送'">采集源累计 {{ stream.sourceFrames ?? '—' }} 帧 ·
        编码前采集 {{ stream.sourceFps ?? '等待统计' }} fps ·
        {{ formatFpsInterval(stream.sourceIntervalMs) }}</small>
      <small v-if="stream.direction === '发送' && !stream.nativeInput">页面收到/提交计数：此采集来源未提供。</small>
      <small v-if="stream.nativeInput">页面累计提交 {{ stream.nativeInput.submittedFrames }} 帧 ·
        写入背压丢弃 {{ stream.nativeInput.backpressureDroppedFrames }} 帧 ·
        最小化提示画面 {{ stream.nativeInput.placeholderFrames }} 帧</small>
      <small v-if="stream.nativeInput && stream.nativeInputInterval">
        页面收到 {{ stream.nativeInputInterval.receivedFps }} fps · 页面提交 {{ stream.nativeInputInterval.submittedFps }} fps ·
        {{ formatFpsInterval(stream.nativeInputInterval.elapsedMs) }}
        <template v-if="stream.nativeInputInterval.backpressureDropRate !== null">
          · 背压丢弃 {{ stream.nativeInputInterval.backpressureDropRate }}%
        </template>
      </small>
      <small v-else-if="stream.nativeInput">页面帧率与背压比例等待下一份可比较样本。</small>
      <small v-if="stream.subscription.subscribed === false">本机尚未订阅此路共享。</small>
      <small v-else-if="stream.subscription.enabled === false">本机已暂停接收此路共享。</small>
      <small v-if="stream.playbackFps !== null">累计显示 {{ stream.playbackFrames ?? '—' }} 帧 ·
        画面显示 {{ stream.playbackFps }} fps ·
        {{ formatFpsInterval(stream.playbackIntervalMs) }} · 累计显示丢帧 {{ stream.playbackDrops }}</small>
      <small v-else-if="stream.direction === '接收' && stream.subscription.subscribed !== false">本机播放 FPS 等待统计。</small>
      <small v-if="stream.layers.length === 0 && stream.subscription.subscribed === false">尚未订阅此路视频，暂无编解码统计。</small>
      <small v-else-if="stream.layers.length === 0">等待编解码统计…</small>
      <small v-for="layer in stream.layers" :key="layer.id">
        {{ layer.size }} · {{ layer.fps ?? '等待统计' }} fps · {{ formatFpsInterval(layer.intervalMs) }} ·
        累计 {{ layer.frameCount ?? '—' }} 帧 · {{ layer.bitrateKbps ?? '—' }} kbps · {{ layer.codec }}
        <template v-if="layer.active === false"> · 编码层已停用</template>
        <template v-else-if="layer.limitation"> · 受限 {{ layer.limitation }}（不能单独作为故障结论）</template>
        <template v-if="layer.lostPackets !== null"> · 累计丢包 {{ layer.lostPackets }}</template>
        <template v-if="layer.droppedFrames !== null"> · 累计解码丢帧 {{ layer.droppedFrames }}</template>
        <template v-if="layer.averageEncodeMs !== null"> · 编码 {{ layer.averageEncodeMs }} ms/帧</template>
        <template v-if="layer.encoder"> · 编码器 {{ layer.encoder }}</template>
      </small>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Track, type Participant, type Room } from 'livekit-client';
import { readTrackTarget, readVideoLayers, readVideoSourceFps, formatTrackTarget, type TrackTarget, type VideoLayerStats } from '../rtc/mediaStats';
import { isStaleVideoSourceError, resetVideoSourceSelection } from './mediaDiagnosticsSources';

const props = defineProps<{ room: Room; participants: Participant[] }>();
type StreamStats = {
  identity: string; name: string; direction: '发送' | '接收'; target: TrackTarget | null;
  sourceFps: number | null; playbackFps: number | null; playbackDrops: number | null; layers: VideoLayerStats[];
};
const streams = ref<StreamStats[]>([]);
const error = ref('');
const processMetrics = ref<{ cpuPercent: number; memoryMb: number } | null>(null);
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
const previous = new Map<string, { bytes: number; frames: number | null; timestamp: number; encodeTime: number | null }>();
const previousSource = new Map<string, { frames: number; timestamp: number }>();
const previousPlayback = new WeakMap<HTMLVideoElement, { frames: number; timestamp: number }>();
let polling = false;
let timer: ReturnType<typeof setInterval> | null = null;
let diagnosticsPolling = false;
let componentDisposed = false;

async function loadCaptureProbeCapability() {
  try {
    const capabilities = await window.lycanDesktop?.getNativeMediaCapabilities();
    captureProbeAvailable.value = capabilities?.captureProbe.available ?? false;
    captureProbeReason.value = capabilities?.captureProbe.reason ?? 'desktopUnavailable';
    videoCaptureAvailable.value = capabilities?.videoCapture.available ?? false;
  } catch {
    captureProbeAvailable.value = false;
    captureProbeReason.value = 'mediaHelperUnavailable';
  }
}

async function listVideoSources(sourceExpired = false) {
  if (!window.lycanDesktop || sourceListLoading.value || captureProbeSessionId.value) return;
  const previousSelection = selectedVideoSourceId.value;
  sourceListLoading.value = true;
  captureProbeError.value = '';
  try {
    const snapshot = await window.lycanDesktop.listNativeVideoSources();
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
  if (!window.lycanDesktop || diagnosticsPolling || !captureProbeSessionId.value) return;
  diagnosticsPolling = true;
  try {
    const diagnostics = await window.lycanDesktop.getNativeMediaDiagnostics();
    captureProbeDiagnostics.value = diagnostics;
    captureProbeState.value = diagnostics.state;
    if (diagnostics.state === 'idle' && !diagnostics.sessionId) {
      captureProbeSessionId.value = null;
      captureProbeState.value = diagnostics.lastCaptureError ? 'failed' : 'idle';
    }
  } catch {
    captureProbeSessionId.value = null;
    captureProbeState.value = 'failed';
    captureProbeError.value = '探针进程已停止或诊断请求超时；请刷新来源后重试。';
  } finally {
    diagnosticsPolling = false;
  }
}

async function startCaptureProbe() {
  if (!window.lycanDesktop || !captureProbeAvailable.value || !selectedVideoSourceId.value
      || sourceListLoading.value || captureProbeBusy.value || captureProbeSessionId.value) return;
  captureProbeBusy.value = true;
  captureProbeState.value = 'starting';
  captureProbeError.value = '';
  try {
    const result = await window.lycanDesktop.startNativeCaptureProbe(selectedVideoSourceId.value);
    captureProbeSessionId.value = result.sessionId;
    captureProbeState.value = 'running';
    if (componentDisposed) {
      await window.lycanDesktop.stopNativeCaptureProbe(result.sessionId).catch(() => undefined);
      return;
    }
    await refreshCaptureProbeDiagnostics();
  } catch (error) {
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
    captureProbeDiagnostics.value = await window.lycanDesktop.getNativeMediaDiagnostics();
  } catch {
    captureProbeSessionId.value = null;
    captureProbeState.value = 'failed';
    captureProbeError.value = '探针停止未确认；主进程会阻止重复启动，并在应用退出时继续清理。';
  } finally {
    captureProbeBusy.value = false;
  }
}

function readPlayback(track: Track) {
  const video = track.attachedElements.filter((element): element is HTMLVideoElement =>
    element instanceof HTMLVideoElement && element.isConnected && element.getBoundingClientRect().width > 0)
    .sort((left, right) => right.clientWidth - left.clientWidth)[0];
  if (!video) return { fps: null, dropped: null };
  const quality = video.getVideoPlaybackQuality();
  const timestamp = performance.now();
  const displayedFrames = quality.totalVideoFrames - quality.droppedVideoFrames;
  const last = previousPlayback.get(video);
  previousPlayback.set(video, { frames: displayedFrames, timestamp });
  const elapsedSeconds = last ? (timestamp - last.timestamp) / 1000 : 0;
  return {
    fps: last && elapsedSeconds > 0 && displayedFrames >= last.frames
      ? Math.round((displayedFrames - last.frames) / elapsedSeconds) : null,
    dropped: quality.droppedVideoFrames,
  };
}

async function refresh() {
  // 面板隐藏或页面不可见时不做统计读取，避免后台窗口持续占用采集与解码线程。
  if (polling || document.hidden) return;
  polling = true;
  try {
    const results = await Promise.all(props.participants.map(async (participant) => {
      const track = participant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (!track) return null;
      const report = await track.getRTCStatsReport();
      const local = participant === props.room.localParticipant;
      const settings = local ? track.mediaStreamTrack.getSettings() : null;
      const playback = readPlayback(track);
      return {
        identity: participant.identity,
        name: participant.name || participant.identity,
        direction: local ? '发送' as const : '接收' as const,
        target: settings ? readTrackTarget(settings) : null,
        sourceFps: local && report ? readVideoSourceFps(report, track.mediaStreamTrack.id, previousSource) : null,
        playbackFps: playback.fps,
        playbackDrops: playback.dropped,
        layers: report ? readVideoLayers(report, local ? 'outbound-rtp' : 'inbound-rtp', previous, track.mediaStreamTrack.id) : [],
      };
    }));
    streams.value = results.filter((result): result is StreamStats => result !== null);
    processMetrics.value = await window.lycanDesktop?.getProcessMetrics().catch(() => null) ?? null;
    error.value = '';
  } catch {
    error.value = '暂时无法读取媒体统计，请确认共享仍在进行。';
  } finally {
    polling = false;
  }
}

function refreshOnVisible() {
  if (!document.hidden) void refresh();
}

onMounted(() => {
  void refresh();
  void loadCaptureProbeCapability();
  timer = setInterval(() => {
    void refresh();
    if (captureProbeSessionId.value) void refreshCaptureProbeDiagnostics();
  }, 2_000);
  document.addEventListener('visibilitychange', refreshOnVisible);
});
onScopeDispose(() => {
  componentDisposed = true;
  if (timer) clearInterval(timer);
  document.removeEventListener('visibilitychange', refreshOnVisible);
  if (captureProbeSessionId.value) void stopCaptureProbe();
});
</script>

<template>
  <aside class="media-diagnostics" aria-label="媒体诊断">
    <strong>媒体诊断 <small>每 2 秒更新</small></strong>
    <p v-if="processMetrics">本应用进程：CPU {{ processMetrics.cpuPercent }}% · 内存 {{ processMetrics.memoryMb }} MB</p>
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
      <small v-if="stream.direction === '发送'">实际采集 {{ stream.sourceFps ?? '—' }} fps</small>
      <small v-if="stream.playbackFps !== null">画面显示 {{ stream.playbackFps }} fps · 累计显示丢帧 {{ stream.playbackDrops }}</small>
      <small v-if="stream.layers.length === 0">等待编解码统计…</small>
      <small v-for="layer in stream.layers" :key="layer.id">
        {{ layer.size }} · {{ layer.fps ?? '—' }} fps · {{ layer.bitrateKbps ?? '—' }} kbps · {{ layer.codec }}
        <template v-if="layer.limitation"> · 受限 {{ layer.limitation }}</template>
        <template v-if="layer.lostPackets !== null"> · 累计丢包 {{ layer.lostPackets }}</template>
        <template v-if="layer.droppedFrames !== null"> · 累计解码丢帧 {{ layer.droppedFrames }}</template>
        <template v-if="layer.averageEncodeMs !== null"> · 编码 {{ layer.averageEncodeMs }} ms/帧</template>
        <template v-if="layer.encoder"> · 编码器 {{ layer.encoder }}</template>
      </small>
    </div>
  </aside>
</template>

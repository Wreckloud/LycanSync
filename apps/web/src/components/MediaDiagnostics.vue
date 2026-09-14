<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Track, type Participant, type Room } from 'livekit-client';
import { readTrackTarget, readVideoLayers, readVideoSourceFps, formatTrackTarget, type TrackTarget, type VideoLayerStats } from '../rtc/mediaStats';

const props = defineProps<{ room: Room; participants: Participant[] }>();
type StreamStats = {
  identity: string; name: string; direction: '发送' | '接收'; target: TrackTarget | null;
  sourceFps: number | null; playbackFps: number | null; playbackDrops: number | null; layers: VideoLayerStats[];
};
const streams = ref<StreamStats[]>([]);
const error = ref('');
const processMetrics = ref<{ cpuPercent: number; memoryMb: number } | null>(null);
const previous = new Map<string, { bytes: number; frames: number | null; timestamp: number; encodeTime: number | null }>();
const previousSource = new Map<string, { frames: number; timestamp: number }>();
const previousPlayback = new WeakMap<HTMLVideoElement, { frames: number; timestamp: number }>();
let polling = false;
let timer: ReturnType<typeof setInterval> | null = null;

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
  timer = setInterval(() => void refresh(), 2_000);
  document.addEventListener('visibilitychange', refreshOnVisible);
});
onScopeDispose(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener('visibilitychange', refreshOnVisible);
});
</script>

<template>
  <aside class="media-diagnostics" aria-label="媒体诊断">
    <strong>媒体诊断 <small>每 2 秒更新</small></strong>
    <p v-if="processMetrics">本应用进程：CPU {{ processMetrics.cpuPercent }}% · 内存 {{ processMetrics.memoryMb }} MB</p>
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

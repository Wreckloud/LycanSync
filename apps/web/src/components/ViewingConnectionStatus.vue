<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { Track, type Participant } from 'livekit-client';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';
import { readVideoLayers, type VideoLayerStats } from '../rtc/mediaStats';

const props = defineProps<{ participant: Participant; revision: number; active: boolean; local: boolean;
  snapshot?: MediaDiagnosticsSnapshot | null }>();
const indicator = ref<HTMLElement | null>(null);
const layer = shallowRef<VideoLayerStats>();
const latency = ref<number>();
const visible = ref(false);
let observer: IntersectionObserver | undefined;
let page: Document | undefined;
let inView = false;
function visibilityChanged() { visible.value = inView && !page?.hidden; }
onMounted(() => {
  const element = indicator.value!;
  page = element.ownerDocument;
  page.addEventListener('visibilitychange', visibilityChanged);
  observer = new page.defaultView!.IntersectionObserver(entries => {
    inView = entries[entries.length - 1]!.isIntersecting;
    visibilityChanged();
  });
  observer.observe(element);
});
onScopeDispose(() => {
  observer?.disconnect();
  page?.removeEventListener('visibilitychange', visibilityChanged);
});
const signal = computed(() => {
  void props.revision;
  return ({ excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 })[props.participant.connectionQuality] ?? 0;
});
const title = computed(() => {
  const sample = layer.value;
  const loss = props.local ? sample?.receiverReportedLossPercent : sample?.receiveLossPercent;
  return [`连接质量：${['未知或中断','较弱','良好','优秀'][signal.value]}`,
    `到媒体服务器的往返延迟：${latency.value === undefined ? '—' : latency.value + ' ms'}`,
    `${props.local ? '发送' : '接收'}：${sample?.size ?? '—'} · ${sample?.fps ?? '—'} FPS · ${sample?.bitrateKbps ?? '—'} kbps`,
    `丢包：${loss == null ? '—' : loss + '%'}`].join('\n');
});
watch(() => {
  void props.revision;
  return props.active && visible.value ? props.participant.getTrackPublication(Track.Source.ScreenShare)?.track : undefined;
}, (track, _, cleanup) => {
  latency.value = undefined;
  layer.value = undefined;
  if (!track) return;
  const previous: Parameters<typeof readVideoLayers>[2] = new Map();
  const trackId = track.mediaStreamTrack.id;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let lastLatencyAt = 0;
  cleanup(() => { stopped = true; clearTimeout(timer); });
  async function sample() {
    try {
      const snapshot = props.snapshot;
      const time = snapshot ? Date.parse(snapshot.time) : 0;
      const stream = Date.now() - time < 4000 && snapshot?.streams.find(item =>
        item.identity === props.participant.identity && (props.local ? item.sessionKey?.startsWith(trackId + ':') : item.sessionKey === trackId));
      let layers: VideoLayerStats[] = [];
      if (stream) layers = stream.layers;
      else {
        const report = await track?.getRTCStatsReport?.();
        if (report) layers = readVideoLayers(report, props.local ? 'outbound-rtp' : 'inbound-rtp', previous, trackId);
      }
      if (stopped) return;
      layer.value = layers.find(item => (item.bitrateKbps ?? 0) > 0) ?? layers[0];
      if (layer.value?.transportRoundTripMs != null) {
        latency.value = layer.value.transportRoundTripMs;
        lastLatencyAt = stream ? time : Date.now();
      }
    } catch {
      if (!stopped) layer.value = undefined;
    } finally {
      if (!stopped) {
        if (Date.now() - lastLatencyAt > 12000) latency.value = undefined;
        timer = setTimeout(sample, 2000);
      }
    }
  }
  void sample();
}, { immediate: true });
</script>

<template>
  <span ref="indicator" class="viewing-connection" :title="title" :aria-label="title" tabindex="0">
    <span class="signal-bars" aria-hidden="true"><i v-for="n in 3" :key="n" :class="{ lit: n <= signal }" /></span>
    <span class="latency">{{ latency === undefined ? '—' : latency + ' ms' }}</span>
  </span>
</template>

<style scoped>
.viewing-connection { flex: none; display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; }
.signal-bars { height: 11px; display: inline-flex; align-items: flex-end; gap: 2px; }
.signal-bars i { width: 3px; height: 4px; background: var(--muted); opacity: .45; }
.signal-bars i:nth-child(2) { height: 7px; }
.signal-bars i:nth-child(3) { height: 10px; }
.signal-bars .lit { background: var(--success, #48bd87); opacity: 1; }
.latency { width: 7ch; font-variant-numeric: tabular-nums; }
</style>

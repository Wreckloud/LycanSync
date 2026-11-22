<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import ConnectionSignal from './ConnectionSignal.vue';
import { Track, type Participant } from 'livekit-client';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';
import { readTransportFeedback, readVideoLayers, type VideoLayerStats } from '../rtc/mediaStats';

const props = defineProps<{ participant: Participant; revision: number; active: boolean; local: boolean;
  voiceTrack?: Track; snapshot?: MediaDiagnosticsSnapshot | null }>();
const indicator = ref<HTMLElement | null>(null);
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
const quality = computed(() => {
  void props.revision;
  return props.participant.connectionQuality;
});
watch(() => {
  void props.revision;
  if (!props.active || !visible.value) return;
  return props.participant.getTrackPublication(Track.Source.ScreenShare)?.track ?? props.voiceTrack;
}, (track, _, cleanup) => {
  latency.value = undefined;
  if (!track) return;
  const previous: Parameters<typeof readVideoLayers>[2] = new Map();
  const trackId = track.mediaStreamTrack?.id;
  let audioFeedback: ReturnType<typeof readTransportFeedback> | undefined;
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
        if (stopped) return;
        if (report && track && track === props.voiceTrack) {
          const direction = track.isLocal ? 'outbound-rtp' : 'inbound-rtp';
          report.forEach(stat => {
            if (stat.type !== direction || (stat.kind ?? stat.mediaType) !== 'audio') return;
            audioFeedback = readTransportFeedback(report, stat.transportId, audioFeedback);
            if (audioFeedback.milliseconds !== null) {
              latency.value = Math.round(audioFeedback.milliseconds);
              lastLatencyAt = Date.now();
            }
          });
        } else if (report) layers = readVideoLayers(report, props.local ? 'outbound-rtp' : 'inbound-rtp', previous, trackId);
      }
      if (stopped) return;
      const layer = layers.find(item => (item.bitrateKbps ?? 0) > 0) ?? layers[0];
      if (layer?.transportRoundTripMs != null) {
        latency.value = layer.transportRoundTripMs;
        lastLatencyAt = stream ? time : Date.now();
      }
    } catch {
      // 暂留最近一次有效采样，超过有效期时统一清空。
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
  <span ref="indicator" class="viewing-connection">
    <ConnectionSignal :quality="quality" />
    <span class="latency">{{ latency === undefined ? '—' : latency + ' ms' }}</span>
  </span>
</template>

<style scoped>
.latency { width: 7ch; font-variant-numeric: tabular-nums; }
</style>

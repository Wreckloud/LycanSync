<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watchEffect } from 'vue';

const props = defineProps<{ track: MediaStreamTrack; context: AudioContext; responsive?: boolean }>();
const surface = ref<HTMLElement>();
const visible = ref(false);
const foreground = ref(!document.hidden);
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motion.matches);
let observer: IntersectionObserver | undefined;
const updateMotion = () => { reduced.value = motion.matches; };
const updateVisibility = () => { foreground.value = !document.hidden; };
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible.value = entries[0].isIntersecting; });
  observer.observe(surface.value!);
  document.addEventListener('visibilitychange', updateVisibility);
  motion.addEventListener('change', updateMotion);
});
onScopeDispose(() => {
  observer?.disconnect();
  document.removeEventListener('visibilitychange', updateVisibility);
  motion.removeEventListener('change', updateMotion);
});

watchEffect(onCleanup => {
  const element = surface.value;
  if (!element || !visible.value || !foreground.value || reduced.value || props.context.state === 'closed') return;
  const context = props.context;
  const analyser = context.createAnalyser();
  const responsive = props.responsive;
  const frameMs = responsive ? 48 : 80;
  analyser.fftSize = responsive ? 2048 : 1024;
  if (responsive) {
    analyser.minDecibels = -72;
    analyser.maxDecibels = -18;
    analyser.smoothingTimeConstant = .22;
  }
  const input = context.createMediaStreamSource(new MediaStream([props.track]));
  // 只读取频谱，同一轨道的实际播放与音量继续由房间管理。
  input.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const bars = Array.from(element.children) as HTMLElement[];
  const edges = Array.from({ length: bars.length + 1 }, (_, i) =>
    Math.min(bins.length, Math.round(65 * (16000 / 65) ** (i / bars.length) * analyser.fftSize / context.sampleRate)));
  const peaks = bars.map(() => 4);
  const holdMs = bars.map(() => 0);
  function draw() {
    analyser.getByteFrequencyData(bins);
    bars.forEach((bar, i) => {
      let level = 0;
      for (let bin = edges[i]; bin < Math.max(edges[i] + 1, edges[i + 1]); bin++) level = Math.max(level, bins[bin] ?? 0);
      const strength = level / 255;
      const height = 4 + Math.round(responsive ? strength ** 1.6 * 94 : strength * 50);
      if (height >= peaks[i]) { peaks[i] = height; holdMs[i] = 240; }
      else if (holdMs[i] > 0) holdMs[i] -= frameMs;
      else peaks[i] = Math.max(height, peaks[i] - frameMs / 16);
      bar.style.setProperty('--level', height + 'px');
      bar.style.setProperty('--peak', peaks[i] + 'px');
    });
  }
  draw();
  const timer = window.setInterval(draw, frameMs);
  onCleanup(() => {
    window.clearInterval(timer);
    input.disconnect();
    analyser.disconnect();
    bars.forEach(bar => { bar.style.removeProperty('--level'); bar.style.removeProperty('--peak'); });
  });
}, { flush: 'post' });
</script>

<template>
  <div ref="surface" class="spectrum" aria-hidden="true"><i v-for="i in 21" :key="i" /></div>
</template>

<style scoped>
.spectrum { position: absolute; inset: 0 5px; display: grid; grid-template-columns: repeat(21, minmax(0, 8px)); align-items: end; justify-content: center; gap: 2px; overflow: hidden; opacity: .3; pointer-events: none; }
:global(.participant-media:has(.spectrum) .large-avatar) { z-index: 1; }
.spectrum i { position: relative; height: var(--level, 4px); background: var(--muted); }
.spectrum i::after { content: ''; position: absolute; inset-inline: 0; bottom: calc(var(--peak, 4px) - 2px); height: 2px; background: var(--text); }
</style>

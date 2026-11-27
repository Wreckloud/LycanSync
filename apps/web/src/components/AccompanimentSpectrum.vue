<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue';

const props = defineProps<{ track?: MediaStreamTrack; context?: AudioContext | null; responsive: boolean }>();
const surface = ref<HTMLElement>();
const visible = ref(false);
const showBaseline = ref(false);
let aboveBaselineLastFrame = false;
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const bands = Array.from({ length: 21 }, () => ({ height: 0, peak: 0, hold: 0 }));

watch(surface, (element, _, onCleanup) => {
  if (!element) return;
  let inView = false;
  const refresh = () => { visible.value = inView && !document.hidden && !motion.matches; };
  const observer = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; refresh(); });
  observer.observe(element);
  document.addEventListener('visibilitychange', refresh);
  motion.addEventListener('change', refresh);
  onCleanup(() => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', refresh);
    motion.removeEventListener('change', refresh);
    visible.value = false;
  });
}, { flush: 'post' });

watchEffect(onCleanup => {
  const element = surface.value;
  if (!element) return;
  const bars = Array.from(element.children) as HTMLElement[];
  if (!visible.value) {
    bands.forEach((band, i) => {
      band.height = band.peak = band.hold = 0;
      bars[i].style.removeProperty('--level');
      bars[i].style.removeProperty('--peak');
    });
    aboveBaselineLastFrame = false;
    showBaseline.value = false;
    return;
  }

  const { context, track, responsive } = props;
  const targets = new Uint8Array(bands.length);
  let sample: (() => void) | undefined;
  if (track && context && context.state !== 'closed') {
    const analyser = context.createAnalyser();
    analyser.fftSize = responsive ? 2048 : 1024;
    if (responsive) {
      analyser.minDecibels = -78;
      analyser.maxDecibels = -18;
      analyser.smoothingTimeConstant = .4;
    }
    const input = context.createMediaStreamSource(new MediaStream([track]));
    input.connect(analyser);
    onCleanup(() => { input.disconnect(); analyser.disconnect(); });
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const edges = Array.from({ length: bands.length + 1 }, (_, i) =>
      Math.min(bins.length, Math.round(65 * (16000 / 65) ** (i / bands.length) * analyser.fftSize / context.sampleRate)));
    sample = () => {
      analyser.getByteFrequencyData(bins);
      for (let i = 0; i < targets.length; i++) {
        let level = 0;
        for (let bin = edges[i]; bin < Math.max(edges[i] + 1, edges[i + 1]); bin++) level = Math.max(level, bins[bin] ?? 0);
        const strength = level / 255;
        targets[i] = Math.round(responsive ? strength ** 1.5 * 82 : strength * 50);
      }
    };
  }

  // 停止分享就释放音频节点，最后几帧只用已有的柱高和峰值，按静音时的速度落完。
  function draw() {
    sample?.();
    let remaining = false;
    bands.forEach((band, i) => {
      const height = targets[i] || Math.max(0, band.height - 14);
      const previousPeak = band.peak;
      if (height > 0 && height >= band.peak) { band.peak = height; band.hold = 3; }
      else if (band.hold > 0) band.hold--;
      else band.peak = Math.max(height, band.peak - 5);
      if (height !== band.height) bars[i].style.setProperty('--level', height + 'px');
      if (band.peak !== previousPeak) bars[i].style.setProperty('--peak', band.peak + 'px');
      band.height = height;
      remaining ||= band.peak > 0;
    });
    // 各频段共用底线；全部落到底的这一帧仍显示，下一次采样仍静音才一起隐藏。
    const show = remaining || aboveBaselineLastFrame;
    aboveBaselineLastFrame = remaining;
    showBaseline.value = show;
    return show;
  }

  if (draw() || sample) {
    const timer = window.setInterval(() => {
      if (!draw() && !sample) window.clearInterval(timer);
    }, 80);
    onCleanup(() => window.clearInterval(timer));
  }
}, { flush: 'post' });
</script>

<template>
  <div v-if="(track && context) || showBaseline" ref="surface" class="spectrum" :class="{ 'has-baseline': showBaseline }" aria-hidden="true"><i v-for="i in bands.length" :key="i" /></div>
</template>

<style scoped>
.spectrum { position: absolute; inset: 0 5px; display: grid; grid-template-columns: repeat(21, minmax(0, 8px)); align-items: end; justify-content: center; gap: 2px; overflow: hidden; opacity: .3; pointer-events: none; }
:global(.participant-media:has(.spectrum) .large-avatar) { z-index: 1; }
.spectrum.has-baseline { --spectrum-baseline: 4px; }
.spectrum i { position: relative; height: calc(var(--spectrum-baseline, 0px) + var(--level, 0px)); background: var(--muted); }
.spectrum i::after { content: ''; position: absolute; inset-inline: 0; bottom: calc(var(--spectrum-baseline, 0px) + var(--peak, 0px) - 2px); height: 2px; background: var(--text); }
</style>

<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue';

const props = defineProps<{ track?: MediaStreamTrack; context?: AudioContext | null; responsive: boolean }>();
const surface = ref<HTMLElement>();
const visible = ref(false);
const showBaseline = ref(false);
let baselineFramesLeft = 0;
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
    baselineFramesLeft = 0;
    showBaseline.value = false;
    return;
  }

  const { context, track, responsive } = props;
  const targets = new Uint8Array(bands.length);
  let attack = 0;
  let sample: (() => void) | undefined;
  if (track && context && context.state !== 'closed') {
    const analyser = context.createAnalyser();
    analyser.fftSize = responsive ? 2048 : 1024;
    if (responsive) {
      analyser.minDecibels = -78;
      analyser.maxDecibels = -2;
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
      let strongest = 0;
      for (let i = 0; i < targets.length; i++) {
        let level = 0;
        for (let bin = edges[i]; bin < Math.max(edges[i] + 1, edges[i + 1]); bin++) level = Math.max(level, bins[bin] ?? 0);
        targets[i] = responsive ? level : Math.round(level / 255 * 50);
        strongest = Math.max(strongest, level);
      }
      if (!responsive) return;
      // 各频段共用有限的响度补偿，接近底噪时取消补偿，避免静音段被抬高。
      const rangeDb = analyser.maxDecibels - analyser.minDecibels;
      const peakDb = analyser.minDecibels + strongest / 255 * rangeDb;
      const compensationDb = Math.min(22, Math.max(-8, (-18 - peakDb) * .8))
        * Math.min(1, Math.max(0, (peakDb + 72) / 16));
      const peakStrength = Math.max(0, Math.min(1, (peakDb - analyser.minDecibels + compensationDb) / 60));
      // 最强频段决定整排的最高柱，其余按与它的分贝差回落，给弱谐波留出贴底空间。
      for (let i = 0; i < targets.length; i++) {
        const belowPeakDb = (strongest - targets[i]) / 255 * rangeDb;
        const strength = targets[i] > 0 ? Math.max(0, peakStrength - belowPeakDb / 32) : 0;
        targets[i] = Math.round(strength ** 1.5 * 82);
      }
    };
  }

  // 停止分享就释放音频节点，最后几帧只用已有的柱高和峰值，按静音时的速度落完。
  function draw() {
    sample?.();
    const sounding = targets.some(level => level > 0);
    attack = sounding ? Math.min(1, attack + .25) : Math.max(0, attack - .25);
    let remaining = false;
    bands.forEach((band, i) => {
      const height = responsive
        ? Math.max(Math.round(targets[i] * attack), Math.round(band.height * .64) - 1)
        : targets[i] || Math.max(0, band.height - 14);
      const previousPeak = band.peak;
      if (height > 0 && height >= band.peak) { band.peak = height; band.hold = 3; }
      else if (band.hold > 0) band.hold--;
      else band.peak = Math.max(height, band.peak - 4);
      if (height !== band.height) bars[i].style.setProperty('--level', height + 'px');
      if (band.peak !== previousPeak) bars[i].style.setProperty('--peak', band.peak + 'px');
      band.height = height;
      remaining ||= band.peak > 0;
    });
    // 最后一条峰值落下后，整排底线再停留四次采样（320 ms）。
    const show = remaining || baselineFramesLeft > 0;
    baselineFramesLeft = remaining ? 4 : Math.max(0, baselineFramesLeft - 1);
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
.spectrum i::after { content: ''; position: absolute; inset-inline: 0; bottom: calc(var(--spectrum-baseline, 0px) + var(--peak, 0px) - 2px); height: min(2px, var(--peak, 0px)); background: var(--text); }
</style>

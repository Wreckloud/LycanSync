<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';

const props = defineProps<{ source: string; first: number; span: number; suspended: boolean }>();
const strip = ref<HTMLCanvasElement | null>(null);
const frameWidth = 112;
const frameHeight = 64;
const cache = new Map<number, HTMLCanvasElement>();
let columns = 0;
let decoder: HTMLVideoElement | undefined;
let pending: number | null = null;
let resize: ResizeObserver | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let unavailable = false;

function releaseDecoder() {
  clearTimeout(timeout);
  clearTimeout(idle);
  pending = null;
  if (!decoder) return;
  decoder.onloadedmetadata = decoder.onseeked = decoder.onerror = null;
  decoder.removeAttribute('src');
  decoder.load();
  decoder = undefined;
}

function stopSampling() {
  // 媒体无法取帧时仍可用主播放器定位并保存选区。
  unavailable = true;
  releaseDecoder();
  nextFrame();
}

function nextFrame() {
  const context = strip.value?.getContext('2d');
  if (!context || !columns || !props.span) return;
  const interval = props.span / columns;
  let missing: number | undefined;
  for (let i = 0; i < columns; i++) {
    const time = props.first + (i + 0.5) * interval;
    let nearest: number | undefined;
    let distance = Infinity;
    for (const key of cache.keys()) {
      const diff = Math.abs(key - time);
      if (diff <= distance) { nearest = key; distance = diff; }
    }
    // 平移中先用相邻缓存；跳得太远时保留上一张，直到目标帧就绪再替换。
    if (nearest !== undefined && distance <= interval) context.drawImage(cache.get(nearest)!, i * frameWidth, 0);
    else if (unavailable) context.clearRect(i * frameWidth, 0, frameWidth, frameHeight);
    if (distance > interval / 4) missing ??= time;
  }
  if (unavailable || settle !== undefined || pending !== null) return;
  if (missing === undefined || props.suspended) {
    // 留一小段时间给连续缩放复用解码器；闲置后只保留小图。
    if (decoder) { clearTimeout(idle); idle = setTimeout(releaseDecoder, 1500); }
    return;
  }
  clearTimeout(idle);
  if (!decoder) {
    decoder = document.createElement('video');
    decoder.muted = true;
    decoder.preload = 'metadata';
    decoder.onloadedmetadata = () => { clearTimeout(timeout); nextFrame(); };
    decoder.onseeked = capture;
    decoder.onerror = stopSampling;
    timeout = setTimeout(stopSampling, 8000);
    decoder.src = props.source;
  } else if (decoder.readyState >= HTMLMediaElement.HAVE_METADATA) {
    pending = missing;
    clearTimeout(timeout);
    timeout = setTimeout(stopSampling, 8000);
    decoder.currentTime = missing;
  }
}

function capture() {
  if (!decoder || pending === null) return;
  clearTimeout(timeout);
  const frame = document.createElement('canvas');
  frame.width = frameWidth; frame.height = frameHeight;
  const context = frame.getContext('2d');
  if (!context || !decoder.videoWidth || !decoder.videoHeight) { stopSampling(); return; }
  const scale = Math.max(frameWidth / decoder.videoWidth, frameHeight / decoder.videoHeight);
  const width = frameWidth / scale, height = frameHeight / scale;
  context.drawImage(decoder, (decoder.videoWidth - width) / 2, (decoder.videoHeight - height) / 2,
    width, height, 0, 0, frameWidth, frameHeight);
  cache.set(pending, frame);
  if (cache.size > 48) cache.delete(cache.keys().next().value!);
  pending = null;
  nextFrame();
}

function schedule() {
  clearTimeout(settle);
  settle = setTimeout(() => { settle = undefined; nextFrame(); }, 160);
  nextFrame();
}
watch(() => [props.first, props.span, props.suspended], schedule);
onMounted(() => {
  const canvas = strip.value!;
  resize = new ResizeObserver(([entry]) => {
    const count = Math.min(16, Math.ceil(entry.contentRect.width / Math.max(1, entry.contentRect.height * 16 / 9)));
    if (count === columns) return;
    columns = count;
    canvas.width = count * frameWidth;
    schedule();
  });
  resize.observe(canvas);
});
onScopeDispose(() => {
  resize?.disconnect();
  clearTimeout(settle);
  releaseDecoder();
  cache.clear();
});
</script>

<template><canvas ref="strip" class="filmstrip" :height="frameHeight" aria-hidden="true" /></template>

<style scoped>
.filmstrip { display: block; width: 100%; height: 100%; background: var(--panel-raised); }
</style>

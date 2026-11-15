<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Play } from '@lucide/vue';

const props = defineProps<{ source: string; disabled: boolean }>();
const emit = defineEmits<{ preview: [] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref(false);
let disposed = false;
let observer: IntersectionObserver | undefined;
let video: HTMLVideoElement | undefined;
function release() {
  if (!video) return;
  video.onloadedmetadata = null; video.onseeked = null; video.onerror = null;
  video.pause(); video.removeAttribute('src'); video.load(); video = undefined;
}
function load() {
  if (disposed || video || ready.value || failed.value || props.disabled) return;
  const current = video = document.createElement('video');
  current.muted = true; current.preload = 'auto';
  current.onloadedmetadata = () => {
    if (video !== current) return;
    current.currentTime = Number.isFinite(current.duration) ? Math.min(0.1, current.duration / 2) : 0;
  };
  current.onseeked = () => {
    if (video !== current || !canvas.value) return;
    const context = canvas.value.getContext('2d');
    if (context && current.videoWidth && current.videoHeight) {
      const scale = Math.min(240 / current.videoWidth, 136 / current.videoHeight);
      canvas.value.width = Math.max(1, Math.round(current.videoWidth * scale));
      canvas.value.height = Math.max(1, Math.round(current.videoHeight * scale));
      context.drawImage(current, 0, 0, canvas.value.width, canvas.value.height);
      ready.value = true;
    }
    release();
  };
  current.onerror = () => { failed.value = true; release(); };
  current.src = props.source;
}
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) load();
    else release();
  });
  if (frame.value) observer.observe(frame.value);
});
onScopeDispose(() => { disposed = true; observer?.disconnect(); release(); });
</script>

<template>
  <button ref="frame" type="button" class="recording-thumbnail" :disabled="disabled" aria-label="预览录像" title="预览录像" @click="emit('preview')">
    <canvas ref="canvas" v-show="ready" aria-hidden="true" />
    <Play :size="24" aria-hidden="true" />
  </button>
</template>

<style scoped>
.recording-thumbnail { position: relative; display: grid; place-items: center; flex: 0 0 120px; width: 120px; height: 68px; padding: 0; overflow: hidden; border-radius: 6px; background: var(--background); }
.recording-thumbnail canvas { max-width: 100%; max-height: 100%; }
.recording-thumbnail svg { position: absolute; padding: 6px; box-sizing: content-box; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
</style>

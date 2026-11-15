<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Play } from '@lucide/vue';

const props = defineProps<{ source: string; disabled: boolean; passive?: boolean }>();
const emit = defineEmits<{ preview: [] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref(false);
let disposed = false;
let observer: IntersectionObserver | undefined;
let video: HTMLVideoElement | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
function release() {
  clearTimeout(timeout);
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
  const capture = async () => {
    if (video !== current || !canvas.value) return;
    current.pause();
    let bitmap: ImageBitmap | undefined;
    try {
      const scale = Math.min(240 / current.videoWidth, 136 / current.videoHeight);
      bitmap = await createImageBitmap(current, { resizeWidth: Math.max(1, Math.round(current.videoWidth * scale)),
        resizeHeight: Math.max(1, Math.round(current.videoHeight * scale)) });
      if (video !== current || !canvas.value) return;
      const context = canvas.value.getContext('2d');
      if (!context) throw new Error('thumbnailCanvasUnavailable');
      canvas.value.width = bitmap.width; canvas.value.height = bitmap.height;
      context.drawImage(bitmap, 0, 0);
      // 保留小尺寸像素副本，再释放视频解码器，避免空白纹理留在封面上。
      context.putImageData(context.getImageData(0, 0, bitmap.width, bitmap.height), 0, 0);
      ready.value = true;
    } catch {
      if (video === current) failed.value = true;
    } finally {
      bitmap?.close();
      if (video === current) release();
    }
  };
  const fail = () => { if (video === current) { failed.value = true; release(); } };
  current.onseeked = () => {
    if (video !== current) return;
    current.requestVideoFrameCallback(() => { void capture(); });
    void current.play().catch(fail);
  };
  timeout = setTimeout(fail, 8000);
  current.onerror = fail;
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
  <component :is="passive ? 'div' : 'button'" ref="frame" type="button" class="recording-thumbnail" :disabled="passive ? undefined : disabled" :aria-label="passive ? '录像封面' : '预览录像'" :title="passive ? undefined : '预览录像'" @click="!passive && emit('preview')">
    <canvas ref="canvas" v-show="ready" aria-hidden="true" />
    <Play :size="24" aria-hidden="true" />
  </component>
</template>

<style scoped>
.recording-thumbnail { position: relative; display: grid; place-items: center; flex: 0 0 120px; width: 120px; height: 68px; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--background); }
.recording-thumbnail canvas { max-width: 100%; max-height: 100%; }
.recording-thumbnail svg { position: absolute; padding: 6px; box-sizing: content-box; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
</style>

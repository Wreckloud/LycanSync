<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import HoverHint from './HoverHint.vue';
import { Download, X } from '@lucide/vue';

defineProps<{ source: string; downloadable?: boolean; downloading?: boolean }>();
const emit = defineEmits<{ close: []; download: []; error: []; metadata: [duration: number]; time: [seconds: number] }>();
const player = ref<HTMLVideoElement | null>(null);
const aspectRatio = ref(16 / 9);
const failed = ref(false);
function playbackFailed() {
  if (failed.value) return;
  failed.value = true;
  player.value?.pause();
  player.value?.removeAttribute('src');
  player.value?.load();
  emit('error');
}
function measureVideo() {
  const video = player.value;
  if (!video) return;
  if (!video.videoWidth || !video.videoHeight) { playbackFailed(); return; }
  aspectRatio.value = video.videoWidth / video.videoHeight;
  emit('metadata', video.duration);
}
defineExpose({ player });
const closeButton = ref<HTMLButtonElement | null>(null);
onMounted(() => closeButton.value?.focus({ preventScroll: true }));
onScopeDispose(() => {
  player.value?.pause();
  player.value?.removeAttribute('src');
  player.value?.load();
});
</script>

<template>
  <div class="media-video-surface">
    <HoverHint text="关闭" placement="top" class="media-close-hint"><button ref="closeButton" type="button" class="media-viewer-close" aria-label="关闭查看器" @click="emit('close')"><X :size="24" /></button></HoverHint>
    <div class="media-video-stage">
      <video v-if="!failed" ref="player" :src="source" :style="{ '--video-ratio': aspectRatio }" controls playsinline preload="metadata" tabindex="0" @timeupdate="emit('time', player?.currentTime ?? 0)" @loadedmetadata="measureVideo" @error="playbackFailed" />
    </div>
    <slot name="controls" />
    <div v-if="downloadable" class="media-viewer-tools">
      <HoverHint text="下载文件" placement="top"><button type="button" aria-label="下载文件" :disabled="downloading" @click="emit('download')"><Download :size="20" /></button></HoverHint>
    </div>
  </div>
</template>

<style>
.media-viewer-shell { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0; background: transparent; }
.media-video-surface { position: absolute; inset: 0; background: #080a0ce6; }
.media-video-stage { position: absolute; inset: 64px min(72px, 6vw) 76px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 8px; }
.media-video-stage video { display: block; width: min(100%, calc((100dvh - 140px) * var(--video-ratio))); max-height: 100%; border-radius: 8px; }
.media-viewer-close, .media-viewer-tools button { display: grid; place-items: center; width: 42px; height: 42px; padding: 0; border: 0; background: #171c22cc; color: #e1e6eb; }
.media-close-hint { position: absolute; top: 18px; right: 18px; z-index: 1; }
.media-viewer-close { border-radius: 50%; }
.media-viewer-tools { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; overflow: hidden; border-radius: 6px; }
.media-viewer-close:hover, .media-viewer-tools button:hover { background: #252e39ee; }
.media-viewer-feedback { position: absolute; bottom: 76px; left: 50%; transform: translateX(-50%); z-index: 2; max-width: calc(100% - 48px); padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--danger); font-size: 13px; }
</style>

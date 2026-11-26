<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Download, Hd, ZoomIn, ZoomOut } from '@lucide/vue';
import AppProgress from './AppProgress.vue';
import type PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';

const props = defineProps<{ source: string; title: string; downloadable?: boolean; originalLabel?: string; original?: { url: string; width: number; height: number }; percent?: number; originalError?: string }>();
const emit = defineEmits<{ close: []; download: []; originalRequest: []; error: [] }>();
const host = ref<HTMLElement | null>(null);
let viewer: PhotoSwipe | undefined;
let disposed = false;
const image = new Image();
const hdLabel = computed(() => props.original ? '已显示原图' : props.originalLabel);
let duration = 0;
function zoom(factor: number) {
  const slide = viewer?.currSlide;
  if (slide) viewer!.zoomTo(Math.max(slide.zoomLevels.min, Math.min(slide.zoomLevels.max, slide.currZoomLevel * factor)), undefined, duration);
}
function showOriginal() {
  const original = props.original;
  if (!viewer || !original) return;
  viewer.options.dataSource = [{ src: original.url, width: original.width, height: original.height, alt: props.title }];
  viewer.refreshSlideContent(0);
}
watch(() => props.original, showOriginal);

onMounted(async () => {
  try {
    image.src = props.source;
    const [module] = await Promise.all([import('photoswipe'), image.decode()]);
    if (disposed || !host.value) return;
    duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    viewer = new module.default({
      dataSource: [{ src: props.source, width: image.naturalWidth, height: image.naturalHeight, alt: props.title }],
      appendToEl: host.value, mainClass: 'chat-photo-viewer',
      wheelToZoom: true, maxZoomLevel: 5, secondaryZoomLevel: 1,
      paddingFn: viewport => ({ top: 64, bottom: 76, left: Math.min(72, viewport.x * 0.06), right: Math.min(72, viewport.x * 0.06) }),
      allowPanToNext: false,
      counter: false, arrowPrev: false, arrowNext: false, zoom: false,
      closeTitle: '关闭图片', bgOpacity: 0.9, showHideAnimationType: 'none',
      showAnimationDuration: duration, hideAnimationDuration: duration,
      trapFocus: false, returnFocus: false, escKey: false,
      imageClickAction: false, doubleTapAction: 'zoom',
    });
    viewer.on('destroy', () => { if (!disposed) emit('close'); });
    viewer.on('bindEvents', () => viewer?.element?.focus({ preventScroll: true }));
    viewer.init();
    showOriginal();
  } catch { if (!disposed) emit('error'); }
});
onScopeDispose(() => { disposed = true; viewer?.destroy(); image.removeAttribute('src'); });
</script>

<template>
  <div ref="host" class="chat-image-surface" />
  <div class="chat-photo-tools" role="group" aria-label="图片工具">
    <button type="button" aria-label="缩小图片" title="缩小图片" @click="zoom(1 / 1.5)"><ZoomOut :size="22" /></button>
    <button type="button" aria-label="放大图片" title="放大图片" @click="zoom(1.5)"><ZoomIn :size="22" /></button>
    <button v-if="originalLabel" type="button" :aria-label="hdLabel" :title="hdLabel" :aria-pressed="!!original"
      :aria-disabled="!!original || percent !== undefined" @click="!original && percent === undefined && emit('originalRequest')"><Hd :size="20" /></button>
    <button v-if="downloadable !== false" type="button" aria-label="下载图片" title="下载图片" @click="emit('download')"><Download :size="20" /></button>
    <div v-if="percent !== undefined" class="chat-photo-progress">
      <span>正在加载原图</span><span>{{ percent }}%</span>
      <AppProgress :percent="percent" label="原图加载进度" />
    </div>
    <span v-else-if="originalError" class="chat-photo-original-error" role="alert">{{ originalError }}</span>
  </div>
</template>

<style>
.chat-photo-viewer { position: absolute; inset: 0; z-index: 1; --pswp-bg: #080a0c; --pswp-icon-color: #e1e6eb; }
.chat-photo-viewer .pswp__item { clip-path: inset(64px min(72px, 6vw) 76px round 8px); }
.chat-photo-viewer .pswp__img { cursor: pointer !important; }
.chat-photo-viewer .pswp__top-bar { padding: 18px; gap: 6px; }
.chat-photo-viewer .pswp__button { display: grid; place-items: center; width: 42px; height: 42px; margin: 0; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
.chat-photo-viewer .pswp__button--close .pswp__icn { width: 28px; height: 28px; top: 7px; left: 7px; }
.chat-photo-tools { position: absolute; z-index: 2; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; border-radius: 6px; background: #171c22ed; color: #e1e6eb; }
.chat-photo-tools button { display: grid; place-items: center; width: 42px; height: 42px; border: 0; border-radius: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; }
.chat-photo-tools svg { stroke-width: 1.6; }
.chat-photo-tools button:first-of-type { border-radius: 6px 0 0 6px; }
.chat-photo-tools button:last-of-type { border-radius: 0 6px 6px 0; }
.chat-photo-tools button:hover, .chat-photo-viewer .pswp__button:hover { background: #252e39ee; }
.chat-photo-tools button[aria-pressed="true"] { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.chat-photo-tools button[aria-disabled="true"] { cursor: default; }
.chat-photo-progress, .chat-photo-original-error { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); padding: 8px 12px; border-radius: 6px; background: #171c22ed; font-size: 12px; }
.chat-photo-progress { width: 100%; box-sizing: border-box; display: grid; grid-template-columns: 1fr auto; gap: 5px; font-variant-numeric: tabular-nums; }
.chat-photo-progress .app-progress { grid-column: 1 / -1; }
.chat-photo-original-error { width: max-content; max-width: min(300px, 85vw); }
</style>

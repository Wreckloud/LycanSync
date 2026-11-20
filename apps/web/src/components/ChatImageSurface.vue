<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import type PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';

const props = defineProps<{ source: string; title: string; downloadable?: boolean }>();
const emit = defineEmits<{ close: []; download: []; error: [] }>();
const host = ref<HTMLElement | null>(null);
let viewer: PhotoSwipe | undefined;
let disposed = false;
const image = new Image();

onMounted(async () => {
  try {
    image.src = props.source;
    const [module] = await Promise.all([import('photoswipe'), image.decode()]);
    if (disposed || !host.value) return;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    viewer = new module.default({
      dataSource: [{ src: props.source, width: image.naturalWidth, height: image.naturalHeight, alt: props.title }],
      appendToEl: host.value, mainClass: `chat-photo-viewer${props.downloadable === false ? ' without-download' : ''}`,
      wheelToZoom: true, maxZoomLevel: 5, secondaryZoomLevel: 1,
      paddingFn: viewport => ({ top: 64, bottom: 76, left: Math.min(72, viewport.x * 0.06), right: Math.min(72, viewport.x * 0.06) }),
      allowPanToNext: false,
      counter: false, arrowPrev: false, arrowNext: false, zoom: false,
      closeTitle: '关闭图片', bgOpacity: 0.9, showHideAnimationType: 'none',
      showAnimationDuration: duration, hideAnimationDuration: duration,
      trapFocus: false, returnFocus: false, escKey: false,
      imageClickAction: false, doubleTapAction: 'zoom',
    });
    viewer.on('uiRegister', () => {
      if (props.downloadable !== false) viewer!.ui!.registerElement({ name: 'download', title: '下载图片', isButton: true, order: 10, appendTo: 'root',
        html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg>',
        onClick: () => emit('download') });
      for (const [name, title, factor, path] of [
        ['zoom-out', '缩小图片', 1 / 1.5, 'M8 11h6'],
        ['zoom-in', '放大图片', 1.5, 'M8 11h6m-3-3v6'],
      ] as const) viewer!.ui!.registerElement({ name, title, isButton: true, appendTo: 'root',
        html: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5${path}"/></svg>`,
        onClick: () => {
          const slide = viewer?.currSlide;
          if (slide) viewer!.zoomTo(Math.max(slide.zoomLevels.min, Math.min(slide.zoomLevels.max, slide.currZoomLevel * factor)), undefined, duration);
        } });
    });
    viewer.on('destroy', () => { if (!disposed) emit('close'); });
    viewer.on('bindEvents', () => viewer?.element?.focus({ preventScroll: true }));
    viewer.init();
  } catch { if (!disposed) emit('error'); }
});
onScopeDispose(() => { disposed = true; viewer?.destroy(); image.removeAttribute('src'); });
</script>

<template><div ref="host" class="chat-image-surface" /></template>

<style>
.chat-photo-viewer { position: absolute; inset: 0; z-index: 1; --pswp-bg: #080a0c; --pswp-icon-color: #e1e6eb; }
.chat-photo-viewer .pswp__item { clip-path: inset(64px min(72px, 6vw) 76px round 8px); }
.chat-photo-viewer .pswp__img { cursor: pointer !important; }
.chat-photo-viewer .pswp__top-bar { padding: 18px; gap: 6px; }
.chat-photo-viewer .pswp__button { display: grid; place-items: center; width: 42px; height: 42px; margin: 0; border-radius: 50%; background: #171c22cc; color: #e1e6eb; }
.chat-photo-viewer .pswp__button--close .pswp__icn { width: 28px; height: 28px; top: 7px; left: 7px; }
.chat-photo-viewer .pswp__button--zoom-in, .chat-photo-viewer .pswp__button--zoom-out, .chat-photo-viewer .pswp__button--download { position: absolute; bottom: 20px; left: 50%; border-radius: 0; }
.chat-photo-viewer .pswp__button--zoom-out { margin-left: -63px; border-radius: 6px 0 0 6px; }
.chat-photo-viewer .pswp__button--zoom-in { margin-left: -21px; }
.chat-photo-viewer .pswp__button--download { margin-left: 21px; border-radius: 0 6px 6px 0; }
.chat-photo-viewer.without-download .pswp__button--zoom-out { margin-left: -42px; }
.chat-photo-viewer.without-download .pswp__button--zoom-in { margin-left: 0; border-radius: 0 6px 6px 0; }
.chat-photo-viewer .pswp__button:hover { background: #252e39ee; }
</style>

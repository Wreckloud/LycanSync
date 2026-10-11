<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import {
  AvatarImageError, blobToDataUrl, calculateAvatarCrop, encodeAvatarCrop, zoomAvatarWithWheel,
} from '../profile/avatarImage';
import type { AvatarCropSource } from '../profile/useAvatarCrop';
import InlineFeedback from './InlineFeedback.vue';

const props = withDefaults(defineProps<{ source: AvatarCropSource; title: string; shape?: 'circle' | 'rounded-square' }>(), { shape: 'circle' });
const emit = defineEmits<{ apply: [avatar: string]; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);
const viewport = shallowRef<HTMLElement | null>(null);
const viewportSize = ref(280);
const zoom = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const error = ref('');
const processing = ref(false);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let disposed = false;
let resizeObserver: ResizeObserver | null = null;
let drag: {
  pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number;
} | null = null;

const imageStyle = computed(() => {
  const source = props.source.bitmap;
  const baseScale = viewportSize.value / Math.min(source.width, source.height);
  return {
    width: `${source.width * baseScale * zoom.value}px`,
    height: `${source.height * baseScale * zoom.value}px`,
    left: `calc(50% + ${offsetX.value}px)`,
    top: `calc(50% + ${offsetY.value}px)`,
  };
});

function maximumOffset(axis: 'x' | 'y') {
  const source = props.source.bitmap;
  const baseScale = viewportSize.value / Math.min(source.width, source.height);
  const size = axis === 'x' ? source.width : source.height;
  return Math.max(0, (size * baseScale * zoom.value - viewportSize.value) / 2);
}

function clampOffset() {
  offsetX.value = Math.max(-maximumOffset('x'), Math.min(maximumOffset('x'), offsetX.value));
  offsetY.value = Math.max(-maximumOffset('y'), Math.min(maximumOffset('y'), offsetY.value));
}
watch(zoom, clampOffset);

function zoomWithWheel(event: WheelEvent) {
  if (processing.value) return;
  zoom.value = zoomAvatarWithWheel(zoom.value, event.deltaY, event.deltaMode);
}

onMounted(async () => {
  await nextTick();
  dialog.value?.focus();
  if (disposed || !viewport.value) return;
  const updateSize = () => {
    viewportSize.value = viewport.value!.clientWidth;
    clampOffset();
  };
  updateSize();
  resizeObserver = new ResizeObserver(updateSize);
  resizeObserver.observe(viewport.value);
});
onScopeDispose(() => {
  disposed = true;
  resizeObserver?.disconnect();
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
});

function beginDrag(event: PointerEvent) {
  if (event.button !== 0 || processing.value) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    offsetX: offsetX.value, offsetY: offsetY.value };
}

function moveDrag(event: PointerEvent) {
  if (processing.value || !drag || drag.pointerId !== event.pointerId) return;
  offsetX.value = drag.offsetX + event.clientX - drag.startX;
  offsetY.value = drag.offsetY + event.clientY - drag.startY;
  clampOffset();
}

function endDrag(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return;
  drag = null;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

async function applyCrop() {
  if (processing.value) return;
  processing.value = true;
  error.value = '';
  try {
    const source = props.source.bitmap;
    const crop = calculateAvatarCrop(source.width, source.height,
      viewportSize.value, zoom.value, offsetX.value, offsetY.value);
    const avatar = await blobToDataUrl(await encodeAvatarCrop(source, crop));
    if (!disposed) emit('apply', avatar);
  } catch (exception) {
    if (!disposed) error.value = exception instanceof AvatarImageError ? exception.message : '无法处理头像图片。';
  } finally {
    processing.value = false;
  }
}

function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop avatar-crop-backdrop" @keydown.esc.stop="!processing && emit('cancel')">
      <section ref="dialog" class="avatar-crop-dialog" role="dialog" aria-modal="true"
        aria-labelledby="avatar-crop-title" tabindex="-1" @keydown="keepFocus">
        <header><h2 id="avatar-crop-title">{{ title }}</h2><p>拖动调整位置，滚轮缩放</p></header>
        <div ref="viewport" class="avatar-crop-viewport" aria-label="拖动调整头像位置"
          @pointerdown="beginDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @wheel.prevent="zoomWithWheel">
          <img :src="source.previewUrl" :style="imageStyle" alt="待裁剪头像" draggable="false" />
          <span class="avatar-crop-guide" :class="{ 'is-rounded-square': shape === 'rounded-square' }" aria-hidden="true" />
        </div>
        <label class="avatar-crop-zoom">缩放
          <input v-model.number="zoom" aria-label="头像缩放" type="range" min="1" max="3" step="0.01" :disabled="processing" />
        </label>
        <footer class="avatar-crop-footer">
          <InlineFeedback :message="error" :status="processing ? '正在处理…' : ''" />
          <div class="button-actions">
            <button type="button" :disabled="processing" @click="emit('cancel')">取消裁剪</button>
            <button type="button" class="confirm-button" :disabled="processing" @click="applyCrop">应用头像</button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.avatar-crop-backdrop { z-index: 110; }
.avatar-crop-dialog { width: min(400px, 100%); max-height: calc(100dvh - 36px); overflow-y: auto; display: grid; justify-items: center; gap: 16px; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
.avatar-crop-dialog header { width: 100%; }
.avatar-crop-dialog h2 { margin: 0; font-size: 22px; line-height: 32px; }
.avatar-crop-dialog header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.avatar-crop-viewport { position: relative; width: min(280px, 100%); aspect-ratio: 1; overflow: hidden; border-radius: 6px; background: var(--background); cursor: grab; touch-action: none; }
.avatar-crop-viewport:active { cursor: grabbing; }
.avatar-crop-viewport img { position: absolute; max-width: none; transform: translate(-50%, -50%); pointer-events: none; user-select: none; }
.avatar-crop-guide { position: absolute; inset: 0; border: 1px solid var(--subtle); border-radius: 50%; box-shadow: 0 0 0 999px #0008; pointer-events: none; }
.avatar-crop-guide.is-rounded-square { border-radius: 8px; }
.avatar-crop-zoom { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; }
.avatar-crop-zoom input { width: 100%; min-width: 0; accent-color: var(--accent); }
.avatar-crop-footer { width: 100%; padding-top: 16px; border-top: 1px solid var(--border-soft); }
.avatar-crop-footer .button-actions { justify-content: flex-end; margin-top: 8px; }
.confirm-button { background: var(--accent); border-color: var(--accent); }
@media (max-width: 420px) { .avatar-crop-dialog { padding: 20px; } .avatar-crop-dialog h2 { font-size: 20px; } }
</style>

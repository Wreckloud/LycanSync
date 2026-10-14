<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RotateCcw } from '@lucide/vue';
import {
  AvatarImageError, blobToDataUrl, calculateAvatarCrop, encodeAvatarCrop, zoomAvatarWithWheel,
} from '../profile/avatarImage';
import type { AvatarCropSource } from '../profile/useAvatarCrop';
import InlineFeedback from './InlineFeedback.vue';

const props = defineProps<{ source: AvatarCropSource; title: string }>();
const emit = defineEmits<{ apply: [avatar: string]; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);
const viewport = shallowRef<HTMLElement | null>(null);
const viewportSize = ref(280);
const zoom = ref(1);
const rotation = ref(0);
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
// 拖动灵敏度与刻度间距分开，缩短操作距离不压缩视觉标尺。
const ROTATION_DRAG_PIXELS_PER_DEGREE = 1;
const ROTATION_TICK_PIXELS_PER_DEGREE = 2;
const rotationTicks = Array.from({ length: 73 }, (_, index) => (index - 36) * 5);
let rotationDrag: { pointerId: number; startX: number; rotation: number } | null = null;

const crop = computed(() => calculateAvatarCrop(props.source.bitmap.width, props.source.bitmap.height,
  viewportSize.value, zoom.value, offsetX.value, offsetY.value, rotation.value));
const imageStyle = computed(() => {
  const source = props.source.bitmap;
  const scale = viewportSize.value / crop.value.size;
  const radians = rotation.value * Math.PI / 180;
  const shiftX = source.width / 2 - crop.value.x - crop.value.size / 2;
  const shiftY = source.height / 2 - crop.value.y - crop.value.size / 2;
  return {
    width: `${source.width * scale}px`, height: `${source.height * scale}px`,
    left: `calc(50% + ${(Math.cos(radians) * shiftX - Math.sin(radians) * shiftY) * scale}px)`,
    top: `calc(50% + ${(Math.sin(radians) * shiftX + Math.cos(radians) * shiftY) * scale}px)`,
    transform: `translate(-50%, -50%) rotate(${rotation.value}deg)`,
  };
});

function clampOffset() {
  const current = crop.value;
  const scale = viewportSize.value / current.size;
  const radians = rotation.value * Math.PI / 180;
  const shiftX = props.source.bitmap.width / 2 - current.x - current.size / 2;
  const shiftY = props.source.bitmap.height / 2 - current.y - current.size / 2;
  offsetX.value = (Math.cos(radians) * shiftX - Math.sin(radians) * shiftY) * scale;
  offsetY.value = (Math.sin(radians) * shiftX + Math.cos(radians) * shiftY) * scale;
}
watch([zoom, rotation], clampOffset);

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

// 原生 range 保留键盘控制；指针拖动移动刻度，中央游标固定，不显示进度填充。
function beginRotation(event: PointerEvent) {
  if (event.button !== 0 || processing.value) return;
  const input = event.currentTarget as HTMLInputElement;
  input.focus();
  input.setPointerCapture(event.pointerId);
  rotationDrag = { pointerId: event.pointerId, startX: event.clientX, rotation: rotation.value };
}

function moveRotation(event: PointerEvent) {
  if (processing.value || !rotationDrag || rotationDrag.pointerId !== event.pointerId) return;
  const degrees = rotationDrag.rotation - (event.clientX - rotationDrag.startX) / ROTATION_DRAG_PIXELS_PER_DEGREE;
  rotation.value = Math.max(-180, Math.min(180, Math.round(degrees)));
}

function endRotation(event: PointerEvent) {
  if (rotationDrag?.pointerId !== event.pointerId) return;
  rotationDrag = null;
  const input = event.currentTarget as HTMLInputElement;
  if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
}

async function applyCrop() {
  if (processing.value) return;
  processing.value = true;
  error.value = '';
  try {
    const source = props.source.bitmap;
    const avatar = await blobToDataUrl(await encodeAvatarCrop(source, crop.value));
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
        </div>
        <div class="avatar-crop-rotation"><span class="avatar-rotation-label">旋转</span>
          <span class="avatar-rotation-ruler">
            <span class="avatar-rotation-scale" :style="{ transform: `translateX(${-rotation * ROTATION_TICK_PIXELS_PER_DEGREE}px)` }" aria-hidden="true">
              <span v-for="tick in rotationTicks" :key="tick" class="avatar-rotation-tick" :class="{ 'is-major': tick % 30 === 0 }"
                :style="{ left: `calc(50% + ${tick * ROTATION_TICK_PIXELS_PER_DEGREE}px)` }">
                <span v-if="tick % 30 === 0">{{ tick > 0 ? '+' : '' }}{{ tick }}</span>
              </span>
            </span>
            <span class="avatar-rotation-marker" aria-hidden="true" />
            <input v-model.number="rotation" aria-label="头像旋转" type="range" min="-180" max="180" step="1" :disabled="processing"
              @pointerdown.prevent="beginRotation" @pointermove="moveRotation" @pointerup="endRotation" @pointercancel="endRotation" />
          </span>
          <span class="avatar-rotation-current">
            <button type="button" class="avatar-rotation-reset" :class="{ 'is-hidden': rotation === 0 }" aria-label="旋转归零" :disabled="processing || rotation === 0" @click="rotation = 0">
              <RotateCcw :size="14" />
            </button>
            <span class="avatar-rotation-value">{{ rotation > 0 ? '+' : '' }}{{ rotation }}°</span>
          </span>
        </div>
        <footer class="card-actions">
          <button type="button" class="settings-button" :disabled="processing" @click="emit('cancel')">取消</button>
          <InlineFeedback class="card-feedback" :message="error" :status="processing ? '正在处理…' : ''" />
          <button type="button" class="confirm-button card-actions-end" :disabled="processing" @click="applyCrop">应用头像</button>
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
.avatar-crop-viewport { position: relative; width: min(300px, 100%); aspect-ratio: 1; overflow: hidden; border: 2px solid var(--subtle); border-radius: 6px; background: var(--background); cursor: grab; touch-action: none; }
.avatar-crop-viewport:active { cursor: grabbing; }
.avatar-crop-viewport img { position: absolute; max-width: none; transform: translate(-50%, -50%); pointer-events: none; user-select: none; }
.avatar-crop-rotation { display: grid; width: min(300px, 100%); grid-template-columns: minmax(64px, 1fr) minmax(0, 182px) minmax(64px, 1fr); gap: 8px; align-items: center; font-size: 13px; line-height: 20px; }
.avatar-rotation-label { justify-self: start; color: var(--muted); }
.avatar-rotation-ruler { position: relative; display: block; height: 42px; overflow: hidden; min-width: 0; mask-image: linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent); }
.avatar-rotation-scale { position: absolute; inset: 0; pointer-events: none; }
.avatar-rotation-tick { position: absolute; top: 12px; height: 8px; width: 1px; background: var(--subtle); }
.avatar-rotation-tick.is-major { top: 6px; height: 14px; }
.avatar-rotation-tick > span { position: absolute; top: 19px; left: 0; transform: translateX(-50%); color: var(--muted); font-size: 10px; line-height: 14px; }
.avatar-rotation-marker { position: absolute; top: 2px; left: calc(50% - 1px); width: 2px; height: 20px; background: var(--accent); pointer-events: none; }
.avatar-rotation-ruler input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; touch-action: none; }
.avatar-rotation-ruler input:disabled { cursor: not-allowed; }
.avatar-rotation-current { display: flex; justify-self: end; align-items: center; gap: 4px; }
.avatar-rotation-value { width: 40px; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
.avatar-rotation-reset { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.avatar-rotation-reset:hover:not(:disabled) { color: var(--text); }
.avatar-rotation-reset:disabled { opacity: .35; cursor: default; }
.avatar-rotation-reset.is-hidden { visibility: hidden; }
@media (max-width: 420px) { .avatar-crop-dialog { padding: 20px; } .avatar-crop-dialog h2 { font-size: 20px; } }
</style>

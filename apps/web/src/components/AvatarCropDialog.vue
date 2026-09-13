<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import {
  AvatarImageError, blobToDataUrl, calculateAvatarCrop, decodeAvatarFile, encodeAvatarCrop,
} from '../profile/avatarImage';

const CROP_VIEWPORT_SIZE = 280;
const props = defineProps<{ file: File; title: string }>();
const emit = defineEmits<{ apply: [avatar: string]; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);
const source = shallowRef<ImageBitmap | null>(null);
const sourceUrl = ref('');
const zoom = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const error = ref('');
const processing = ref(false);
let disposed = false;
let drag: {
  pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number;
} | null = null;

const imageStyle = computed(() => {
  if (!source.value) return {};
  const baseScale = CROP_VIEWPORT_SIZE / Math.min(source.value.width, source.value.height);
  return {
    width: `${source.value.width * baseScale * zoom.value}px`,
    height: `${source.value.height * baseScale * zoom.value}px`,
    left: `calc(50% + ${offsetX.value}px)`,
    top: `calc(50% + ${offsetY.value}px)`,
  };
});

function maximumOffset(axis: 'x' | 'y') {
  if (!source.value) return 0;
  const baseScale = CROP_VIEWPORT_SIZE / Math.min(source.value.width, source.value.height);
  const size = axis === 'x' ? source.value.width : source.value.height;
  return Math.max(0, (size * baseScale * zoom.value - CROP_VIEWPORT_SIZE) / 2);
}

function clampOffset() {
  offsetX.value = Math.max(-maximumOffset('x'), Math.min(maximumOffset('x'), offsetX.value));
  offsetY.value = Math.max(-maximumOffset('y'), Math.min(maximumOffset('y'), offsetY.value));
}
watch(zoom, clampOffset);

onMounted(async () => {
  await nextTick();
  dialog.value?.focus();
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodeAvatarFile(props.file);
    const previewUrl = await blobToDataUrl(props.file);
    if (disposed) return;
    source.value = bitmap;
    sourceUrl.value = previewUrl;
    bitmap = null;
  } catch (exception) {
    if (!disposed) error.value = exception instanceof AvatarImageError ? exception.message : '无法读取头像文件。';
  } finally {
    bitmap?.close();
  }
});
onScopeDispose(() => { disposed = true; source.value?.close(); });

function beginDrag(event: PointerEvent) {
  if (event.button !== 0 || !source.value) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    offsetX: offsetX.value, offsetY: offsetY.value };
}

function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
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
  if (!source.value || processing.value) return;
  processing.value = true;
  error.value = '';
  try {
    const crop = calculateAvatarCrop(source.value.width, source.value.height,
      CROP_VIEWPORT_SIZE, zoom.value, offsetX.value, offsetY.value);
    const avatar = await blobToDataUrl(await encodeAvatarCrop(source.value, crop, props.file.type));
    if (!disposed) emit('apply', avatar);
  } catch (exception) {
    if (!disposed) error.value = exception instanceof AvatarImageError ? exception.message : '无法处理头像图片。';
  } finally {
    processing.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop avatar-crop-backdrop" @keydown.esc.stop="!processing && emit('cancel')">
      <section ref="dialog" class="auth-card avatar-crop-dialog" role="dialog" aria-modal="true"
        aria-labelledby="avatar-crop-title" tabindex="-1">
        <div>
          <h3 id="avatar-crop-title">{{ title }}</h3>
          <small>拖动图片调整位置，圆框内是头像最终显示范围。</small>
        </div>
        <div class="avatar-crop-viewport" aria-label="拖动调整头像位置"
          @pointerdown="beginDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
          <img v-if="source" :src="sourceUrl" :style="imageStyle" alt="待裁剪头像" draggable="false" />
          <span class="avatar-crop-guide" aria-hidden="true" />
        </div>
        <label class="avatar-crop-zoom">缩放
          <input v-model.number="zoom" aria-label="头像缩放" type="range" min="1" max="3" step="0.01" :disabled="!source || processing" />
        </label>
        <p v-if="error" role="alert" class="auth-error">{{ error }}</p>
        <div class="dialog-actions avatar-crop-actions">
          <button type="button" :disabled="processing" @click="emit('cancel')">取消裁剪</button>
          <button type="button" class="confirm-button" :disabled="!source || processing" @click="applyCrop">
            {{ processing ? '正在处理…' : '应用头像' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

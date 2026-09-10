<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { X, UserRound } from '@lucide/vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import {
  AvatarImageError,
  blobToDataUrl,
  calculateAvatarCrop,
  decodeAvatarFile,
  encodeAvatarCrop,
} from '../profile/avatarImage';

const CROP_VIEWPORT_SIZE = 280;

const props = defineProps<{ user: AuthUser; error: string }>();
const emit = defineEmits<{ close: []; updated: [user: AuthUser]; logout: [] }>();
const nickname = ref(props.user.nickname);
const avatar = ref(props.user.avatar);
const avatarInput = ref<HTMLInputElement | null>(null);
const error = ref('');
const busy = ref(false);
const cropSource = shallowRef<ImageBitmap | null>(null);
const cropSourceUrl = ref('');
const cropSourceType = ref('image/jpeg');
const cropZoom = ref(1);
const cropOffsetX = ref(0);
const cropOffsetY = ref(0);
const processingAvatar = ref(false);
let drag: {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
} | null = null;

const cropImageStyle = computed(() => {
  if (!cropSource.value) return {};
  const baseScale = CROP_VIEWPORT_SIZE / Math.min(cropSource.value.width, cropSource.value.height);
  return {
    width: `${cropSource.value.width * baseScale * cropZoom.value}px`,
    height: `${cropSource.value.height * baseScale * cropZoom.value}px`,
    left: `calc(50% + ${cropOffsetX.value}px)`,
    top: `calc(50% + ${cropOffsetY.value}px)`,
  };
});

watch(cropZoom, clampCropOffset);

function maximumCropOffset(axis: 'x' | 'y') {
  if (!cropSource.value) return 0;
  const baseScale = CROP_VIEWPORT_SIZE / Math.min(cropSource.value.width, cropSource.value.height);
  const sourceSize = axis === 'x' ? cropSource.value.width : cropSource.value.height;
  return Math.max(0, (sourceSize * baseScale * cropZoom.value - CROP_VIEWPORT_SIZE) / 2);
}

function clampCropOffset() {
  const maximumX = maximumCropOffset('x');
  const maximumY = maximumCropOffset('y');
  cropOffsetX.value = Math.max(-maximumX, Math.min(maximumX, cropOffsetX.value));
  cropOffsetY.value = Math.max(-maximumY, Math.min(maximumY, cropOffsetY.value));
}

function closeCropEditor() {
  cropSource.value?.close();
  cropSource.value = null;
  if (cropSourceUrl.value) URL.revokeObjectURL(cropSourceUrl.value);
  cropSourceUrl.value = '';
  cropZoom.value = 1;
  cropOffsetX.value = 0;
  cropOffsetY.value = 0;
  drag = null;
}

onScopeDispose(closeCropEditor);

async function pickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodeAvatarFile(file);
    closeCropEditor();
    cropSource.value = bitmap;
    cropSourceUrl.value = URL.createObjectURL(file);
    cropSourceType.value = file.type;
    bitmap = null;
    error.value = '';
  } catch (exception) {
    bitmap?.close();
    closeCropEditor();
    error.value = exception instanceof AvatarImageError ? exception.message : '无法读取头像文件。';
  }
}

function beginCropDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: cropOffsetX.value,
    offsetY: cropOffsetY.value,
  };
}

function moveCrop(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  cropOffsetX.value = drag.offsetX + event.clientX - drag.startX;
  cropOffsetY.value = drag.offsetY + event.clientY - drag.startY;
  clampCropOffset();
}

function endCropDrag(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return;
  drag = null;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

async function applyAvatarCrop() {
  const source = cropSource.value;
  if (!source) return;
  processingAvatar.value = true;
  error.value = '';
  try {
    const crop = calculateAvatarCrop(
      source.width,
      source.height,
      CROP_VIEWPORT_SIZE,
      cropZoom.value,
      cropOffsetX.value,
      cropOffsetY.value,
    );
    avatar.value = await blobToDataUrl(await encodeAvatarCrop(source, crop, cropSourceType.value));
    closeCropEditor();
  } catch (exception) {
    error.value = exception instanceof AvatarImageError ? exception.message : '无法处理头像图片。';
  } finally {
    processingAvatar.value = false;
  }
}

async function save() {
  if (cropSource.value) {
    error.value = '请先应用或取消当前头像裁剪。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const user = await authRequest<AuthUser>('me', 'PUT', { nickname: nickname.value, avatar: avatar.value });
    emit('updated', user);
    emit('close');
  } catch (exception) { error.value = exception instanceof Error ? exception.message : '保存失败'; }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="dialog-backdrop" @keydown.esc="emit('close')">
    <section class="auth-card profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <div class="members-header"><h2 id="profile-title">个人设置</h2>
        <button aria-label="关闭设置" @click="emit('close')"><X :size="18" /></button></div>
      <form @submit.prevent="save">
        <div class="avatar-settings">
          <div class="profile-avatar-preview">
            <img v-if="avatar" :src="avatar" class="profile-avatar" alt="头像预览" referrerpolicy="no-referrer" />
            <UserRound v-else :size="52" />
          </div>
          <div class="avatar-actions">
            <input ref="avatarInput" type="file" hidden aria-label="上传头像" accept="image/png,image/jpeg" @change="pickAvatar" />
            <button type="button" :disabled="busy || processingAvatar" @click="avatarInput?.click()">选择头像</button>
            <small>可选择最大 10 MB 的 PNG/JPEG，保存前会在本机裁剪压缩。</small>
          </div>
        </div>
        <section v-if="cropSource" class="avatar-crop-editor" aria-labelledby="avatar-crop-title">
          <div>
            <h3 id="avatar-crop-title">调整头像</h3>
            <small>拖动图片调整位置，圆框内是头像最终显示范围。</small>
          </div>
          <div class="avatar-crop-viewport" aria-label="拖动调整头像位置"
            @pointerdown="beginCropDrag" @pointermove="moveCrop"
            @pointerup="endCropDrag" @pointercancel="endCropDrag">
            <img :src="cropSourceUrl" :style="cropImageStyle" alt="待裁剪头像" draggable="false" />
            <span class="avatar-crop-guide" aria-hidden="true" />
          </div>
          <label class="avatar-crop-zoom">缩放
            <input v-model.number="cropZoom" aria-label="头像缩放" type="range" min="1" max="3" step="0.01" />
          </label>
          <div class="dialog-actions avatar-crop-actions">
            <button type="button" :disabled="processingAvatar" @click="closeCropEditor">取消裁剪</button>
            <button type="button" class="confirm-button" :disabled="processingAvatar" @click="applyAvatarCrop">
              {{ processingAvatar ? '正在处理…' : '应用头像' }}
            </button>
          </div>
        </section>
        <label>昵称 <input v-model="nickname" :maxlength="32" required /></label>
        <div class="dialog-actions"><button class="confirm-button"
          :disabled="busy || processingAvatar || Boolean(cropSource) || !nickname.trim()">保存资料</button>
          <button type="button" :disabled="busy" @click="emit('logout')">退出登录</button></div>
      </form>
      <p v-if="error || props.error" role="alert" class="auth-error">{{ error || props.error }}</p>
    </section>
  </div>
</template>

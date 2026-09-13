<script setup lang="ts">
import { ref } from 'vue';
import { X, UserRound } from '@lucide/vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import AvatarCropDialog from './AvatarCropDialog.vue';

const props = defineProps<{ user: AuthUser; error: string }>();
const emit = defineEmits<{ close: []; updated: [user: AuthUser]; logout: [] }>();
const nickname = ref(props.user.nickname);
const avatar = ref(props.user.avatar);
const avatarInput = ref<HTMLInputElement | null>(null);
const cropFile = ref<File | null>(null);
const error = ref('');
const busy = ref(false);

function pickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  cropFile.value = input.files?.[0] ?? null;
  input.value = '';
  error.value = '';
}

function applyAvatar(avatarUrl: string) {
  avatar.value = avatarUrl;
  cropFile.value = null;
}

async function save() {
  if (cropFile.value) return;
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
  <div class="dialog-backdrop" @keydown.esc="!cropFile && emit('close')">
    <section class="auth-card profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" :inert="Boolean(cropFile)">
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
            <button type="button" :disabled="busy" @click="avatarInput?.click()">选择头像</button>
            <small>可选择最大 10 MB 的 PNG/JPEG，保存前会在本机裁剪压缩。</small>
          </div>
        </div>
        <label>昵称 <input v-model="nickname" :maxlength="32" required /></label>
        <div class="dialog-actions"><button class="confirm-button"
          :disabled="busy || Boolean(cropFile) || !nickname.trim()">保存资料</button>
          <button type="button" :disabled="busy" @click="emit('logout')">退出登录</button></div>
      </form>
      <p v-if="(error || props.error) && !cropFile" role="alert" class="auth-error">{{ error || props.error }}</p>
    </section>
  </div>
  <AvatarCropDialog v-if="cropFile" :file="cropFile" title="调整头像"
    @apply="applyAvatar" @cancel="cropFile = null" />
</template>

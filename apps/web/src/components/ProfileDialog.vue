<script setup lang="ts">
import { ref } from 'vue';
import { X, UserRound } from '@lucide/vue';
import { authRequest, type AuthUser } from '../auth/authApi';

const props = defineProps<{ user: AuthUser; error: string }>();
const emit = defineEmits<{ close: []; updated: [user: AuthUser]; logout: [] }>();
const nickname = ref(props.user.nickname);
const avatar = ref(props.user.avatar);
const avatarInput = ref<HTMLInputElement | null>(null);
const error = ref('');
const busy = ref(false);

async function pickAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 524288) {
    error.value = '请选择不超过 512 KB 的 PNG 或 JPEG 图片。';
    return;
  }
  try {
    avatar.value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取头像失败'));
      reader.readAsDataURL(file);
    });
    error.value = '';
  } catch { error.value = '无法读取头像文件。'; }
}
async function save() {
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
            <button type="button" @click="avatarInput?.click()">选择头像</button>
            <small>PNG/JPEG，最大 512 KB、1024 × 1024。</small>
          </div>
        </div>
        <label>昵称 <input v-model="nickname" :maxlength="32" required /></label>
        <div class="dialog-actions"><button class="confirm-button" :disabled="busy || !nickname.trim()">保存资料</button>
          <button type="button" :disabled="busy" @click="emit('logout')">退出登录</button></div>
      </form>
      <p v-if="error || props.error" role="alert" class="auth-error">{{ error || props.error }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { Play, Trash2, Upload, X, UserRound } from '@lucide/vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { createEntranceSound, loadEntranceSound, saveEntranceSound } from '../rtc/entranceSound';
import AvatarCropDialog from './AvatarCropDialog.vue';

const props = defineProps<{ user: AuthUser; error: string }>();
const emit = defineEmits<{ close: []; updated: [user: AuthUser]; logout: [] }>();
const desktop = window.lycanDesktop;
const hasDesktopSettings = Boolean(desktop?.getAutoStart && desktop?.setAutoStart);
const nickname = ref(props.user.nickname);
const avatar = ref(props.user.avatar);
const avatarInput = ref<HTMLInputElement | null>(null);
const cropFile = ref<File | null>(null);
const entranceSoundInput = ref<HTMLInputElement | null>(null);
const entranceSound = ref(loadEntranceSound(props.user.id));
const error = ref('');
const busy = ref(false);
const autoStartSupported = ref(false);
const autoStartEnabled = ref(false);
const autoStartBusy = ref(false);
const autoStartError = ref('');
let previewAudio: HTMLAudioElement | null = null;

onMounted(async () => {
  if (!desktop?.getAutoStart) return;
  try {
    const settings = await desktop.getAutoStart();
    autoStartSupported.value = settings.supported;
    autoStartEnabled.value = settings.enabled;
  } catch {
    autoStartError.value = '无法读取开机自启设置';
  }
});

onScopeDispose(() => {
  previewAudio?.pause();
  previewAudio = null;
});

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

async function pickEntranceSound(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  busy.value = true;
  try {
    const sound = await createEntranceSound(file);
    if (!saveEntranceSound(props.user.id, sound)) throw new Error('入场音效无法保存到本机');
    entranceSound.value = sound;
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : '无法保存入场音效';
  } finally {
    busy.value = false;
  }
}

function previewEntranceSound() {
  if (!entranceSound.value) return;
  previewAudio?.pause();
  previewAudio = new Audio(entranceSound.value.dataUrl);
  previewAudio.volume = 0.5;
  void previewAudio.play().catch(() => { error.value = '当前系统未允许播放声音'; });
}

function removeEntranceSound() {
  previewAudio?.pause();
  previewAudio = null;
  if (!saveEntranceSound(props.user.id, null)) {
    error.value = '无法删除本机保存的入场音效';
    return;
  }
  entranceSound.value = null;
  error.value = '';
}

async function updateAutoStart(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const previous = autoStartEnabled.value;
  autoStartEnabled.value = enabled;
  autoStartBusy.value = true;
  autoStartError.value = '';
  try {
    const settings = await desktop?.setAutoStart(enabled);
    if (!settings?.supported) throw new Error('当前版本不支持开机自启');
    autoStartEnabled.value = settings.enabled;
  } catch (exception) {
    autoStartEnabled.value = previous;
    autoStartError.value = exception instanceof Error ? exception.message : '无法修改开机自启设置';
  } finally {
    autoStartBusy.value = false;
  }
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
        <div class="entrance-sound-settings">
          <div><strong>入场音效</strong><small>加入语音时播放给房间内的其他成员，仅保存在这台设备。</small></div>
          <div class="entrance-sound-actions">
            <input ref="entranceSoundInput" type="file" hidden aria-label="上传入场音效"
              accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,.mp3,.ogg,.wav,.webm" @change="pickEntranceSound" />
            <button type="button" :disabled="busy" @click="entranceSoundInput?.click()"><Upload :size="15" />选择音效</button>
            <button v-if="entranceSound" type="button" :disabled="busy" @click="previewEntranceSound"><Play :size="15" />试听</button>
            <button v-if="entranceSound" type="button" :disabled="busy" @click="removeEntranceSound"><Trash2 :size="15" />移除</button>
            <span v-if="entranceSound" :title="entranceSound.name">{{ entranceSound.name }}</span>
            <small>支持 MP3、OGG、WAV、WebM，最长 5 秒且不超过 512 KB。</small>
          </div>
        </div>
        <div v-if="hasDesktopSettings" class="profile-system-settings">
          <div><strong>系统</strong><small>只影响当前电脑。</small></div>
          <label class="profile-toggle">
            <span><strong>开机自动启动</strong><small>{{ autoStartSupported
              ? '使用 Windows 登录项启动，不增加额外常驻进程。'
              : '仅 Windows 安装版支持，开发模式不会修改系统启动项。' }}</small></span>
            <input type="checkbox" :checked="autoStartEnabled" :disabled="!autoStartSupported || autoStartBusy"
              aria-label="开机自动启动" @change="updateAutoStart" />
          </label>
          <small v-if="autoStartError" role="alert" class="setting-error">{{ autoStartError }}</small>
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

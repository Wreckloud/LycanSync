<script setup lang="ts">
import { computed, nextTick, ref, toRef } from 'vue';
import { ArrowRight, Pencil, UserRound } from '@lucide/vue';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';
import AvatarCropDialog from './AvatarCropDialog.vue';
import { useProfileDraft } from '../profile/useProfileDraft';
import { formatRegistrationDate } from '../profile/registrationDate';

const props = defineProps<{ user: AuthUser; saveProfile: (profile: ProfileUpdate) => Promise<AuthUser> }>();
const emit = defineEmits<{ finish: [] }>();
const { nickname, avatar, signature, supportsSignature, busy, error, save: saveDraft } = useProfileDraft(toRef(props, 'user'), props.saveProfile);
const avatarInput = ref<HTMLInputElement | null>(null);
const nicknameInput = ref<HTMLInputElement | null>(null);
const nicknameButton = ref<HTMLButtonElement | null>(null);
const editingNickname = ref(false);
const cropFile = ref<File | null>(null);
const registrationDate = computed(() => formatRegistrationDate(props.user.createdAt));

function pickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  cropFile.value = input.files?.[0] ?? null;
  input.value = '';
  error.value = '';
}

function applyAvatar(value: string) {
  avatar.value = value;
  cropFile.value = null;
}

async function editNickname() {
  editingNickname.value = true;
  await nextTick();
  nicknameInput.value?.focus();
  nicknameInput.value?.select();
}

function finishNicknameEdit() {
  if (nickname.value.trim()) editingNickname.value = false;
}

async function submitNickname(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  finishNicknameEdit();
  await nextTick();
  nicknameButton.value?.focus();
}

async function save() {
  if (busy.value || cropFile.value) return;
  // 首次填写只在确认时提交，跳过不保存草稿；日常设置仍保持自动保存。
  if (await saveDraft()) emit('finish');
}
</script>

<template>
  <main class="auth-screen">
    <form class="auth-card welcome-profile" aria-labelledby="welcome-profile-title" @submit.prevent="save">
      <header class="welcome-header">
        <div>
          <h1 id="welcome-profile-title">你的个人资料卡</h1>
          <p>向大家展示自己</p>
        </div>
        <button type="button" class="welcome-skip" :disabled="busy || !!cropFile" @click="emit('finish')">
          跳过<ArrowRight :size="16" aria-hidden="true" />
        </button>
      </header>
      <div class="welcome-details">
        <div class="welcome-identity">
          <button type="button" class="welcome-avatar" aria-label="修改头像" :disabled="busy" @click="avatarInput?.click()">
            <img v-if="avatar" :src="avatar" alt="头像预览" referrerpolicy="no-referrer" />
            <UserRound v-else :size="42" />
            <span class="welcome-avatar-overlay" aria-hidden="true"><Pencil :size="20" /><span>编辑</span></span>
          </button>
          <input ref="avatarInput" type="file" hidden aria-label="上传头像" accept="image/png,image/jpeg" @change="pickAvatar" />
          <div class="welcome-nickname">
            <input v-if="editingNickname" ref="nicknameInput" v-model="nickname" aria-label="昵称" maxlength="32"
              :readonly="busy" :aria-invalid="!nickname.trim()" @blur="finishNicknameEdit" @keydown.enter="submitNickname" />
            <button v-else ref="nicknameButton" type="button" :aria-label="`修改昵称，${nickname}`" :disabled="busy" @click="editNickname">
              <span>{{ nickname }}</span><Pencil :size="15" aria-hidden="true" />
            </button>
            <span class="welcome-registration">注册于 <time v-if="registrationDate" :datetime="user.createdAt">{{ registrationDate }}</time><span v-else>暂不可用</span></span>
          </div>
        </div>
        <div class="welcome-signature">
          <div class="welcome-signature-heading">
            <label for="welcome-signature">个性签名 <span>选填</span></label>
            <span class="welcome-signature-count">{{ signature.length }} / 120</span>
          </div>
          <textarea id="welcome-signature" v-model="signature" aria-label="个性签名" maxlength="120" rows="2"
            :disabled="!supportsSignature" :readonly="busy" placeholder="写一句想让朋友看到的话" />
        </div>
      </div>
      <footer class="welcome-actions">
        <div class="welcome-feedback">
          <p v-if="error" role="alert">{{ error }}</p>
          <span v-else-if="busy" role="status">正在保存…</span>
          <span v-else-if="!supportsSignature">签名保存需要更新服务。</span>
        </div>
        <button type="submit" class="confirm-button" :disabled="busy || !!cropFile">保存并进入</button>
      </footer>
    </form>
    <AvatarCropDialog v-if="cropFile" :file="cropFile" title="调整头像" @apply="applyAvatar" @cancel="cropFile = null" />
  </main>
</template>

<style scoped>
.welcome-profile { width: min(680px, 100%); padding: 24px; }
.welcome-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.welcome-header h1 { margin: 0; font-size: 22px; line-height: 32px; }
.welcome-header p { margin: 4px 0 0; font-size: 13px; line-height: 20px; }
.welcome-skip { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; height: var(--button-height); padding: 5px 0 5px 8px; border: 0; background: transparent; color: var(--muted); font-size: 14px; line-height: 20px; cursor: pointer; }
.welcome-skip:hover:not(:disabled) { color: var(--text); }
.welcome-details { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 24px; margin: 24px 0; }
.welcome-identity { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 96px; }
.welcome-avatar { position: relative; flex-shrink: 0; display: grid; place-items: center; width: 80px; height: 80px; padding: 0; overflow: hidden; border: 0; border-radius: 50%; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.welcome-avatar img { width: 100%; height: 100%; object-fit: cover; }
.welcome-avatar-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #0009; color: white; font-size: 12px; opacity: 0; }
.welcome-avatar:hover .welcome-avatar-overlay, .welcome-avatar:focus-visible .welcome-avatar-overlay { opacity: 1; }
.welcome-nickname { display: grid; grid-template-rows: 40px 20px; gap: 4px; flex: 1; min-width: 0; }
.welcome-nickname button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; min-width: 0; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; }
.welcome-nickname button:hover:not(:disabled) { background: var(--panel-raised); }
.welcome-nickname button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; font-weight: 600; }
.welcome-nickname button svg { flex-shrink: 0; color: var(--muted); }
.welcome-nickname input { padding: 6px 8px; font-size: 20px; font-weight: 600; }
.welcome-nickname input:focus, .welcome-signature textarea:focus { border-color: var(--subtle); }
.welcome-registration { overflow: hidden; padding-left: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.welcome-signature { display: grid; gap: 4px; min-width: 0; }
.welcome-signature-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-height: 20px; }
.welcome-signature-heading label { display: flex; align-items: baseline; gap: 6px; font-size: 14px; }
.welcome-signature-heading label span, .welcome-signature-count { color: var(--muted); font-size: 12px; }
.welcome-signature-count { flex-shrink: 0; }
.welcome-signature textarea { width: 100%; height: 72px; resize: none; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; line-height: 22px; }
.welcome-signature textarea:disabled { opacity: .5; }
.welcome-actions { display: flex; align-items: center; gap: 16px; padding-top: 16px; border-top: 1px solid var(--border-soft); }
.welcome-feedback { flex: 1; min-width: 0; height: 32px; overflow: auto; color: var(--muted); font-size: 12px; line-height: 16px; }
.welcome-feedback p { margin: 0; color: var(--danger); line-height: 16px; }
.welcome-actions button { flex-shrink: 0; }
@media (max-width: 600px) { .welcome-details { grid-template-columns: minmax(0, 1fr); gap: 16px; } }
@media (max-width: 420px) { .welcome-profile { padding: 20px; } .welcome-header h1 { font-size: 20px; } .welcome-avatar { width: 64px; height: 64px; } .welcome-nickname button span, .welcome-nickname input { font-size: 18px; } }
</style>

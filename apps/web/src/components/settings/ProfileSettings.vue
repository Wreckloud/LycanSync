<script setup lang="ts">
import { computed, nextTick, ref, toRef } from 'vue';
import { Pencil, UserRound } from '@lucide/vue';
import type { AuthUser, ProfileUpdate } from '../../auth/authApi';
import AvatarCropDialog from '../AvatarCropDialog.vue';
import { useProfileDraft } from '../../profile/useProfileDraft';
import { formatRegistrationDate } from '../../profile/registrationDate';

const props = defineProps<{
  user: AuthUser;
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
}>();
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

async function save() {
  if (cropFile.value) return false;
  const saved = await saveDraft();
  if (saved) editingNickname.value = false;
  return saved;
}

async function editNickname() {
  if (busy.value) return;
  editingNickname.value = true;
  await nextTick();
  nicknameInput.value?.focus();
  nicknameInput.value?.select();
}

function applyAvatar(value: string) {
  avatar.value = value;
  cropFile.value = null;
  void save();
}

async function submitNickname(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  if (await save()) {
    await nextTick();
    nicknameButton.value?.focus();
  }
}

defineExpose({ save });
</script>

<template>
  <section class="settings-section profile-settings">
    <div class="profile-details">
      <div class="profile-identity">
        <button type="button" class="profile-avatar-preview" aria-label="修改头像" :disabled="busy" @click="avatarInput?.click()">
          <img v-if="avatar" :src="avatar" class="profile-avatar" alt="头像预览" referrerpolicy="no-referrer" />
          <UserRound v-else :size="42" />
          <span class="profile-avatar-overlay" aria-hidden="true"><Pencil :size="20" /><span>编辑</span></span>
        </button>
        <input ref="avatarInput" type="file" hidden aria-label="上传头像" accept="image/png,image/jpeg" @change="pickAvatar" />
        <div class="profile-nickname">
          <input v-if="editingNickname" ref="nicknameInput" v-model="nickname" aria-label="昵称" maxlength="32"
            :readonly="busy" :aria-invalid="!nickname.trim()" @blur="save" @keydown.enter="submitNickname" />
          <button v-else ref="nicknameButton" type="button" :aria-label="`修改昵称，${nickname}`" :disabled="busy" @click="editNickname">
            <span>{{ nickname }}</span><Pencil :size="15" aria-hidden="true" />
          </button>
          <span class="profile-registration">注册于 <time v-if="registrationDate" :datetime="user.createdAt">{{ registrationDate }}</time><span v-else>暂不可用</span></span>
        </div>
      </div>
      <div class="profile-signature">
        <div class="profile-signature-heading"><label for="profile-signature">个性签名 <span>选填</span></label>
          <span class="profile-signature-count">{{ signature.length }} / 120</span></div>
        <textarea id="profile-signature" v-model="signature" aria-label="个性签名" maxlength="120" rows="2"
          :disabled="!supportsSignature" :readonly="busy" placeholder="写一句想让朋友看到的话" @blur="save" />
      </div>
    </div>
    <div class="profile-feedback">
      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <span v-else-if="busy" role="status">正在保存…</span>
      <span v-else-if="!supportsSignature">签名保存需要更新服务。</span>
    </div>
    <AvatarCropDialog v-if="cropFile" :file="cropFile" title="调整头像"
      @apply="applyAvatar" @cancel="cropFile = null" />
  </section>
</template>

<style scoped>
.profile-settings { max-width: 820px; gap: 4px; border-bottom: 1px solid var(--border-soft); }
.profile-details { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: center; padding-top: 4px; }
.profile-identity { display: flex; align-items: center; gap: 16px; min-width: 0; }
.profile-avatar-preview { position: relative; flex-shrink: 0; width: 76px; height: 76px; display: grid; place-items: center; overflow: hidden; padding: 0; border: 0; border-radius: 50%; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.profile-avatar { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.profile-avatar-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; background: #0009; color: white; font-size: 12px; opacity: 0; transition: opacity 120ms; }
.profile-avatar-preview:hover .profile-avatar-overlay, .profile-avatar-preview:focus-visible .profile-avatar-overlay { opacity: 1; }
.profile-nickname { display: grid; grid-template-rows: 40px 20px; gap: 4px; min-width: 0; flex: 1; }
.profile-nickname button { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 40px; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.profile-nickname button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; font-weight: 600; }
.profile-nickname button svg { flex-shrink: 0; color: var(--muted); }
.profile-nickname input { width: 100%; min-height: 40px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 20px; font-weight: 600; }
.profile-registration { min-width: 0; overflow: hidden; padding-left: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.profile-signature { display: grid; gap: 4px; min-width: 0; }
.profile-signature-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.profile-signature label { font-size: 14px; font-weight: 500; }
.profile-signature label span { padding-left: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.profile-signature textarea { width: 100%; height: 64px; resize: none; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; line-height: 22px; }
.profile-signature textarea:disabled { opacity: .5; }
.profile-signature-count { flex-shrink: 0; color: var(--muted); font-size: 12px; }
.profile-feedback { height: 32px; overflow: auto; color: var(--muted); font-size: 12px; line-height: 16px; }
@media (max-width: 760px) { .profile-details { grid-template-columns: minmax(0, 1fr); gap: 16px; } }
@media (max-width: 520px) { .profile-identity { gap: 12px; } .profile-avatar-preview { width: 62px; height: 62px; } .profile-nickname button span, .profile-nickname input { font-size: 17px; } }
</style>

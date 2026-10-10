<script setup lang="ts">
import { ref } from 'vue';
import ProfileSettings from './settings/ProfileSettings.vue';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';
defineProps<{ user: AuthUser; saveProfile: (profile: ProfileUpdate) => Promise<AuthUser> }>();
const emit = defineEmits<{ finish: [] }>();
const editor = ref<InstanceType<typeof ProfileSettings> | null>(null);
const saving = ref(false);
async function save() {
  if (saving.value) return;
  saving.value = true;
  try { if (await editor.value?.save()) emit('finish'); }
  finally { saving.value = false; }
}
</script>
<template>
  <main class="auth-screen">
    <section class="auth-card welcome-profile">
      <h1>设置你的个人资料</h1>
      <p>可以现在修改，也可以先使用默认资料。</p>
      <ProfileSettings ref="editor" :user="user" :save-profile="saveProfile" />
      <div class="button-actions">
        <button class="confirm-button" :disabled="saving" @click="save">保存并进入</button>
        <button :disabled="saving" @click="emit('finish')">跳过，直接进入</button>
      </div>
    </section>
  </main>
</template>
<style scoped>.welcome-profile { width:min(680px,100%); }</style>

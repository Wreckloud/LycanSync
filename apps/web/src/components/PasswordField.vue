<script setup lang="ts">
import { ref } from 'vue';
import { Eye, EyeOff } from '@lucide/vue';
defineProps<{ id: string; label: string; disabled?: boolean; newPassword?: boolean; required?: boolean }>();
const password = defineModel<string>({ required: true });
const visible = ref(false);
</script>

<template>
  <div class="password-field settings-field">
    <label :for="id">{{ label }}</label>
    <div class="password-field-input">
      <input :id="id" v-model="password" :type="visible ? 'text' : 'password'" :disabled="disabled"
        :required="required" :minlength="newPassword ? 15 : undefined" maxlength="128"
        :autocomplete="newPassword ? 'new-password' : 'current-password'" />
      <button type="button" class="settings-button" :disabled="disabled" :aria-label="visible ? '隐藏密码' : '显示密码'"
        :aria-pressed="visible" @click="visible = !visible"><EyeOff v-if="visible" :size="16" /><Eye v-else :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.password-field { display: grid; gap: 8px; }
.password-field-input { display: flex; align-items: center; gap: 8px; }
.password-field-input input { flex: 1; min-width: 0; }
.password-field-input button { display: grid; place-items: center; padding: 8px; }
</style>

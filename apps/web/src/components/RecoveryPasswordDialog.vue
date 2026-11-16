<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PasswordField from './PasswordField.vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ configured: boolean; busy: boolean; disabled?: boolean; error: string; confirmLabel?: string }>();
const password = defineModel<string>('password', { required: true });
const confirmation = defineModel<string>('confirmation', { required: true });
const previousPassword = defineModel<string>('previousPassword', { default: '' });
const emit = defineEmits<{ cancel: []; save: [] }>();
const dialog = ref<HTMLFormElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);
function cancel() { if (!props.busy) emit('cancel'); }
function save() { if (!props.busy && !props.disabled) emit('save'); }
onMounted(() => dialog.value?.querySelector('input')?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
    <form ref="dialog" class="dialog-panel recovery-password-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-password-title"
      tabindex="-1" @submit.prevent="save" @keydown="keepDialogFocus">
      <h2 id="recovery-password-title">{{ configured ? '修改恢复密码' : '设置恢复密码' }}</h2>
      <PasswordField v-if="configured" id="owner-old-password" v-model="previousPassword" label="原恢复密码" :disabled="busy || disabled" required />
      <PasswordField id="owner-new-password" v-model="password" label="新恢复密码（至少 6 位）" :disabled="busy || disabled" new-password required />
      <PasswordField id="owner-confirm-password" v-model="confirmation" label="确认恢复密码" :disabled="busy || disabled" new-password required />
      <InlineFeedback :message="error" :pending="busy ? '正在保存…' : ''" />
      <footer class="card-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <button class="confirm-button card-actions-end" :disabled="busy || disabled">{{ confirmLabel || '保存' }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.recovery-password-dialog { --dialog-width: 420px; display: grid; gap: 12px; }
</style>

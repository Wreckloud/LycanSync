<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import InlineFeedback from './InlineFeedback.vue';
import PasswordField from './PasswordField.vue';

const emit = defineEmits<{ cancel: []; recovered: [result: { sessionToken?: string; user: AuthUser }] }>();
const password = ref('');
const busy = ref(false);
const error = ref('');
const bytes = crypto.getRandomValues(new Uint8Array(32));
const recoveryKey = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
let disposed = false;
onScopeDispose(() => { disposed = true; password.value = ''; });
async function recover() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await authRequest<{ sessionToken?: string; user: AuthUser }>('account/recover', 'POST', { password: password.value, recoveryKey });
    if (!disposed) { password.value = ''; emit('recovered', result); }
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : '恢复未完成，请重试。';
  } finally { if (!disposed) busy.value = false; }
}
</script>

<template>
  <section class="auth-card owner-recovery-card">
    <h1>群组恢复</h1>
    <p>使用恢复密码，重新登录本服务器的服主账号。</p>
    <p>昵称、群组、消息和原有权限将保留，旧登录凭据会失效。</p>
    <form @submit.prevent="recover">
      <PasswordField id="owner-recovery-password" v-model="password" label="恢复密码" :disabled="busy" required />
      <footer class="card-actions">
        <button type="button" class="settings-button" :disabled="busy" @click="emit('cancel')">返回</button>
        <InlineFeedback class="card-feedback" :message="error" :status="busy ? '正在恢复…' : ''" />
        <button type="submit" class="confirm-button card-actions-end" :disabled="busy">恢复登录</button>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.owner-recovery-card { width: min(480px, 100%); }
.owner-recovery-card form { display: grid; gap: 20px; margin-top: 20px; }
</style>

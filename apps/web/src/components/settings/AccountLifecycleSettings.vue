<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { authRequest, setBrowserSession } from '../../auth/authApi';
import InlineFeedback from '../InlineFeedback.vue';
import PasswordField from '../PasswordField.vue';
import ExpandSection from '../ExpandSection.vue';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean }>();
interface LifecycleStatus {
  administrator: boolean;
  recoveryConfigured: boolean;
  ownedGroups: { id: string; name: string }[];
  candidates: { id: string; nickname: string }[];
  incomingTransfer: { ownerNickname: string; expiresAt: string } | null;
  transferTargetId: string | null;
}
const status = ref<LifecycleStatus | null>(null);
const expanded = ref<'password' | 'transfer' | 'close' | null>(null);
const password = ref('');
const confirmation = ref('');
const previousPassword = ref('');
const targetId = ref('');
const closeConfirmation = ref('');
const busy = ref(false);
const error = ref('');
const feedback = ref('');
let revision = 0;
let disposed = false;
let request: AbortController | undefined;
function clearSecrets() { password.value = ''; confirmation.value = ''; previousPassword.value = ''; closeConfirmation.value = ''; }
async function refresh() {
  request?.abort();
  request = new AbortController();
  const current = ++revision;
  try {
    const result = await authRequest<LifecycleStatus>('account', 'GET', undefined, request.signal);
    if (!disposed && current === revision) status.value = result;
  } catch (reason) {
    if (!disposed && current === revision && !request.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取账号状态';
  }
}
function toggle(section: typeof expanded.value) {
  if (busy.value) return;
  expanded.value = expanded.value === section ? null : section;
  clearSecrets(); error.value = ''; feedback.value = '';
}
async function submit(operation: 'password' | 'offer' | 'accept' | 'cancel' | 'close') {
  if (busy.value || props.leaving || !status.value) return;
  if ((operation === 'password' || operation === 'accept') && password.value !== confirmation.value) {
    error.value = '两次输入的恢复密码不一致。'; return;
  }
  busy.value = true; error.value = ''; feedback.value = '';
  const current = revision;
  try {
    if (operation === 'password') await authRequest('account/recovery-password', 'PUT', { previousPassword: previousPassword.value, password: password.value });
    if (operation === 'offer') await authRequest('account/transfer', 'POST', { targetId: targetId.value, password: previousPassword.value });
    if (operation === 'accept') await authRequest('account/transfer/accept', 'POST', { password: password.value });
    if (operation === 'cancel') await authRequest('account/transfer', 'DELETE');
    if (operation === 'close') await authRequest('account/close', 'POST', { confirmation: closeConfirmation.value });
    if (disposed || current !== revision) return;
    clearSecrets(); expanded.value = null;
    if (operation === 'close') {
      setBrowserSession(null);
      window.dispatchEvent(new Event('lycan:unauthorized'));
      return;
    }
    feedback.value = operation === 'offer' ? '转让已发起，请让接任者在账号设置中确认。'
      : operation === 'accept' ? '已接任服主，原服主已成为普通成员。'
        : operation === 'cancel' ? '转让已取消。' : '恢复密码已保存，请妥善保管。';
    await refresh();
    if (operation === 'accept') window.dispatchEvent(new Event('lycan:account-updated'));
  } catch (reason) {
    if (!disposed && current === revision) error.value = reason instanceof Error ? reason.message : '操作未完成，请重试。';
  } finally { if (!disposed) busy.value = false; }
}
watch(() => [props.active, props.administrator] as const, ([active]) => {
  clearSecrets(); expanded.value = null;
  if (active) { error.value = ''; void refresh(); }
  else { revision++; request?.abort(); }
}, { immediate: true });
onScopeDispose(() => { disposed = true; revision++; request?.abort(); clearSecrets(); });
</script>

<template>
  <section class="settings-block lifecycle-settings">
    <template v-if="status?.administrator">
      <h2>服主恢复与转让</h2>
      <p>{{ status.recoveryConfigured ? '已设置恢复密码。无法登录时，可从欢迎页的“群组恢复”找回原账号。' : '尚未设置恢复密码，请在清除本机登录凭据前完成设置。' }}</p>
      <div class="button-actions">
        <button type="button" :disabled="busy || leaving" @click="toggle('password')">{{ status.recoveryConfigured ? '修改恢复密码' : '设置恢复密码' }}</button>
        <button type="button" :disabled="busy || leaving || !status.recoveryConfigured" @click="toggle('transfer')">转让服主</button>
      </div>
      <p v-if="status.transferTargetId">正在等待接任者确认，完成前你仍是服主。<button type="button" :disabled="busy || leaving" @click="submit('cancel')">取消转让</button></p>
      <ExpandSection :open="expanded === 'password'">
        <form class="lifecycle-form" @submit.prevent="submit('password')">
          <PasswordField v-if="status.recoveryConfigured" id="owner-old-password" v-model="previousPassword" label="原恢复密码" :disabled="busy || leaving" required />
          <PasswordField id="owner-new-password" v-model="password" label="新恢复密码（15–128 个字符）" :disabled="busy || leaving" new-password required />
          <PasswordField id="owner-confirm-password" v-model="confirmation" label="确认恢复密码" :disabled="busy || leaving" new-password required />
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">保存</button></div>
        </form>
      </ExpandSection>
      <ExpandSection :open="expanded === 'transfer'">
        <form class="lifecycle-form" @submit.prevent="submit('offer')">
          <label class="settings-field" for="owner-transfer-target">接任成员
            <select id="owner-transfer-target" v-model="targetId" :disabled="busy || leaving" required>
              <option value="" disabled>选择本服务器的成员</option>
              <option v-for="candidate in status.candidates" :key="candidate.id" :value="candidate.id">{{ candidate.nickname }}</option>
            </select>
          </label>
          <PasswordField id="owner-transfer-password" v-model="previousPassword" label="当前服主恢复密码" :disabled="busy || leaving" required />
          <p>对方须在 24 小时内确认并设置自己的恢复密码。完成后，你将成为普通成员，原恢复密码及未使用的账号邀请／恢复链接将失效。</p>
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">发起转让</button></div>
        </form>
      </ExpandSection>
    </template>
    <template v-if="status?.incomingTransfer">
      <h2>接任服主</h2><p>{{ status.incomingTransfer.ownerNickname }} 希望将服主转让给你。确认前请设置自己的恢复密码。</p>
      <form class="lifecycle-form" @submit.prevent="submit('accept')">
        <PasswordField id="accept-owner-password" v-model="password" label="恢复密码（15–128 个字符）" :disabled="busy || leaving" new-password required />
        <PasswordField id="accept-owner-confirm" v-model="confirmation" label="确认恢复密码" :disabled="busy || leaving" new-password required />
        <div class="card-actions"><button type="button" :disabled="busy || leaving" @click="submit('cancel')">拒绝</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">确认接任</button></div>
      </form>
    </template>
    <h2>注销账号</h2>
    <p>注销后无法再次登录。昵称、头像、签名、消息和共同语音等历史记录保留，并显示“已注销”。</p>
    <p v-if="status?.administrator">请先完成服主转让，再注销账号。</p>
    <div v-if="status?.ownedGroups.length"><p>请先转让或解散以下群组：</p><ul><li v-for="group in status.ownedGroups" :key="group.id">{{ group.name }}</li></ul></div>
    <button type="button" class="settings-button account-danger" :disabled="!status || busy || leaving || status.administrator || status.ownedGroups.length > 0" @click="toggle('close')">注销账号</button>
    <ExpandSection :open="expanded === 'close'">
      <form class="lifecycle-form" @submit.prevent="submit('close')">
        <label class="settings-field" for="close-account-confirmation">请输入“注销账号”确认，此操作不能撤回
          <input id="close-account-confirmation" v-model="closeConfirmation" required maxlength="4" :disabled="busy || leaving" autocomplete="off" />
        </label>
        <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="settings-button account-danger card-actions-end" :disabled="busy || leaving || closeConfirmation !== '注销账号'">确认注销</button></div>
      </form>
    </ExpandSection>
    <InlineFeedback :message="error" :pending="busy ? '正在处理…' : ''" :status="feedback" />
    <button v-if="error && !status" type="button" :disabled="busy" @click="refresh">重新读取</button>
  </section>
</template>

<style scoped>
.lifecycle-settings { display: grid; gap: 12px; }
.lifecycle-settings p { margin: 0; color: var(--muted); line-height: 1.6; }
.lifecycle-settings > button { justify-self: start; }
.lifecycle-form { display: grid; gap: 12px; padding-top: 12px; max-width: 480px; }
.account-danger { color: var(--danger); }
</style>

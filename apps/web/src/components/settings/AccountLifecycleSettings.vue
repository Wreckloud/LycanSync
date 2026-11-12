<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { authRequest, setBrowserSession } from '../../auth/authApi';
import InlineFeedback from '../InlineFeedback.vue';
import PasswordField from '../PasswordField.vue';
import ExpandSection from '../ExpandSection.vue';
import DialogTransition from '../DialogTransition.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';
import GroupManagementDialog from '../GroupManagementDialog.vue';
import { findGroup, type GroupDetail } from '../../group/groupApi';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean; section: 'account' | 'owner'; userId?: string }>();
const emit = defineEmits<{ resolveOwner: []; groupUpdated: [group: GroupDetail]; groupRemoved: [id: string] }>();
interface LifecycleStatus {
  administrator: boolean;
  recoveryConfigured: boolean;
  ownedGroups: { id: string; name: string }[];
  candidates: { id: string; nickname: string }[];
  incomingTransfer: { ownerNickname: string; expiresAt: string } | null;
  transferTargetId: string | null;
}
const status = ref<LifecycleStatus | null>(null);
const qqBound = ref<boolean | null>(null);
const expanded = ref<'password' | 'transfer' | 'close' | null>(null);
const password = ref('');
const confirmation = ref('');
const previousPassword = ref('');
const targetId = ref('');
const closeConfirmation = ref('');
const busy = ref(false);
const loading = ref(false);
const management = ref<{ group: GroupDetail; mode: 'transfer' | 'dissolve' } | null>(null);
const canClose = computed(() => !!status.value && !loading.value && !status.value.administrator && !status.value.ownedGroups.length);
const error = ref('');
const feedback = ref('');
const passwordDialog = ref<HTMLFormElement | null>(null);
const transferForm = ref<HTMLFormElement | null>(null);
const backdropEvents = useBackdropDismiss(() => toggle(null));
let revision = 0;
let disposed = false;
let request: AbortController | undefined;
let groupRequest: AbortController | undefined;
function clearSecrets() { password.value = ''; confirmation.value = ''; previousPassword.value = ''; closeConfirmation.value = ''; }
async function refresh() {
  request?.abort();
  request = new AbortController();
  const current = ++revision;
  loading.value = true;
  qqBound.value = null;
  error.value = '';
  try {
    const result = await authRequest<LifecycleStatus>('account', 'GET', undefined, request.signal);
    if (disposed || current !== revision) return;
    status.value = result;
    if (props.section === 'owner' && result.administrator && !result.recoveryConfigured) {
      const binding = await authRequest<{ bound: boolean }>('qq/binding', 'GET', undefined, request.signal);
      if (!disposed && current === revision) qqBound.value = binding.bound;
    }
  } catch (reason) {
    if (!disposed && current === revision && !request.signal.aborted) {
      status.value = null;
      error.value = reason instanceof Error ? reason.message : '无法读取账号状态';
    }
  } finally {
    if (!disposed && current === revision) loading.value = false;
  }
}
async function beginClose() {
  if (busy.value || props.leaving) return;
  toggle('close');
  if (expanded.value === 'close') await refresh();
}
async function beginTransfer() {
  if (busy.value || props.leaving) return;
  await refresh();
  if (disposed || !props.active || !status.value?.administrator) return;
  toggle(status.value.recoveryConfigured ? 'transfer' : 'password');
}
async function manageGroup(id: string, mode: 'transfer' | 'dissolve') {
  if (busy.value || props.leaving || !props.userId) return;
  groupRequest?.abort();
  const current = new AbortController();
  groupRequest = current;
  error.value = '';
  try {
    const group = await findGroup(id, current.signal);
    if (!current.signal.aborted && props.active) management.value = { group, mode };
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取群组，请重试。';
  }
}
function groupUpdated(group: GroupDetail) {
  emit('groupUpdated', group);
  management.value = null;
  void refresh();
}
function groupRemoved(id: string) {
  emit('groupRemoved', id);
  management.value = null;
  void refresh();
}
function toggle(section: typeof expanded.value) {
  if (busy.value) return;
  groupRequest?.abort();
  management.value = null;
  expanded.value = expanded.value === section ? null : section;
  clearSecrets(); error.value = ''; feedback.value = '';
}
async function submit(operation: 'password' | 'offer' | 'accept' | 'cancel' | 'close') {
  if (busy.value || props.leaving || !status.value) return;
  if (operation === 'close' && (!canClose.value || closeConfirmation.value !== '注销账号')) return;
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
    if (!disposed && current === revision) {
      const message = reason instanceof Error ? reason.message : '操作未完成，请重试。';
      if (operation === 'close') await refresh();
      if (!disposed && props.active) error.value = message;
    }
  } finally { if (!disposed) busy.value = false; }
}
watch(expanded, async (section) => {
  if (section !== 'password' && section !== 'transfer') return;
  await nextTick();
  if (section === 'password') passwordDialog.value?.querySelector('input')?.focus();
  else transferForm.value?.focus();
});
watch(() => [props.active, props.administrator, props.section] as const, ([active]) => {
  clearSecrets();
  if (expanded.value !== 'close') expanded.value = null;
  if (active) { error.value = ''; void refresh(); }
  else { revision++; request?.abort(); groupRequest?.abort(); management.value = null; loading.value = false; }
}, { immediate: true });
onScopeDispose(() => { disposed = true; revision++; request?.abort(); groupRequest?.abort(); clearSecrets(); });
defineExpose({ beginTransfer });
</script>

<template>
  <section class="settings-block lifecycle-settings">
    <template v-if="section === 'owner' && status?.administrator">
      <h2>服主账号</h2>
      <div class="settings-toggle-group">
        <div class="settings-action-row">
          <div><strong>恢复密码 · {{ status.recoveryConfigured ? '已设置' : '未设置' }}</strong>
            <small>无法登录时，可通过“群组恢复”找回账号。</small>
            <small v-if="!status.recoveryConfigured && qqBound === false" class="recovery-warning" role="status">安全建议：请设置服主恢复密码，避免本机登录信息丢失后无法找回账号。</small>
          </div>
          <button type="button" :disabled="busy || leaving" @click="toggle('password')">{{ status.recoveryConfigured ? '修改恢复密码' : '设置恢复密码' }}</button>
        </div>
        <div class="settings-action-row">
          <div><strong>转让服主</strong><small>{{ status.recoveryConfigured ? '将服务器交给另一位成员管理。' : '设置恢复密码后，可将服务器交给另一位成员管理。' }}</small></div>
          <button type="button" :disabled="busy || leaving || !status.recoveryConfigured" @click="toggle('transfer')">转让服主</button>
        </div>
      </div>
      <p v-if="status.transferTargetId">正在等待接任者确认，完成前你仍是服主。<button type="button" :disabled="busy || leaving" @click="submit('cancel')">取消转让</button></p>
      <ExpandSection :open="expanded === 'transfer'">
        <form ref="transferForm" class="lifecycle-form" tabindex="-1" @submit.prevent="submit('offer')">
          <label class="settings-field" for="owner-transfer-target">接任成员
            <select id="owner-transfer-target" v-model="targetId" :disabled="busy || leaving" required>
              <option value="" disabled>选择本服务器的成员</option>
              <option v-for="candidate in status.candidates" :key="candidate.id" :value="candidate.id">{{ candidate.nickname }}</option>
            </select>
          </label>
          <PasswordField id="owner-transfer-password" v-model="previousPassword" label="当前服主恢复密码" :disabled="busy || leaving" required />
          <p>对方需在 24 小时内确认并设置恢复密码。转让后你将成为普通成员，原服主恢复密码及未使用的账号邀请、恢复链接将失效。</p>
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">发起转让</button></div>
        </form>
      </ExpandSection>
    </template>
    <template v-if="section === 'account' && status?.incomingTransfer">
      <h2>接任服主</h2><p>{{ status.incomingTransfer.ownerNickname }} 希望将服主转让给你。确认前请设置自己的恢复密码。</p>
      <form class="lifecycle-form" @submit.prevent="submit('accept')">
        <PasswordField id="accept-owner-password" v-model="password" label="恢复密码（15–128 个字符）" :disabled="busy || leaving" new-password required />
        <PasswordField id="accept-owner-confirm" v-model="confirmation" label="确认恢复密码" :disabled="busy || leaving" new-password required />
        <div class="card-actions"><button type="button" :disabled="busy || leaving" @click="submit('cancel')">拒绝</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">确认接任</button></div>
      </form>
    </template>
    <template v-if="section === 'account'">
      <div class="settings-action-row"><h2>注销账号</h2>
        <button type="button" class="settings-button account-danger" :disabled="busy || leaving" @click="beginClose">注销账号</button>
      </div>
      <p>注销后无法再登录。历史昵称、头像、签名、消息和共同语音记录仍会保留，并标记为“已注销”。</p>
      <p v-if="status?.administrator">请先完成服主转让，再注销账号。</p>
      <p v-if="status?.ownedGroups.length">请先转让或解散名下的 {{ status.ownedGroups.length }} 个群组。</p>
      <ExpandSection :open="expanded === 'close'">
        <div class="closure-steps">
          <div v-if="status?.administrator" class="settings-action-row">
            <div><strong>服主转让</strong><small>{{ status.transferTargetId ? '等待接任者确认后，才能继续注销。' : '由另一位成员接任服主后，再继续注销。' }}</small></div>
            <button type="button" :disabled="busy || loading || leaving" @click="emit('resolveOwner')">{{ status.transferTargetId ? '查看转让' : '去转让服主' }}</button>
          </div>
          <div v-for="group in status?.ownedGroups" :key="group.id" class="settings-action-row">
            <div><strong>{{ group.name }}</strong><small>可转交给群成员，或解散群组。</small></div>
            <div class="closure-group-actions">
              <button type="button" :disabled="busy || loading || leaving" @click="manageGroup(group.id, 'transfer')">转让群组</button>
              <button type="button" class="account-danger" :disabled="busy || loading || leaving" @click="manageGroup(group.id, 'dissolve')">解散群组</button>
            </div>
          </div>
        <form v-if="canClose" class="lifecycle-form" @submit.prevent="submit('close')">
          <label class="settings-field" for="close-account-confirmation">请输入“注销账号”确认，此操作不能撤回
            <input id="close-account-confirmation" v-model="closeConfirmation" required maxlength="4" :disabled="busy || leaving" autocomplete="off" />
          </label>
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="settings-button account-danger card-actions-end" :disabled="busy || leaving || closeConfirmation !== '注销账号'">确认注销</button></div>
        </form>
        <div v-else class="card-actions">
          <button type="button" :disabled="busy" @click="toggle(null)">取消注销</button>
          <button type="button" class="card-actions-end" :disabled="busy || loading || leaving" @click="refresh">继续注销</button>
        </div>
        </div>
      </ExpandSection>
    </template>
    <InlineFeedback v-if="expanded !== 'password'" :message="error" :pending="busy ? '正在处理…' : loading && expanded === 'close' ? '正在检查注销条件…' : ''" :status="feedback" />
    <button v-if="expanded !== 'password' && error && (!status || section === 'owner' && qqBound === null && status.administrator && !status.recoveryConfigured)" type="button" :disabled="busy" @click="refresh">重新读取</button>
  </section>
  <DialogTransition>
    <div v-if="expanded === 'password' && active && section === 'owner' && status?.administrator" class="dialog-backdrop"
      v-on="backdropEvents" @keydown.esc.stop="toggle(null)">
      <form ref="passwordDialog" class="recovery-password-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-password-title"
        tabindex="-1" @submit.prevent="submit('password')" @keydown="keepDialogFocus">
        <h2 id="recovery-password-title">{{ status.recoveryConfigured ? '修改恢复密码' : '设置恢复密码' }}</h2>
        <PasswordField v-if="status.recoveryConfigured" id="owner-old-password" v-model="previousPassword" label="原恢复密码" :disabled="busy || leaving" required />
        <PasswordField id="owner-new-password" v-model="password" label="新恢复密码（15–128 个字符）" :disabled="busy || leaving" new-password required />
        <PasswordField id="owner-confirm-password" v-model="confirmation" label="确认恢复密码" :disabled="busy || leaving" new-password required />
        <InlineFeedback :message="error" :pending="busy ? '正在保存…' : ''" />
        <footer class="card-actions">
          <button type="button" :disabled="busy" @click="toggle(null)">取消</button>
          <button class="confirm-button card-actions-end" :disabled="busy || leaving">保存</button>
        </footer>
      </form>
    </div>
  </DialogTransition>
  <DialogTransition>
    <GroupManagementDialog v-if="management && userId" :group="management.group" :mode="management.mode" :user-id="userId"
      @updated="groupUpdated" @removed="groupRemoved" @close="management = null" />
  </DialogTransition>
</template>

<style scoped>
.lifecycle-settings { display: grid; gap: 12px; }
.lifecycle-settings p { margin: 0; color: var(--muted); line-height: 1.6; }
.lifecycle-settings .recovery-warning { color: var(--danger); }
.lifecycle-settings > button { justify-self: start; }
.lifecycle-form { display: grid; gap: 12px; padding-top: 12px; max-width: 480px; }
.account-danger { color: var(--danger); }
.closure-steps { display: grid; gap: 12px; padding-top: 12px; }
.settings-action-row > .closure-group-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; flex-shrink: 0; }
.recovery-password-dialog { display: grid; gap: 12px; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.recovery-password-dialog h2 { margin: 0 0 4px; font-size: 22px; line-height: 32px; }
@media (max-width: 420px) { .recovery-password-dialog { padding: 20px; } }
</style>

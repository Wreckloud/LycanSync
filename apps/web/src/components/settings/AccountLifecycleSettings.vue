<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { authRequest, setBrowserSession, type AuthUser } from '../../auth/authApi';
import InlineFeedback from '../InlineFeedback.vue';
import PasswordField from '../PasswordField.vue';
import RecoveryPasswordDialog from '../RecoveryPasswordDialog.vue';
import DialogTransition from '../DialogTransition.vue';
import { useBackdropDismiss } from '../useBackdropDismiss';
import { keepDialogFocus } from '../dialogFocus';
import GroupManagementDialog from '../GroupManagementDialog.vue';
import MemberPicker from '../MemberPicker.vue';
import { findGroup, type GroupDetail } from '../../group/groupApi';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean; section: 'account' | 'owner'; userId?: string }>();
const emit = defineEmits<{ groupUpdated: [group: GroupDetail]; groupRemoved: [id: string]; notice: [message: string] }>();
interface LifecycleStatus {
  administrator: boolean;
  recoveryConfigured: boolean;
  ownedGroups: { id: string; name: string }[];
  incomingTransfer: { ownerNickname: string; expiresAt: string } | null;
  transferTargetId: string | null;
}
const status = ref<LifecycleStatus | null>(null);
const qqBound = ref<boolean | null>(null);
const expanded = ref<'password' | 'transfer' | 'close' | 'accept' | null>(null);
const closingAccount = ref(false);
const transferAfterPassword = ref(false);
const password = ref('');
const confirmation = ref('');
const previousPassword = ref('');
const targetId = ref('');
const closeConfirmation = ref('');
const busy = ref(false);
const loading = ref(false);
const management = ref<{ group: GroupDetail; mode: 'transfer' | 'dissolve' | 'resolve' } | null>(null);
const resolvingGroups = ref(false);
const groupProcessing = ref(false);
const groupNames = computed(() => status.value?.ownedGroups.map(group => group.name).join('、') ?? '');
const canClose = computed(() => !!status.value && !loading.value && !status.value.administrator && !status.value.ownedGroups.length);
const error = ref('');
const feedback = ref('');
const transferForm = ref<HTMLFormElement | null>(null);
const closeDialog = ref<HTMLElement | null>(null);
const acceptDialog = ref<HTMLFormElement | null>(null);
const backdropEvents = useBackdropDismiss(() => toggle(null));
let revision = 0;
let disposed = false;
let request: AbortController | undefined;
let groupRequest: AbortController | undefined;
async function loadSuccessors(search: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({ search, offset: String(offset) });
  const members = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined, signal);
  return { members: members.map(member => ({ userId: member.id, nickname: member.nickname, avatar: member.avatar })), hasMore: members.length === 100 };
}
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
  closingAccount.value = expanded.value === 'close';
  if (!closingAccount.value) return;
  await refresh();
  if (props.active && expanded.value === 'close' && status.value?.administrator && !status.value.recoveryConfigured) openTransfer();
}
async function beginTransfer() {
  if (busy.value || props.leaving) return;
  const origin = expanded.value;
  await refresh();
  if (disposed || !props.active || expanded.value !== origin || !status.value?.administrator) return;
  openTransfer();
}
function openTransfer() {
  if (!status.value?.administrator) return;
  const needsPassword = !status.value.recoveryConfigured;
  toggle(needsPassword ? 'password' : 'transfer');
  transferAfterPassword.value = needsPassword;
  if (needsPassword) error.value = '请先设置恢复密码，再转让服主。';
}
async function manageGroup(id: string, mode: 'transfer' | 'dissolve' | 'resolve') {
  if (busy.value || props.leaving || !props.userId) return;
  groupRequest?.abort();
  const current = new AbortController();
  groupRequest = current;
  error.value = '';
  try {
    const group = await findGroup(id, current.signal);
    if (!current.signal.aborted && props.active) { management.value = { group, mode }; resolvingGroups.value = true; return true; }
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取群组，请重试。';
  }
  return false;
}
async function groupUpdated(group: GroupDetail) {
  emit('groupUpdated', group);
  await nextGroup();
}
async function groupRemoved(id: string) {
  emit('groupRemoved', id);
  await nextGroup();
}
async function nextGroup() {
  groupProcessing.value = true;
  await refresh();
  if (disposed || !props.active || !resolvingGroups.value) { groupProcessing.value = false; return; }
  const next = status.value?.ownedGroups[0];
  if (next) {
    if (!await manageGroup(next.id, 'resolve')) management.value = null;
  } else management.value = null;
  if (!management.value) resolvingGroups.value = false;
  groupProcessing.value = false;
}
function closeManagement() {
  groupRequest?.abort(); management.value = null; resolvingGroups.value = false;
}
function toggle(section: typeof expanded.value) {
  if (busy.value) return;
  groupRequest?.abort();
  management.value = null; resolvingGroups.value = false;
  const returning = section === null && closingAccount.value && expanded.value !== 'close' && expanded.value !== 'password';
  expanded.value = returning ? 'close' : expanded.value === section ? null : section;
  if (!expanded.value) closingAccount.value = false;
  transferAfterPassword.value = false;
  clearSecrets(); error.value = ''; feedback.value = '';
  if (returning) void refresh();
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
    if (operation === 'password') emit('notice', '恢复密码已保存。');
    const next = operation === 'password' && transferAfterPassword.value ? 'transfer' : closingAccount.value ? 'close' : null;
    transferAfterPassword.value = false;
    clearSecrets(); expanded.value = next;
    if (operation === 'close') {
      setBrowserSession(null);
      window.dispatchEvent(new Event('lycan:unauthorized'));
      return;
    }
    feedback.value = operation === 'offer' ? '转让已发起，请让接任者在账号设置中确认。'
      : operation === 'accept' ? '已接任服主，原服主已成为普通成员。'
        : operation === 'cancel' ? '转让已取消。' : '';
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
watch(() => [expanded.value, props.active] as const, async ([section, active]) => {
  if (!section || !active) return;
  await nextTick();
  if (section === 'transfer') transferForm.value?.focus();
  else if (section === 'close') closeDialog.value?.focus();
  else if (section === 'accept') acceptDialog.value?.focus();
});
watch(() => [props.active, props.administrator, props.section] as const, ([active]) => {
  clearSecrets();
  expanded.value = null; closingAccount.value = false; transferAfterPassword.value = false; resolvingGroups.value = false;
  if (active) { error.value = ''; void refresh(); }
  else { revision++; request?.abort(); groupRequest?.abort(); management.value = null; loading.value = false; }
}, { immediate: true });
onScopeDispose(() => { disposed = true; revision++; request?.abort(); groupRequest?.abort(); clearSecrets(); });
</script>

<template>
  <section class="settings-block lifecycle-settings" :class="{ 'account-operation': section === 'account' }">
    <template v-if="section === 'owner' && status?.administrator">
      <h2>服主账号</h2>
      <div class="settings-toggle-group owner-account-actions">
        <div class="settings-action-row">
          <div><strong>恢复密码 · {{ status.recoveryConfigured ? '已设置' : '未设置' }}</strong>
            <small>无法登录时，可通过“群组恢复”找回账号。</small>
            <small v-if="!status.recoveryConfigured && qqBound === false" class="recovery-warning" role="status">设置恢复密码，方便在登录信息丢失时找回服主账号。</small>
          </div>
          <button type="button" :disabled="busy || leaving" @click="toggle('password')">{{ status.recoveryConfigured ? '修改恢复密码' : '设置恢复密码' }}</button>
        </div>
        <div class="settings-action-row">
          <div><strong>转让服主</strong><small>{{ status.recoveryConfigured ? '将服务器交给另一位成员管理。' : '设置恢复密码后，可将服务器交给另一位成员管理。' }}</small></div>
          <button type="button" :disabled="busy || leaving || !status.recoveryConfigured" @click="toggle('transfer')">转让服主</button>
        </div>
      </div>
      <p v-if="status.transferTargetId">正在等待接任者确认，完成前你仍是服主。<button type="button" :disabled="busy || leaving" @click="submit('cancel')">取消转让</button></p>
    </template>
    <template v-if="section === 'account' && status?.incomingTransfer">
      <h2>接任服主</h2><p>{{ status.incomingTransfer.ownerNickname }} 希望将服主转让给你。确认前请设置自己的恢复密码。</p>
      <button type="button" class="settings-button settings-control" :disabled="busy || leaving" @click="toggle('accept')">查看转让</button>
    </template>
    <template v-if="section === 'account'">
      <div class="settings-action-row"><h3>注销账号</h3>
        <button type="button" class="settings-button account-danger settings-control" :disabled="busy || leaving" @click="beginClose">注销账号</button>
      </div>
      <p>注销后无法再次登录；历史资料、消息和共同语音记录会保留，并标记为“已注销”。</p>
      <p v-if="status?.administrator || status?.ownedGroups.length" class="closure-requirements">
        <span v-if="status?.administrator">请先完成服主转让，再注销账号。</span>
        <span v-if="status?.ownedGroups.length">请先转让或解散名下的 {{ status.ownedGroups.length }} 个群组。</span>
      </p>
    </template>
    <InlineFeedback v-if="!expanded" :message="error" :pending="busy ? '正在处理…' : ''" :status="feedback" />
    <button v-if="!expanded && error && (!status || section === 'owner' && qqBound === null && status.administrator && !status.recoveryConfigured)" type="button" :disabled="busy" @click="refresh">重新读取</button>
  </section>
  <DialogTransition>
    <div v-if="expanded === 'transfer' && active && status?.administrator" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="toggle(null)">
        <form ref="transferForm" class="recovery-password-dialog" role="dialog" aria-modal="true" aria-label="转让服主" tabindex="-1" @keydown="keepDialogFocus" @submit.prevent="submit('offer')">
          <h2>转让服主</h2>
          <template v-if="status.transferTargetId">
            <p>正在等待接任者确认，完成前你仍是服主。</p>
            <InlineFeedback :message="error" :pending="busy ? '正在处理…' : ''" />
            <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">关闭</button><button type="button" class="settings-button card-actions-end" :disabled="busy || leaving" @click="submit('cancel')">取消转让</button></div>
          </template>
          <template v-else>
          <strong>接任成员</strong>
          <MemberPicker :load="loadSuccessors" :selected="targetId" :disabled="busy || leaving" label="搜索服务器成员" @select="targetId = $event.userId" />
          <PasswordField id="owner-transfer-password" v-model="previousPassword" label="当前服主恢复密码" :disabled="busy || leaving" required />
          <p>对方需在 24 小时内确认并设置恢复密码。转让后你将成为普通成员，原服主恢复密码及未使用的账号邀请、恢复链接将失效。</p>
          <InlineFeedback :message="error" :pending="busy ? '正在处理…' : ''" />
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="confirm-button card-actions-end" :disabled="busy || leaving || !targetId">发起转让</button></div>
          </template>
        </form>
    </div>
  </DialogTransition>
  <DialogTransition>
    <div v-if="expanded === 'accept' && active && status?.incomingTransfer" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="toggle(null)">
      <form ref="acceptDialog" class="recovery-password-dialog" role="dialog" aria-modal="true" aria-label="接任服主" tabindex="-1" @keydown="keepDialogFocus" @submit.prevent="submit('accept')">
        <h2>接任服主</h2>
        <PasswordField id="accept-owner-password" v-model="password" label="恢复密码（至少 6 位）" :disabled="busy || leaving" new-password required />
        <PasswordField id="accept-owner-confirm" v-model="confirmation" label="确认恢复密码" :disabled="busy || leaving" new-password required />
        <InlineFeedback :message="error" :pending="busy ? '正在处理…' : ''" />
        <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button type="button" :disabled="busy || leaving" @click="submit('cancel')">拒绝</button><button class="confirm-button card-actions-end" :disabled="busy || leaving">确认接任</button></div>
      </form>
    </div>
  </DialogTransition>
  <DialogTransition>
    <div v-if="expanded === 'close' && active && !resolvingGroups" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="toggle(null)">
      <section ref="closeDialog" class="recovery-password-dialog" role="dialog" aria-modal="true" aria-label="注销账号" tabindex="-1" @keydown="keepDialogFocus">
        <h2>注销账号</h2>
        <p>{{ canClose ? '注销后无法再次登录，此操作不能撤回。' : '完成下面的事项后，即可继续注销。' }}</p>
          <div v-if="status?.administrator" class="settings-action-row">
            <div><strong>服主转让</strong><small>{{ status.transferTargetId ? '等待接任者确认后，才能继续注销。' : '由另一位成员接任服主后，再继续注销。' }}</small></div>
            <button type="button" :disabled="busy || loading || leaving" @click="beginTransfer">{{ status.transferTargetId ? '查看转让' : '去转让服主' }}</button>
          </div>
          <div v-if="status?.ownedGroups.length" class="closure-groups">
            <p>这些群聊需要处理，可转交给群成员或解散群组：</p>
            <p class="closure-group-names" :title="groupNames">{{ groupNames }}</p>
            <button type="button" :disabled="busy || loading || leaving" @click="manageGroup(status.ownedGroups[0].id, 'resolve')">处理群组</button>
          </div>
        <InlineFeedback :message="error" :pending="busy ? '正在处理…' : loading ? '正在检查注销条件…' : ''" />
        <form v-if="canClose" class="lifecycle-form" @submit.prevent="submit('close')">
          <label class="settings-field" for="close-account-confirmation">请输入“注销账号”确认，此操作不能撤回
            <input id="close-account-confirmation" v-model="closeConfirmation" required maxlength="4" :disabled="busy || leaving" autocomplete="off" />
          </label>
          <div class="card-actions"><button type="button" :disabled="busy" @click="toggle(null)">取消</button><button class="settings-button account-danger card-actions-end" :disabled="busy || leaving || closeConfirmation !== '注销账号'">确认注销</button></div>
        </form>
        <div v-else class="card-actions">
          <button type="button" :disabled="busy" @click="toggle(null)">取消注销</button>
          <button type="button" class="settings-button card-actions-end" :disabled="busy || loading || leaving" @click="refresh">继续注销</button>
        </div>
      </section>
    </div>
  </DialogTransition>
  <DialogTransition>
    <RecoveryPasswordDialog v-if="expanded === 'password' && active && status?.administrator"
      v-model:password="password" v-model:confirmation="confirmation" v-model:previous-password="previousPassword"
      :configured="status.recoveryConfigured" :busy="busy" :disabled="leaving" :error="error"
      @cancel="toggle(null)" @save="submit('password')" />
  </DialogTransition>
  <DialogTransition>
    <GroupManagementDialog v-if="management && userId" :key="management.group.id" :group="management.group" :mode="management.mode" :user-id="userId"
      :remaining="status?.ownedGroups.length" :pending="groupProcessing" @updated="groupUpdated" @removed="groupRemoved" @close="closeManagement" />
  </DialogTransition>
</template>

<style scoped>
.lifecycle-settings { display: grid; gap: 12px; }
.owner-account-actions { grid-template-columns: minmax(0, 1fr) max-content; }
.owner-account-actions > .settings-action-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.lifecycle-settings p { margin: 0; color: var(--muted); line-height: 1.6; }
.lifecycle-settings .recovery-warning { color: var(--danger); }
.lifecycle-settings > button { justify-self: start; }
.lifecycle-form { display: grid; gap: 12px; padding-top: 12px; max-width: 480px; }
.account-danger { color: var(--danger); }
.closure-requirements > span { display: block; }
.closure-groups { display: grid; gap: 8px; min-width: 0; }
.closure-group-names { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recovery-password-dialog { display: grid; gap: 12px; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.recovery-password-dialog p { margin: 0; color: var(--muted); }
.recovery-password-dialog h2 { margin: 0 0 4px; font-size: 22px; line-height: 32px; }
@media (max-width: 420px) { .recovery-password-dialog { padding: 20px; } }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import ExpandSection from './ExpandSection.vue';
import DialogTransition from './DialogTransition.vue';
import MemberPicker, { type MemberOption } from './MemberPicker.vue';
import SegmentedControl from './SegmentedControl.vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';
import { useMemberAccess, type MemberAccessMode, type AccessLinkFilter } from '../settings/useMemberAccess';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ mode: MemberAccessMode }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const confirmationDialog = ref<HTMLElement | null>(null);
const linkInput = ref<HTMLInputElement | null>(null);
const showResult = ref(false);
const selectedMember = ref<MemberOption | null>(null);
const confirmingRecovery = ref(false);
const editingId = ref('');
const editingNote = ref('');
const revokeId = ref('');
const { links, offset, filter, note, target, generatedUrl, generatedRecord, error, recordsError, copyStatus,
  busy, refreshing, locked, currentTime, refresh, generate, revoke, copyLink, saveNote, page } = useMemberAccess(ref(true), props.mode);
const title = computed(() => showResult.value ? '恢复链接' : { invite: '邀请新朋友', recovery: '恢复成员登录', links: '链接管理' }[props.mode]);
const filters: { id: AccessLinkFilter; label: string }[] = [
  { id: 'PENDING', label: '待使用' }, { id: 'USED', label: '已使用' }, { id: 'REVOKED', label: '已撤销' }, { id: 'ALL', label: '全部' },
];
const backdropEvents = useBackdropDismiss(close);
const confirmationBackdrop = useBackdropDismiss(cancelRecovery);
const pending = (link: AccessLinkRecord) => accessLinkStatus(link, currentTime.value) === '待使用';
function close() { if (!locked.value) emit('close'); }
async function loadMembers(search: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({ search, offset: String(offset) });
  const members = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined, signal);
  return { members: members.map(member => ({ userId: member.id, nickname: member.nickname, avatar: member.avatar })), hasMore: members.length === 100 };
}
async function selectMember(member: MemberOption) {
  selectedMember.value = member; target.value = member.userId; note.value = `${member.nickname} 的恢复链接`;
  error.value = ''; confirmingRecovery.value = true;
  await nextTick(); confirmationDialog.value?.focus();
}
function cancelRecovery() { if (!locked.value) { confirmingRecovery.value = false; error.value = ''; } }
async function confirmRecovery() {
  if (await generate('RECOVERY')) {
    confirmingRecovery.value = false; showResult.value = true;
    await nextTick(); linkInput.value?.focus();
  }
}
async function copy(id?: string) {
  const trigger = document.activeElement;
  const copied = await copyLink(id);
  await nextTick();
  if (!copied && generatedUrl.value) { linkInput.value?.focus(); linkInput.value?.select(); }
  else if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
}
function edit(link: AccessLinkRecord) {
  editingId.value = link.id; editingNote.value = link.note; revokeId.value = ''; error.value = '';
}
async function save() { if (await saveNote(editingId.value, editingNote.value)) editingId.value = ''; }
async function confirmRevoke() { if (await revoke(revokeId.value)) revokeId.value = ''; }
function changeFilter(value: AccessLinkFilter) { editingId.value = ''; revokeId.value = ''; error.value = ''; filter.value = value; }
onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="member-access-dialog" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header>
        <h2>{{ title }}</h2>
        <p v-if="showResult">恢复链接 12 小时有效，仅发给需要恢复登录的成员。</p>
        <p v-else-if="mode === 'invite'">复制链接发给朋友，每条链接可邀请一人。</p>
        <p v-else-if="mode === 'recovery'">找到需要恢复登录的成员，核对后生成链接。</p>
        <p v-else>查看邀请与恢复链接，修改备注或撤销不再需要的链接。</p>
      </header>
      <div v-if="showResult" class="access-body">
        <strong>{{ selectedMember?.nickname }}</strong>
        <p v-if="generatedRecord?.note">{{ generatedRecord.note }}</p>
        <label class="settings-field">恢复链接<input ref="linkInput" :value="generatedUrl" readonly aria-label="生成的链接" /></label>
        <InlineFeedback :message="error" :status="copyStatus" />
      </div>
      <div v-else-if="mode === 'recovery'" class="access-body">
        <MemberPicker :load="loadMembers" :disabled="locked" label="搜索可恢复成员" @select="selectMember" />
      </div>
      <div v-else class="access-body">
        <SegmentedControl v-if="mode === 'links'" :model-value="filter" :options="filters" :disabled="locked" tabs label="链接分类" id-prefix="access-filter" controls="access-records" @update:model-value="changeFilter" />
        <div id="access-records" class="access-records" :role="mode === 'links' ? 'tabpanel' : undefined" :aria-labelledby="mode === 'links' ? `access-filter-${filter}` : undefined">
          <p v-if="!links.length && !refreshing && !busy && !recordsError">暂无{{ mode === 'invite' || filter === 'PENDING' ? '待使用的链接' : '记录' }}</p>
          <article v-for="link in links" :key="link.id" class="access-record" :data-link-id="link.id">
            <div class="access-record-details">
              <strong>{{ link.kind === 'RECOVERY' ? '恢复链接' : '邀请链接' }}<span v-if="mode === 'links'"> · {{ accessLinkStatus(link, currentTime) === '已完成' ? '已使用' : accessLinkStatus(link, currentTime) }}</span></strong>
              <span v-if="link.note">{{ link.note }}</span>
              <small>{{ pending(link) ? '到期' : '创建' }}：{{ new Date(pending(link) ? link.expiresAt : link.createdAt).toLocaleString() }}</small>
              <small v-if="link.lastFailure" class="error">{{ link.lastFailure }}</small>
            </div>
            <div class="button-actions">
              <template v-if="pending(link)">
                <button type="button" :disabled="locked" @click="copy(link.id)">复制链接</button>
                <button type="button" :disabled="locked" @click="edit(link)">修改备注</button>
              </template>
              <template v-if="mode === 'links' && !link.consumedAt">
                <button type="button" :disabled="locked" @click="generate(link.kind === 'RECOVERY' ? 'RECOVERY' : 'INVITE', link.id)">重新生成</button>
                <button v-if="!link.revokedAt" type="button" :disabled="locked" @click="revokeId = link.id; editingId = ''; error = ''">撤销</button>
              </template>
            </div>
            <ExpandSection :open="editingId === link.id && pending(link)">
              <form class="access-note-form" @submit.prevent="save">
                <label class="settings-field" :for="`access-note-${link.id}`"><span>备注 <small>选填，仅服主可见</small></span>
                  <input :id="`access-note-${link.id}`" v-model="editingNote" maxlength="100" :disabled="locked" placeholder="朋友的名字或用途" />
                </label>
                <div class="card-actions"><button type="button" :disabled="locked" @click="editingId = ''">取消</button><button class="confirm-button card-actions-end" :disabled="locked">保存备注</button></div>
              </form>
            </ExpandSection>
            <ExpandSection :open="revokeId === link.id && !link.revokedAt && !link.consumedAt">
              <p>撤销后，这条链接将立即失效。</p>
              <div class="card-actions"><button type="button" :disabled="locked" @click="revokeId = ''">取消</button><button type="button" class="confirm-button is-danger card-actions-end" :disabled="locked" @click="confirmRevoke">确认撤销</button></div>
            </ExpandSection>
          </article>
        </div>
        <InlineFeedback :message="error || recordsError" :status="copyStatus" :pending="busy ? '正在处理…' : refreshing && !links.length ? '正在读取链接…' : ''" />
        <label v-if="error && generatedUrl" class="settings-field">链接<input ref="linkInput" :value="generatedUrl" readonly aria-label="手动复制链接" /></label>
        <button v-if="recordsError || error && mode === 'invite' && !generatedRecord" type="button" :disabled="locked" @click="mode === 'invite' && !generatedRecord ? generate('INVITE', undefined, true) : refresh()">重试</button>
        <div v-if="offset || links.length === 100" class="access-pagination">
          <button type="button" :disabled="locked || refreshing || offset === 0" @click="page(-1)">上一页记录</button>
          <button type="button" :disabled="locked || refreshing || links.length < 100" @click="page(1)">下一页记录</button>
        </div>
      </div>
      <footer class="card-actions">
        <button type="button" :disabled="locked" @click="close">关闭</button>
        <button v-if="showResult" type="button" class="confirm-button card-actions-end" :disabled="locked" @click="copy()">复制链接</button>
        <button v-else-if="mode === 'invite'" type="button" class="confirm-button card-actions-end" :disabled="locked" @click="generate('INVITE')">生成新的邀请链接</button>
      </footer>
    </section>
  <DialogTransition>
    <div v-if="confirmingRecovery" class="dialog-backdrop" v-on="confirmationBackdrop" @keydown.esc.stop="cancelRecovery">
      <form ref="confirmationDialog" class="member-access-dialog recovery-confirm" role="dialog" aria-modal="true" aria-label="确认恢复成员登录" tabindex="-1" @keydown="keepDialogFocus" @submit.prevent="confirmRecovery">
        <header><h2>确认恢复成员登录</h2><p>为 {{ selectedMember?.nickname }} 生成恢复链接。对方使用后，旧设备将退出登录。</p></header>
        <div class="access-body">
          <label class="settings-field" for="recovery-note"><span>备注 <small>选填，仅服主可见</small></span><input id="recovery-note" v-model="note" maxlength="100" :disabled="locked" /></label>
          <InlineFeedback :message="error" :pending="busy ? '正在生成链接…' : ''" />
        </div>
        <div class="card-actions"><button type="button" :disabled="locked" @click="cancelRecovery">取消</button><button class="confirm-button card-actions-end" :disabled="locked">生成恢复链接</button></div>
      </form>
    </div>
  </DialogTransition>
  </div>
</template>

<style scoped>
.member-access-dialog { width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 20px; }
.recovery-confirm { width: min(460px, calc(100vw - 32px)); }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
header p { margin: 4px 0 0; }
p, small { color: var(--muted); }
small { font-size: 12px; }
.access-body { display: grid; gap: 12px; margin: 20px 0; }
.access-body p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.access-body input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; }
.access-body input:focus { border-color: var(--subtle); }
.access-records { max-height: 360px; overflow-y: auto; scrollbar-gutter: stable; }
.access-record { display: grid; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border-soft); }
.access-record:first-child { padding-top: 0; }
.access-record-details { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.access-note-form { padding-top: 8px; }
.access-record .button-actions, .access-pagination { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 420px) { .member-access-dialog { padding: 20px; } }
</style>

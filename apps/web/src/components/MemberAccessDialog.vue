<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { ArrowRight } from '@lucide/vue';
import InlineFeedback from './InlineFeedback.vue';
import { motionDurationMs } from '../styles/motion';
import MemberPicker, { type MemberOption } from './MemberPicker.vue';
import MemberIdentity from './MemberIdentity.vue';
import SegmentedControl from './SegmentedControl.vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../auth/accountAccess';
import { useMemberAccess, type MemberAccessMode, type AccessLinkFilter } from '../settings/useMemberAccess';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ mode: MemberAccessMode; active: boolean; returnTo?: 'invite' | 'recovery' | null }>();
const emit = defineEmits<{ close: []; manage: []; back: []; notice: [message: string] }>();
const invitationDraft = defineModel<{ id: string; note: string; savedNote: string } | null>('invitationDraft', { default: null });
const memberScroll = defineModel<number>('memberScroll', { default: 0 });
const memberSearch = defineModel<string>('memberSearch', { default: '' });
const dialog = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
let animation: Animation | undefined;
let motion = 0;
const linkInput = ref<HTMLInputElement | null>(null);
const selectedMember = ref<MemberOption | null>(null);
const operation = ref<'recovery' | 'note' | 'revoke' | 'renew' | null>(null);
const selectedLink = ref<AccessLinkRecord | null>(null);
const editingNote = ref('');
const generatedForConfirmation = ref(false);
const { links, offset, filter, note, target, generatedUrl, generatedRecord, error, recordsError,
  recordsLoaded, busy, refreshing, locked, currentTime, refresh, prepareInvitation,
  generate, revoke, copyLink, saveNote, page } = useMemberAccess(computed(() => props.active), props.mode, message => emit('notice', message));
const title = computed(() => ({ invite: '邀请新朋友', recovery: '恢复成员登录', links: '链接管理' })[props.mode]);
const pending = (link: AccessLinkRecord) => accessLinkStatus(link, currentTime.value) === '待使用';
const recoveryTargets = computed(() => new Set(links.value.filter(pending).map(link => link.targetId)));
const existingRecovery = computed(() => !!selectedMember.value && recoveryTargets.value.has(selectedMember.value.userId));
const confirmationTitle = computed(() => operation.value === 'recovery'
  ? existingRecovery.value ? '重新生成恢复链接' : '确认恢复成员登录'
  : operation.value === 'note' ? '修改备注' : operation.value === 'revoke' ? '撤销链接' : '重新生成链接');
const confirmationAction = computed(() => {
  if (generatedForConfirmation.value) return '重试复制';
  if (operation.value === 'note') return '保存备注';
  if (operation.value === 'revoke') return '确认撤销';
  if (operation.value === 'renew') return '重新生成';
  return existingRecovery.value ? '重新生成恢复链接' : '生成恢复链接';
});
const filters: { id: AccessLinkFilter; label: string }[] = [
  { id: 'PENDING', label: '待使用' }, { id: 'USED', label: '已使用' }, { id: 'REVOKED', label: '已撤销' }, { id: 'ALL', label: '全部' },
];
const backdropEvents = useBackdropDismiss(close);

function close() { if (!locked.value) { if (operation.value) cancelOperation(); else emit('close'); } }
async function loadMembers(search: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({ search, offset: String(offset) });
  const members = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined, signal);
  return { members: members.map(member => ({ userId: member.id, nickname: member.nickname, avatar: member.avatar })), hasMore: members.length === 100 };
}
async function focusConfirmation() { await nextTick(); dialog.value?.focus({ preventScroll: true }); }
function selectMember(member: MemberOption) {
  if (selectedMember.value?.userId !== member.userId) note.value = `${member.nickname} 的恢复链接`;
  selectedMember.value = member; target.value = member.userId;
  error.value = ''; generatedForConfirmation.value = false; operation.value = 'recovery';
  void focusConfirmation();
}
function cancelOperation() { if (!locked.value) { operation.value = null; error.value = ''; } }
async function confirmOperation() {
  let done = false;
  if (operation.value === 'note' && selectedLink.value) done = await saveNote(selectedLink.value.id, editingNote.value);
  else if (operation.value === 'revoke' && selectedLink.value) done = await revoke(selectedLink.value.id);
  else {
    // 生成已成功但复制失败时，只重试复制，避免让刚发出的恢复链接失效。
    if (generatedForConfirmation.value) done = await copyLink();
    else {
      const created = operation.value === 'recovery' ? await generate('RECOVERY')
        : selectedLink.value && await generate(selectedLink.value.kind === 'RECOVERY' ? 'RECOVERY' : 'INVITE', selectedLink.value.id);
      generatedForConfirmation.value = !!created;
      done = !!created && !error.value;
    }
  }
  if (done) operation.value = null;
  else if (generatedForConfirmation.value && generatedUrl.value) { await nextTick(); linkInput.value?.select(); }
}
async function copy(id?: string) {
  const trigger = document.activeElement;
  const copied = await copyLink(id);
  await nextTick();
  if (!copied && generatedUrl.value) { linkInput.value?.focus(); linkInput.value?.select(); }
  else if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
}
function edit(link: AccessLinkRecord, action: 'note' | 'revoke' | 'renew') {
  selectedLink.value = link; editingNote.value = link.note; generatedForConfirmation.value = false;
  error.value = ''; operation.value = action; void focusConfirmation();
}
async function saveInvitationNote() {
  if (generatedRecord.value && await saveNote(generatedRecord.value.id, note.value)) emit('notice', '备注已保存。');
}
function changeFilter(value: AccessLinkFilter) { error.value = ''; filter.value = value; }
watch(generatedRecord, (record, previous) => {
  if (props.mode !== 'invite' || !record) return;
  const draft = invitationDraft.value;
  if (!previous && draft?.id === record.id && draft.note !== draft.savedNote) note.value = draft.note;
  else if (record.id !== previous?.id || note.value === previous?.note) note.value = record.note;
});
watch([note, generatedRecord], () => {
  if (props.mode === 'invite' && generatedRecord.value) invitationDraft.value = { id: generatedRecord.value.id, note: note.value, savedNote: generatedRecord.value.note };
});
watch(operation, async () => {
  const element = stage.value;
  if (!element) return;
  const from = parseFloat(getComputedStyle(element).height);
  animation?.cancel(); element.style.height = `${from}px`;
  const revision = ++motion;
  await nextTick();
  if (revision !== motion || !stage.value) return;
  const content = element.querySelector<HTMLElement>(operation.value ? '.access-confirm' : '.access-main');
  if (!content) { element.style.removeProperty('height'); return; }
  const to = content.offsetHeight;
  element.style.height = `${to}px`;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const style = getComputedStyle(element);
    const running = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: motionDurationMs(style.getPropertyValue('--motion-layout-duration')), easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = running;
    running.finished.then(() => { if (animation === running) element.style.removeProperty('height'); }, () => {});
  } else element.style.removeProperty('height');
  void focusConfirmation();
});
onScopeDispose(() => { motion++; animation?.cancel(); });
onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="member-access-dialog" role="dialog" aria-modal="true" :aria-label="operation ? confirmationTitle : title" tabindex="-1" @keydown="keepDialogFocus">
      <div ref="stage" class="access-stage">
      <div v-show="!operation" class="access-main">
      <header>
        <div class="access-heading"><h2>{{ title }}</h2><button v-if="mode !== 'links'" type="button" class="access-manage" :disabled="locked" @click="emit('manage')">链接管理<ArrowRight :size="16" /></button><button v-else-if="returnTo" type="button" class="access-manage" :disabled="locked" @click="emit('back')">{{ returnTo === 'invite' ? '返回邀请' : '返回恢复登录' }}<ArrowRight :size="16" /></button></div>
        <p v-if="mode === 'invite'">复制链接发给朋友，每条链接可邀请一人。</p>
        <p v-else-if="mode === 'recovery'">找到需要恢复登录的成员，核对后生成链接。</p>
        <p v-else>查看邀请与恢复链接，修改备注或撤销不再需要的链接。</p>
      </header>
      <div v-if="mode === 'recovery'" class="access-body">
        <MemberPicker v-model:search="memberSearch" v-model:scroll-position="memberScroll" :load="loadMembers" :disabled="locked || !recordsLoaded" label="搜索可恢复成员" @select="selectMember">
          <template #action-label="{ member }">{{ recoveryTargets.has(member.userId) ? '已生成' : '选择' }}</template>
        </MemberPicker>
        <InlineFeedback :message="recordsError" :pending="!recordsLoaded && refreshing ? '正在读取链接…' : ''" />
        <button v-if="recordsError" type="button" :disabled="locked || refreshing" @click="refresh">重试</button>
      </div>
      <div v-else-if="mode === 'invite'" class="access-body invite-body">
        <template v-if="generatedRecord">
          <label class="settings-field">邀请链接<input ref="linkInput" :value="generatedUrl" readonly aria-label="生成的链接" /></label>
          <small>{{ accessLinkStatus(generatedRecord, currentTime) }} · 到期：{{ new Date(generatedRecord.expiresAt).toLocaleString() }}</small>
          <form class="invitation-note" @submit.prevent="saveInvitationNote">
            <label class="settings-field" for="invitation-note"><span>备注 <small>选填，仅服主可见</small></span><input id="invitation-note" v-model="note" maxlength="100" :disabled="locked" placeholder="朋友的名字或用途" /></label>
            <button :disabled="locked || note.trim() === generatedRecord.note">保存备注</button>
          </form>
        </template>
        <InlineFeedback :message="error || recordsError" :pending="busy ? '正在生成链接…' : refreshing && !recordsLoaded ? '正在读取链接…' : ''" />
        <button v-if="recordsError || error && !generatedRecord" type="button" :disabled="locked || refreshing" @click="prepareInvitation">重试</button>
      </div>
      <div v-else class="access-body">
        <SegmentedControl :model-value="filter" :options="filters" :disabled="locked" tabs label="链接分类" id-prefix="access-filter" controls="access-records" @update:model-value="changeFilter" />
        <div id="access-records" class="access-records" role="tabpanel" :aria-labelledby="`access-filter-${filter}`" :aria-busy="refreshing">
          <p v-if="!links.length && !refreshing && !recordsError">暂无{{ filter === 'PENDING' ? '待使用的链接' : '记录' }}</p>
          <article v-for="link in links" :key="link.id" class="access-record" :data-link-id="link.id">
            <div class="access-record-heading"><strong>{{ link.note || (link.kind === 'RECOVERY' ? '恢复链接' : '邀请链接') }}</strong><small>{{ accessLinkStatus(link, currentTime) === '已完成' ? '已使用' : accessLinkStatus(link, currentTime) }}</small></div>
            <small>{{ link.kind === 'RECOVERY' ? '恢复登录' : '邀请加入' }} · {{ pending(link) ? '到期' : '创建' }}：{{ new Date(pending(link) ? link.expiresAt : link.createdAt).toLocaleString() }}</small>
            <small v-if="link.lastFailure" class="error">{{ link.lastFailure }}</small>
            <div v-if="!link.consumedAt" class="button-actions">
              <template v-if="pending(link)">
                <button type="button" :disabled="locked || refreshing" @click="copy(link.id)">复制链接</button>
                <button type="button" :disabled="locked || refreshing" @click="edit(link, 'note')">修改备注</button>
              </template>
              <button type="button" :disabled="locked || refreshing" @click="edit(link, 'renew')">重新生成</button>
              <button v-if="!link.revokedAt" type="button" :disabled="locked || refreshing" @click="edit(link, 'revoke')">撤销</button>
            </div>
          </article>
          <InlineFeedback :message="recordsError" :pending="refreshing && !links.length ? '正在读取链接…' : ''" />
          <button v-if="recordsError" type="button" :disabled="locked || refreshing" @click="refresh">重试</button>
        </div>
        <InlineFeedback :message="operation ? '' : error" />
        <label v-if="!operation && error && generatedUrl" class="settings-field">链接<input ref="linkInput" :value="generatedUrl" readonly aria-label="手动复制链接" /></label>
        <div v-if="offset || links.length === 100" class="access-pagination">
          <button type="button" :disabled="locked || refreshing || offset === 0" @click="page(-1)">上一页记录</button>
          <button type="button" :disabled="locked || refreshing || links.length < 100" @click="page(1)">下一页记录</button>
        </div>
      </div>
      <footer class="card-actions">
        <button type="button" :disabled="locked" @click="close">关闭</button>
        <div v-if="mode === 'invite' && generatedRecord" class="button-actions card-actions-end">
          <button type="button" :disabled="locked" @click="generate('INVITE')">生成新链接</button>
          <button type="button" class="confirm-button" :disabled="locked" @click="copy()">复制链接</button>
        </div>
      </footer>
      </div>
        <form v-if="operation" class="access-confirm" @submit.prevent="confirmOperation">
          <header><h2>{{ confirmationTitle }}</h2><p v-if="operation === 'recovery'">请核对成员信息，仅将恢复链接发给本人。</p></header>
          <div class="access-body">
            <template v-if="operation === 'recovery'">
              <MemberIdentity v-if="selectedMember" :member="selectedMember" :description="existingRecovery ? '已有待使用的恢复链接' : '尚未生成恢复链接'" />
              <p>{{ existingRecovery ? '重新生成后，之前的恢复链接将失效。' : '恢复链接 12 小时有效，请仅发给这位成员。' }}对方使用后，旧设备将退出登录。</p>
              <label class="settings-field" for="recovery-note"><span>备注 <small>选填，仅服主可见</small></span><input id="recovery-note" v-model="note" maxlength="100" :disabled="locked || generatedForConfirmation" /></label>
            </template>
            <template v-else-if="operation === 'note'">
              <label class="settings-field" for="access-note"><span>备注 <small>选填，仅服主可见</small></span><input id="access-note" v-model="editingNote" maxlength="100" :disabled="locked" placeholder="朋友的名字或用途" /></label>
            </template>
            <template v-else>
              <strong v-if="selectedLink?.note">{{ selectedLink.note }}</strong>
              <p>{{ operation === 'revoke' ? '撤销后，这条链接将立即失效。' : '重新生成后，旧链接将立即失效，新链接会复制到剪贴板。' }}</p>
            </template>
            <InlineFeedback :message="error" :pending="busy ? '正在处理…' : ''" />
            <label v-if="generatedForConfirmation && error && generatedUrl" class="settings-field">链接<input ref="linkInput" :value="generatedUrl" readonly aria-label="手动复制链接" /></label>
          </div>
          <div class="card-actions"><button type="button" :disabled="locked" @click="cancelOperation">返回</button><button class="confirm-button card-actions-end" :class="{ 'is-danger': operation === 'revoke' }" :disabled="locked">{{ confirmationAction }}</button></div>
        </form>
      </div>
    </section>
  </div>
</template>

<style scoped>
.member-access-dialog { width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 20px; }
.access-stage { overflow: hidden; }
.access-main, .access-confirm { display: flow-root; }
.access-confirm { animation: access-step-in var(--motion-layout-duration) var(--motion-ease); }
@keyframes access-step-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .access-confirm { animation: none; } }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
header p { margin: 4px 0 0; }
p, small { color: var(--muted); }
small { font-size: 12px; }
.access-heading, .access-record-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.access-manage { display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; border: 0; background: transparent; color: var(--muted); }
.access-manage:hover:not(:disabled) { background: transparent; color: var(--text); }
.access-body { display: grid; gap: 12px; margin: 20px 0; }
.access-body p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.access-body input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; }
.access-body input:focus { border-color: var(--subtle); }
.invite-body { min-height: 172px; align-content: start; }
.invitation-note { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; }
.invitation-note button { min-height: 40px; }
.access-records { height: min(360px, 45dvh); overflow-y: auto; scrollbar-gutter: stable; }
.access-record { display: grid; gap: 8px; padding: 16px 0; border-bottom: 1px solid var(--border-soft); }
.access-record:first-child { padding-top: 0; }
.access-record-heading strong { min-width: 0; overflow-wrap: anywhere; }
.access-record-heading small { flex-shrink: 0; }
.access-record .button-actions, .access-pagination { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 420px) { .member-access-dialog { padding: 20px; } .invitation-note { grid-template-columns: minmax(0, 1fr); } }
</style>

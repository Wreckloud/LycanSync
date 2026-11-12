<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { UserRound } from '@lucide/vue';
import InlineFeedback from './InlineFeedback.vue';
import ExpandSection from './ExpandSection.vue';
import { accessLinkStatus } from '../auth/accountAccess';
import { useMemberAccess, type MemberAccessMode } from '../settings/useMemberAccess';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ mode: MemberAccessMode }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const linkInput = ref<HTMLInputElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const showResult = ref(false);
const revokeId = ref('');
const { links, members, offset, memberOffset, search, membersError, loadingMembers, note, target, generatedUrl, generatedRecord,
  inviteError, recoveryError, linkError, recordsError, copyStatus, busy, refreshing, copying, locked, currentTime,
  refresh, loadMembers, generate, revoke, copyLink, page } = useMemberAccess(ref(true), props.mode);
const title = computed(() => showResult.value ? '新链接' : { invite: '邀请新朋友', recovery: '恢复成员登录', links: '链接管理' }[props.mode]);
const selectedMember = computed(() => members.value.find(member => member.id === target.value));
const backdropEvents = useBackdropDismiss(close);

function close() { if (!busy.value && !copying.value) emit('close'); }
async function confirmRevoke() {
  if (await revoke(revokeId.value)) revokeId.value = '';
}
async function copy() {
  const copied = await copyLink();
  await nextTick();
  if (!copied && linkError.value) {
    linkInput.value?.focus();
    linkInput.value?.select();
  } else if (dialog.value && !dialog.value.contains(document.activeElement)) {
    // 复制期间按钮会禁用，浏览器可能把焦点退回页面；完成后保留弹窗的键盘操作。
    linkInput.value?.focus({ preventScroll: true });
  }
}
async function backToRecords() {
  if (busy.value || copying.value) return;
  showResult.value = false;
  await nextTick();
  dialog.value?.focus();
}
watch(generatedUrl, async url => {
  if (!url) { showResult.value = false; return; }
  showResult.value = true;
  await nextTick();
  linkInput.value?.focus();
  linkInput.value?.select();
});
onMounted(() => { (searchInput.value ?? dialog.value)?.focus(); });
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="member-access-dialog" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header>
        <h2>{{ title }}</h2>
        <p v-if="showResult">{{ generatedRecord?.kind === 'RECOVERY' ? '恢复链接 12 小时有效，仅发给需要恢复登录的成员。' : '邀请链接 3 天有效，每位朋友使用一条。' }}</p>
        <p v-else-if="mode === 'invite'">生成一条链接，复制后发给新朋友。</p>
        <p v-else-if="mode === 'recovery'">找到需要恢复登录的成员，核对后生成链接。</p>
        <p v-else>查看使用状态，或撤销不再需要的链接。重新生成会使旧链接失效。</p>
      </header>
      <div v-if="showResult" class="access-body">
        <strong v-if="selectedMember">{{ selectedMember.nickname }}</strong>
        <p v-if="generatedRecord?.note" class="access-note">备注：{{ generatedRecord.note }}</p>
        <label class="settings-field" for="generated-access-link">{{ generatedRecord?.kind === 'RECOVERY' ? '恢复链接' : '邀请链接' }}
          <input id="generated-access-link" ref="linkInput" :value="generatedUrl" readonly aria-label="生成的链接" />
        </label>
        <p>请在关闭前复制，之后无法再次查看原链接。</p>
        <InlineFeedback :message="linkError" :status="copyStatus" />
      </div>
      <form v-else-if="mode !== 'links'" id="member-access-form" class="access-body" @submit.prevent="generate(mode === 'invite' ? 'INVITE' : 'RECOVERY')">
        <template v-if="mode === 'recovery'">
          <input ref="searchInput" v-model="search" type="search" maxlength="100" :disabled="busy" aria-label="搜索可恢复成员" placeholder="搜索昵称或成员 ID" />
          <div class="access-members" aria-label="可恢复成员" :aria-busy="loadingMembers">
            <div v-for="member in members" :key="member.id" class="access-member">
              <img v-if="member.avatar" :src="member.avatar" alt="" /><UserRound v-else :size="36" aria-hidden="true" />
              <div class="access-member-details"><strong>{{ member.nickname }}</strong><small>{{ member.id }}</small></div>
              <button type="button" :disabled="busy || loadingMembers || !!membersError" :aria-pressed="target === member.id" @click="target = member.id">{{ target === member.id ? '已选择' : '选择' }}</button>
            </div>
            <p v-if="!loadingMembers && !membersError && !members.length">{{ search.trim() ? '没有匹配的成员' : '暂无可恢复的成员' }}</p>
            <InlineFeedback :message="membersError" :pending="loadingMembers ? '正在查找成员…' : ''" />
            <button v-if="membersError" type="button" :disabled="busy || loadingMembers" @click="loadMembers">重新读取</button>
          </div>
          <div v-if="memberOffset || members.length === 100" class="access-pagination">
            <button type="button" :disabled="busy || loadingMembers || memberOffset === 0" @click="page(-1, true)">上一页成员</button>
            <button type="button" :disabled="busy || loadingMembers || members.length < 100" @click="page(1, true)">下一页成员</button>
          </div>
          <p v-if="selectedMember">为 {{ selectedMember.nickname }} 恢复登录。对方使用链接后，旧设备将退出登录。</p>
        </template>
        <label class="settings-field" for="invitation-note"><span>备注 <small>选填，仅服主可见</small></span>
          <input id="invitation-note" v-model="note" maxlength="100" :readonly="busy" placeholder="朋友的名字或用途" />
        </label>
        <InlineFeedback :message="mode === 'invite' ? inviteError : recoveryError" :pending="busy ? '正在生成链接…' : ''" />
      </form>
      <div v-else class="access-body">
        <div class="access-records">
          <p v-if="!links.length && !refreshing && !recordsError">暂无记录</p>
          <article v-for="link in links" :key="link.id" class="access-record">
            <div class="access-record-details">
              <strong>{{ link.kind === 'RECOVERY' ? '恢复成员登录' : '邀请新朋友' }} · {{ accessLinkStatus(link, currentTime) }}</strong>
              <span v-if="link.note">{{ link.note }}</span>
              <small v-if="link.targetId">成员 ID：{{ link.targetId }}</small>
              <small>到期：{{ new Date(link.expiresAt).toLocaleString() }}</small>
              <small v-if="link.resultUserId">已完成成员：{{ link.resultUserId }}</small>
              <small v-if="link.lastFailure">上次失败：{{ link.lastFailure }}（失败不会消耗链接）</small>
            </div>
            <div v-if="!link.consumedAt" class="button-actions">
              <button type="button" :disabled="locked" @click="generate(link.kind === 'RECOVERY' ? 'RECOVERY' : 'INVITE', link.id)">重新生成</button>
              <button type="button" :disabled="locked || !!link.revokedAt" @click="revokeId = link.id">撤销</button>
            </div>
            <ExpandSection :open="revokeId === link.id && !link.revokedAt && !link.consumedAt">
              <div class="access-revoke-confirm">
                <p>撤销后，这条链接将立即失效。</p>
                <div class="card-actions">
                  <button type="button" :disabled="busy" @click="revokeId = ''">取消</button>
                  <button type="button" class="confirm-button is-danger card-actions-end" :disabled="locked" @click="confirmRevoke">确认撤销</button>
                </div>
              </div>
            </ExpandSection>
          </article>
        </div>
        <InlineFeedback :message="recordsError" :pending="busy ? '正在处理…' : refreshing && !links.length ? '正在读取记录…' : ''" />
        <button v-if="recordsError" type="button" :disabled="locked" @click="refresh">重新读取</button>
        <div v-if="offset || links.length === 100" class="access-pagination">
          <button type="button" :disabled="locked || offset === 0" @click="page(-1)">上一页记录</button>
          <button type="button" :disabled="locked || links.length < 100" @click="page(1)">下一页记录</button>
        </div>
      </div>
      <footer class="card-actions">
        <button type="button" :disabled="busy || copying" @click="close">{{ showResult || mode === 'links' ? '关闭' : '取消' }}</button>
        <button v-if="showResult && mode === 'links'" type="button" :disabled="busy || copying" @click="backToRecords">返回记录</button>
        <button v-if="showResult" type="button" class="confirm-button card-actions-end" :disabled="copying" @click="copy">复制链接</button>
        <button v-else-if="mode !== 'links'" type="submit" form="member-access-form" class="confirm-button card-actions-end"
          :disabled="locked || mode === 'recovery' && (!target || loadingMembers || !!membersError)">生成{{ mode === 'invite' ? '邀请' : '恢复' }}链接</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.member-access-dialog { width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 20px; }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
header p { margin: 4px 0 0; }
p, small { color: var(--muted); }
small { font-size: 12px; }
.access-body { display: grid; gap: 12px; margin: 20px 0; }
.access-body p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.access-body input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; }
.access-body input:focus { border-color: var(--subtle); }
.access-members, .access-records { max-height: 300px; overflow-y: auto; }
.access-member { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 5px 0; }
.access-member img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
.access-member > svg, .access-member button { flex-shrink: 0; }
.access-member-details { display: grid; gap: 2px; min-width: 0; flex: 1; overflow-wrap: anywhere; }
.access-member-details strong { font-weight: 500; }
.access-member button { min-width: 64px; }
.access-member button[aria-pressed="true"] { border-color: var(--accent); }
.access-record { display: grid; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border-soft); }
.access-record-details { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.access-revoke-confirm { padding-top: 8px; }
.access-record .button-actions, .access-pagination { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 420px) { .member-access-dialog { padding: 20px; } }
</style>

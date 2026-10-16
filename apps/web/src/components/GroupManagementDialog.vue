<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { Crown, UserRound } from '@lucide/vue';
import InlineFeedback from './InlineFeedback.vue';
import { addGroupMember, dissolveGroup, findGroup, findGroupCandidates, getGroupInviteCode,
  removeGroupMember, transferGroupOwner, type GroupCandidate, type GroupDetail } from '../group/groupApi';

const props = defineProps<{ group: GroupDetail; userId: string; mode: 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve' }>();
const emit = defineEmits<{ close: []; updated: [group: GroupDetail]; removed: [groupId: string] }>();
const dialog = ref<HTMLElement | null>(null);
const search = ref('');
const offset = ref(0);
const candidates = ref<GroupCandidate[]>([]);
const hasMore = ref(false);
const code = ref('');
const error = ref('');
const candidateError = ref('');
const status = ref('');
const busy = ref(false);
const loading = ref(false);
const confirmation = ref<{ userId: string; nickname: string } | null>(null);
const dissolveName = ref('');
const dissolveNameMatches = computed(() => dissolveName.value === props.group.name);
const title = computed(() => ({ invite: '邀请成员', members: '管理成员', transfer: '转让群主', leave: '退出群聊', dissolve: '解散群聊' })[props.mode]);
const allMembers = computed(() => props.group.members.filter((member) => member.nickname.toLowerCase().includes(search.value.toLowerCase())));
const members = computed(() => allMembers.value.slice(offset.value, offset.value + 20));
const moreMembers = computed(() => offset.value + 20 < allMembers.value.length);
const confirming = computed(() => !!confirmation.value || props.mode === 'leave' || props.mode === 'dissolve');
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let request: AbortController | null = null;
let disposed = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function close() {
  if (busy.value) return;
  if (confirmation.value) { confirmation.value = null; error.value = ''; }
  else emit('close');
}

async function loadCandidates() {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  candidateError.value = '';
  try {
    const result = await findGroupCandidates(props.group.id, search.value, offset.value, current.signal);
    if (!current.signal.aborted) { candidates.value = result.members; hasMore.value = result.hasMore; }
  } catch (exception) {
    if (!current.signal.aborted) candidateError.value = exception instanceof Error ? exception.message : '无法读取服务器成员，请重试。';
  } finally { if (!current.signal.aborted) loading.value = false; }
}

async function action(operation: () => Promise<void>) {
  if (busy.value || disposed) return;
  busy.value = true;
  error.value = ''; status.value = '';
  try { await operation(); }
  catch (exception) { if (!disposed) error.value = exception instanceof Error ? exception.message : '操作失败，请重试。'; }
  finally { if (!disposed) busy.value = false; }
}

async function refreshCode() {
  await action(async () => { const result = await getGroupInviteCode(props.group.id, true); if (!disposed) code.value = result.code; });
}

async function addMember(member: GroupCandidate) {
  clearTimeout(searchTimer);
  request?.abort();
  loading.value = false;
  await action(async () => {
    const result = await addGroupMember(props.group.id, member.userId);
    if (disposed) return;
    emit('updated', result);
    candidates.value = candidates.value.map((candidate) => candidate.userId === member.userId ? { ...candidate, joined: true } : candidate);
  });
}

async function copyCode() {
  await action(async () => {
    if (window.lycanDesktop) await window.lycanDesktop.copyText(code.value);
    else await navigator.clipboard.writeText(code.value);
    if (!disposed) {
      status.value = '已复制邀请码';
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.value = ''; }, 3000);
    }
  });
}

async function confirm() {
  if (props.mode === 'dissolve' && !dissolveNameMatches.value) return;
  await action(async () => {
    if (props.mode === 'dissolve') {
      await dissolveGroup(props.group.id);
      if (!disposed) emit('removed', props.group.id);
    } else if (props.mode === 'leave') {
      await removeGroupMember(props.group.id, props.userId);
      if (!disposed) emit('removed', props.group.id);
    } else if (confirmation.value) {
      const target = confirmation.value;
      const result = props.mode === 'transfer'
        ? await transferGroupOwner(props.group.id, target.userId)
        : await removeGroupMember(props.group.id, target.userId).then(() => findGroup(props.group.id));
      if (disposed) return;
      emit('updated', result);
      confirmation.value = null;
      if (props.mode === 'transfer') emit('close');
    }
  });
}

watch(search, () => {
  offset.value = 0;
  clearTimeout(searchTimer);
  if (props.mode === 'invite') {
    // 输入变化即撤销旧查询，防抖期间也不允许按旧搜索结果添加成员。
    request?.abort();
    loading.value = true;
    candidateError.value = '';
    searchTimer = setTimeout(() => void loadCandidates(), 250);
  }
});
function page(change: number) {
  clearTimeout(searchTimer);
  offset.value = Math.max(0, offset.value + change * 20);
  if (props.mode === 'invite') void loadCandidates();
}
watch(() => props.group.role, (role) => { if (role !== 'OWNER' && props.mode !== 'leave') emit('close'); });

function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
  const first = controls[0]; const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

onMounted(() => {
  dialog.value?.focus();
  if (props.mode === 'invite') {
    void loadCandidates();
    void action(async () => { const result = await getGroupInviteCode(props.group.id); if (!disposed) code.value = result.code; });
    refreshTimer = setInterval(() => { if (!busy.value && !loading.value && document.visibilityState !== 'hidden') void loadCandidates(); }, 15000);
  }
});
onScopeDispose(() => {
  disposed = true; request?.abort(); clearTimeout(searchTimer); clearTimeout(statusTimer); clearInterval(refreshTimer);
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
});
</script>

<template>
  <div class="dialog-backdrop" @keydown.esc.stop="close">
    <section ref="dialog" class="group-management" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepFocus">
      <header><h2>{{ title }}</h2><p>{{ group.name }}</p></header>
      <div v-if="confirming" class="management-confirm">
        <template v-if="mode === 'dissolve'">
          <strong>解散“{{ group.name }}”？</strong><p>群组、聊天记录和附件将被删除，当前语音、共享和远控会结束。此操作无法撤销。</p>
          <form id="group-dissolve-form" class="management-dissolve" @submit.prevent="confirm">
            <label for="group-dissolve-name">输入群聊名称以确认</label>
            <input id="group-dissolve-name" v-model="dissolveName" :disabled="busy" maxlength="32"
              autocomplete="off" :spellcheck="false" placeholder="输入完整群聊名称" />
          </form>
        </template>
        <template v-else-if="mode === 'leave'"><strong>退出“{{ group.name }}”？</strong><p>退出后无法访问本群，你的语音、共享和远控会结束。需要群主重新添加，或使用当前邀请码加入。</p></template>
        <template v-else-if="mode === 'transfer'"><strong>将群主转让给 {{ confirmation?.nickname }}？</strong><p>对方将拥有资料、成员和邀请码的管理权限，你将成为普通成员。当前邀请码会更换。</p></template>
        <template v-else><strong>移出 {{ confirmation?.nickname }}？</strong><p>对方将失去群访问权限，并断开语音、共享和远控；邀请码会更换，其他成员不受影响。</p></template>
      </div>
      <div v-else class="management-body">
        <input v-model="search" :disabled="busy" maxlength="32" :aria-label="mode === 'invite' ? '搜索服务器成员' : '搜索群成员'" placeholder="搜索成员" />
        <div class="management-members">
          <template v-if="mode === 'invite'">
            <div v-for="member in candidates" :key="member.userId" class="management-member">
              <img v-if="member.avatar" :src="member.avatar" alt="" /><UserRound v-else :size="36" />
              <strong><span>{{ member.nickname }}</span></strong><button type="button" :disabled="busy || loading || !!candidateError || member.joined" @click="addMember(member)">{{ member.joined ? '已加入' : '添加' }}</button>
            </div>
          </template>
          <template v-else>
            <div v-for="member in members" :key="member.userId" class="management-member">
              <img v-if="member.avatar" :src="member.avatar" alt="" /><UserRound v-else :size="36" />
              <strong><span>{{ member.nickname }}</span><Crown v-if="member.role === 'OWNER'" :size="13" role="img" aria-label="群主" /></strong>
              <button type="button" :disabled="busy || member.role === 'OWNER'" @click="confirmation = member; error = ''">{{ mode === 'transfer' ? '选择' : '移出' }}</button>
            </div>
          </template>
          <p v-if="!loading && (mode === 'invite' ? candidates.length === 0 : members.length === 0)" class="management-empty">没有匹配的成员</p>
        </div>
        <div class="management-pages"><button type="button" :disabled="busy || loading || offset === 0" @click="page(-1)">上一页</button>
          <span>第 {{ offset / 20 + 1 }} 页</span><button type="button" :disabled="busy || loading || !(mode === 'invite' ? hasMore : moreMembers)" @click="page(1)">下一页</button></div>
        <div v-if="mode === 'invite'" class="management-code"><label for="group-invite-code">群组邀请码</label>
          <div><input id="group-invite-code" :value="code" readonly /><button type="button" :disabled="busy || !code" @click="copyCode">复制</button></div>
          <small>服务器成员持有此码即可入群。<button type="button" :disabled="busy" @click="refreshCode">更换邀请码</button></small>
        </div>
      </div>
      <footer class="card-actions" :class="{ 'card-actions-no-primary': !confirming }">
        <button type="button" class="settings-button" :disabled="busy" @click="close">取消</button>
        <InlineFeedback class="card-feedback" :message="error || candidateError" :status="busy ? '正在处理…' : loading ? '正在读取…' : status" />
        <button v-if="mode === 'dissolve'" type="submit" form="group-dissolve-form" class="confirm-button is-danger card-actions-end" :disabled="busy || !dissolveNameMatches">确认解散</button>
        <button v-else-if="confirming" type="button" class="confirm-button card-actions-end" :class="{ 'is-danger': mode !== 'transfer' }" :disabled="busy" @click="confirm">{{ mode === 'transfer' ? '确认转让' : mode === 'leave' ? '退出群聊' : '移出成员' }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.group-management { width: min(480px, 100%); max-height: calc(100dvh - 36px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.management-body { display: grid; gap: 12px; margin: 20px 0; }
.management-body > input { width: 100%; }
.management-body input, .management-dissolve input { height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.management-body input:focus, .management-dissolve input:focus { border-color: var(--subtle); }
.management-dissolve { display: grid; gap: 6px; margin-top: 16px; }
.management-dissolve input { min-width: 0; width: 100%; }
.management-members { height: 260px; overflow-y: auto; }
.management-member { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 5px 0; }
.management-member img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
.management-member > svg { flex-shrink: 0; }
.management-member strong { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font-weight: 500; }
.management-member strong span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.management-member strong svg { flex-shrink: 0; color: var(--warning); }
.management-member button { flex-shrink: 0; min-width: 64px; }
.management-pages { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.management-pages span { color: var(--muted); font-size: 12px; }
.management-code { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid var(--border-soft); }
.management-code > div { display: flex; gap: 8px; }
.management-code input { flex: 1; min-width: 0; font-family: monospace; }
.management-code small, .management-empty { color: var(--muted); font-size: 13px; }
.management-code small button { padding: 0 0 0 6px; border: 0; background: transparent; font-size: 12px; color: var(--muted); }
.management-confirm { margin: 24px 0; }
.management-confirm p { margin: 8px 0 0; color: var(--muted); }
@media (max-width: 420px) { .group-management { padding: 20px; } }
</style>

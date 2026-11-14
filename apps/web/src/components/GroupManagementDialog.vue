<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { ArrowRight } from '@lucide/vue';
import InlineFeedback from './InlineFeedback.vue';
import MemberPicker, { type MemberOption } from './MemberPicker.vue';
import { motionDurationMs } from '../styles/motion';
import { addGroupMember, dissolveGroup, findGroup, findGroupCandidates, getGroupInviteCode,
  removeGroupMember, transferGroupOwner, type GroupDetail } from '../group/groupApi';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ group: GroupDetail; userId: string; mode: 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve' | 'resolve'; remaining?: number; pending?: boolean }>();
const disposition = ref<'transfer' | 'dissolve' | null>(null);
const mode = computed(() => props.mode === 'resolve' ? disposition.value ?? 'resolve' : props.mode);
const emit = defineEmits<{ close: []; updated: [group: GroupDetail]; removed: [groupId: string] }>();
const dialog = ref<HTMLElement | null>(null);
const search = ref('');
const code = ref('');
const error = ref('');
const status = ref('');
const busy = ref(false);
const backdropEvents = useBackdropDismiss(close);
const confirmation = ref<{ userId: string; nickname: string } | null>(null);
const dissolveName = ref('');
const dissolveNameMatches = computed(() => dissolveName.value === props.group.name);
const title = computed(() => ({ invite: '邀请成员', members: '管理成员', transfer: '转让群主', leave: '退出群聊', dissolve: '解散群聊', resolve: '处理群组' })[mode.value]);
const confirming = computed(() => mode.value !== 'resolve' && (!!confirmation.value || mode.value === 'leave' || mode.value === 'dissolve'));
const transferName = ref('');
const transferNameMatches = computed(() => !!confirmation.value && transferName.value === confirmation.value.nickname);
const stage = ref<HTMLElement | null>(null);
const pageKey = computed(() => `${mode.value}-${confirming.value}`);
let animation: Animation | undefined;
let motionGeneration = 0;
let disposed = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

async function chooseDisposition(next: 'transfer' | 'dissolve') {
  if (busy.value) return;
  disposition.value = next;
  error.value = '';
  await nextTick();
  dialog.value?.focus();
}

function close() {
  if (busy.value || props.pending) return;
  if (confirmation.value && mode.value !== 'dissolve') { confirmation.value = null; transferName.value = ''; error.value = ''; }
  else emit('close');
}

function loadCandidates(search: string, offset: number, signal: AbortSignal) {
  return findGroupCandidates(props.group.id, search, offset, signal);
}
function selectMember(member: MemberOption) {
  if (confirmation.value?.userId !== member.userId) transferName.value = '';
  confirmation.value = member; error.value = '';
}

async function action(operation: () => Promise<void>) {
  if (busy.value || disposed) return;
  busy.value = true;
  error.value = ''; status.value = '';
  try { await operation(); }
  catch (exception) { if (!disposed) error.value = exception instanceof Error ? exception.message : '操作失败。'; }
  finally { if (!disposed) busy.value = false; }
}

async function refreshCode() {
  await action(async () => { const result = await getGroupInviteCode(props.group.id, true); if (!disposed) code.value = result.code; });
}

async function addMember(member: MemberOption) {
  await action(async () => {
    const result = await addGroupMember(props.group.id, member.userId);
    if (disposed) return;
    emit('updated', result);
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
  if (mode.value === 'dissolve' && !dissolveNameMatches.value) return;
  if (mode.value === 'transfer' && !transferNameMatches.value) return;
  await action(async () => {
    if (mode.value === 'dissolve') {
      await dissolveGroup(props.group.id);
      if (!disposed) emit('removed', props.group.id);
    } else if (mode.value === 'leave') {
      await removeGroupMember(props.group.id, props.userId);
      if (!disposed) emit('removed', props.group.id);
    } else if (confirmation.value) {
      const target = confirmation.value;
      const result = mode.value === 'transfer'
        ? await transferGroupOwner(props.group.id, target.userId)
        : await removeGroupMember(props.group.id, target.userId).then(() => findGroup(props.group.id));
      if (disposed) return;
      emit('updated', result);
      if (props.mode !== 'resolve') confirmation.value = null;
      if (mode.value === 'transfer' && props.mode !== 'resolve') emit('close');
    }
  });
}

function retirePage(element: Element) {
  const page = element as HTMLElement;
  page.inert = true;
  page.setAttribute('aria-hidden', 'true');
  page.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
}
watch(pageKey, async () => {
  const element = stage.value;
  if (!element) return;
  const from = element.getBoundingClientRect().height;
  animation?.cancel();
  element.style.height = `${from}px`;
  const generation = ++motionGeneration;
  await nextTick();
  if (disposed || generation !== motionGeneration) return;
  const page = element.querySelector<HTMLElement>('.management-page:not([inert])');
  if (!page) { element.style.removeProperty('height'); return; }
  const to = page.getBoundingClientRect().height;
  const style = getComputedStyle(element);
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof element.animate === 'function') {
    element.style.height = `${to}px`;
    const current = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: motionDurationMs(style.getPropertyValue('--motion-layout-duration')), easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = current;
    current.finished.then(() => { if (animation === current) element.style.removeProperty('height'); }, () => {});
  } else element.style.removeProperty('height');
  page.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
});
watch(() => props.group.role, (role) => { if (role !== 'OWNER' && mode.value !== 'leave') emit('close'); });


onMounted(() => {
  dialog.value?.focus();
  if (mode.value === 'invite') {
    void action(async () => { const result = await getGroupInviteCode(props.group.id); if (!disposed) code.value = result.code; });
  }
});
onScopeDispose(() => {
  disposed = true; motionGeneration++; animation?.cancel(); clearTimeout(statusTimer);
});
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="group-management" :inert="pending" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header class="management-header"><div><h2>{{ title }}</h2><p>{{ group.name }}<span v-if="remaining && remaining > 1"> · 还有 {{ remaining - 1 }} 个群聊待处理</span></p></div>
        <button v-if="props.mode === 'resolve' && mode !== 'resolve'" type="button" class="card-header-action" :disabled="busy"
          @click="chooseDisposition(mode === 'transfer' ? 'dissolve' : 'transfer')">{{ mode === 'transfer' ? '解散群聊' : '转让群主' }}<ArrowRight :size="16" aria-hidden="true" /></button>
      </header>
      <div ref="stage" class="management-stage">
      <Transition name="entry-mode" @before-leave="retirePage">
      <div :key="pageKey" class="management-page">
      <div v-if="mode === 'resolve'" class="management-body">
        <p>将群组交给另一位成员，或解散群组。</p>
        <button type="button" @click="chooseDisposition('transfer')">转让群主</button>
        <button type="button" @click="chooseDisposition('dissolve')">解散群聊</button>
      </div>
      <div v-else-if="confirming" class="management-confirm">
        <template v-if="mode === 'dissolve'">
          <strong class="confirmation-copy">解散“{{ group.name }}”？</strong><p>群组、聊天记录和附件将被删除，当前语音、共享和远控会结束。此操作无法撤销。</p>
          <form id="group-dissolve-form" class="management-dissolve" @submit.prevent="confirm">
            <label for="group-dissolve-name">输入群聊名称以确认</label>
            <input id="group-dissolve-name" v-model="dissolveName" :disabled="busy" maxlength="32"
              autocomplete="off" :spellcheck="false" placeholder="输入完整群聊名称" />
          </form>
        </template>
        <template v-else-if="mode === 'leave'"><strong>退出“{{ group.name }}”？</strong><p>退出后将结束你在本群的语音、共享和远控。再次加入需要群主添加，或使用当前邀请码。</p></template>
        <template v-else-if="mode === 'transfer'">
          <strong class="confirmation-copy">将群主转让给 <span>{{ confirmation?.nickname }}</span>？</strong><p>对方将拥有资料、成员和邀请码的管理权限，你将成为普通成员。当前邀请码会更换。</p>
          <form id="group-transfer-form" class="management-dissolve" @submit.prevent="confirm">
            <label for="group-transfer-name">输入对方昵称以确认</label>
            <input id="group-transfer-name" v-model="transferName" :disabled="busy" maxlength="32" autocomplete="off" :spellcheck="false" placeholder="输入完整昵称" />
          </form>
        </template>
        <template v-else><strong>移出 {{ confirmation?.nickname }}？</strong><p>对方将失去群访问权限，并断开语音、共享和远控；邀请码会更换，其他成员不受影响。</p></template>
      </div>
      <div v-else class="management-body">
        <MemberPicker v-if="mode === 'invite'" v-model:search="search" :load="loadCandidates" :disabled="busy" action="添加" label="搜索服务器成员"
          :joined-ids="group.members.map(member => member.userId)" @select="addMember" />
        <MemberPicker v-else v-model:search="search" :members="group.members" :disabled="busy" :action="mode === 'transfer' ? '选择' : '移出'" @select="selectMember" />
        <div v-if="mode === 'invite'" class="management-code"><label for="group-invite-code">群组邀请码</label>
          <div><input id="group-invite-code" :value="code" readonly /><button type="button" :disabled="busy || !code" @click="copyCode">复制</button></div>
          <small>服务器成员持有此码即可入群。<button type="button" :disabled="busy" @click="refreshCode">更换邀请码</button></small>
        </div>
      </div>
      </div>
      </Transition>
      </div>
      <footer class="card-actions" :class="{ 'card-actions-no-primary': !confirming }">
        <button type="button" class="settings-button" :disabled="busy" @click="close">取消</button>
        <InlineFeedback class="card-feedback" :message="error" :pending="busy ? '正在处理…' : ''" :status="busy ? '' : status" />
        <button v-if="mode === 'dissolve'" type="submit" form="group-dissolve-form" class="confirm-button is-danger card-actions-end" :disabled="busy || !dissolveNameMatches">确认解散</button>
        <button v-else-if="mode === 'transfer' && confirming" type="submit" form="group-transfer-form" class="confirm-button card-actions-end" :disabled="busy || !transferNameMatches">确认转让</button>
        <button v-else-if="confirming" type="button" class="confirm-button is-danger card-actions-end" :disabled="busy" @click="confirm">{{ mode === 'leave' ? '退出群聊' : '移出成员' }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.group-management { width: min(480px, 100%); max-height: calc(100dvh - 36px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
.management-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.management-body { display: grid; gap: 12px; margin: 20px 0; }
.management-body > p { margin: 0; color: var(--muted); }
.management-body input, .management-dissolve input { height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.management-body input:focus, .management-dissolve input:focus { border-color: var(--subtle); }
.management-dissolve { display: grid; gap: 6px; margin-top: 16px; }
.management-dissolve input { min-width: 0; width: 100%; }
.management-code { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid var(--border-soft); }
.management-code > div { display: flex; gap: 8px; }
.management-code input { flex: 1; min-width: 0; font-family: monospace; }
.management-code small { color: var(--muted); font-size: 13px; }
.management-code small button { padding: 0 0 0 6px; border: 0; background: transparent; font-size: 12px; color: var(--muted); }
.management-stage { position: relative; overflow: clip; }
.management-page { display: flow-root; min-width: 0; }
.management-page.entry-mode-leave-active { position: absolute; inset: 0 0 auto; }
.confirmation-copy { user-select: text; cursor: text; }
.management-confirm { margin: 24px 0; }
.management-confirm p { margin: 8px 0 0; color: var(--muted); }
@media (max-width: 420px) { .group-management { padding: 20px; } }
</style>

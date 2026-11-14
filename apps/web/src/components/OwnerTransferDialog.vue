<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import PasswordField from './PasswordField.vue';
import InlineFeedback from './InlineFeedback.vue';
import MemberPicker, { type MemberOption } from './MemberPicker.vue';
import MemberIdentity from './MemberIdentity.vue';
import { keepDialogFocus } from './dialogFocus';
import { useBackdropDismiss } from './useBackdropDismiss';
import { motionDurationMs } from '../styles/motion';

export interface PendingOwnerTransfer extends MemberOption { expiresAt: string }
const props = defineProps<{ initialOffer: PendingOwnerTransfer | null; disabled?: boolean; returning?: boolean }>();
const emit = defineEmits<{ close: []; changed: []; notice: [message: string] }>();
const offer = ref(props.initialOffer);
const step = ref<'password' | 'members' | 'confirm' | 'status'>(offer.value ? 'status' : 'password');
const password = ref('');
const selected = ref<MemberOption | null>(null);
const search = ref('');
const error = ref('');
const ended = ref('');
const administrator = ref(true);
const busy = ref(false);
const reading = ref(false);
const now = ref(Date.now());
const dialog = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const locked = computed(() => busy.value || !!props.disabled);
const expired = computed(() => !!offer.value && Date.parse(offer.value.expiresAt) <= now.value);
const title = computed(() => ({ password: '验证服主恢复密码', members: '选择接任成员', confirm: '确认转让服主', status: '服主转让' })[step.value]);
const controller = new AbortController();
const backdropEvents = useBackdropDismiss(close);
let timer: ReturnType<typeof setTimeout> | undefined;
let animation: Animation | undefined;
let motion = 0;
function close() {
  if (locked.value) return;
  if (step.value === 'confirm') { step.value = 'members'; error.value = ''; }
  else if (step.value === 'members') { step.value = 'password'; error.value = ''; }
  else emit('close');
}
function current() { return !controller.signal.aborted; }
function signal() { return AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]); }
async function verifyPassword() {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try {
    await authRequest('account/transfer/verify', 'POST', { password: password.value }, signal());
    if (current()) step.value = 'members';
  } catch (reason) { if (current()) error.value = reason instanceof Error ? reason.message : '无法验证恢复密码，请重试。'; }
  finally { if (current()) busy.value = false; }
}
async function loadMembers(search: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({ search, offset: String(offset) });
  const members = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined, signal);
  return { members: members.map(member => ({ userId: member.id, nickname: member.nickname, avatar: member.avatar })), hasMore: members.length === 100 };
}
function select(member: MemberOption) { selected.value = member; step.value = 'confirm'; error.value = ''; }
function restart() { password.value = ''; selected.value = null; error.value = ''; ended.value = ''; step.value = 'password'; }
async function submit() {
  if (locked.value || !selected.value) return;
  busy.value = true; error.value = '';
  try {
    await authRequest('account/transfer', 'POST', { targetId: selected.value.userId, password: password.value }, signal());
    if (!current()) return;
    password.value = ''; offer.value = null; step.value = 'status';
    emit('notice', '转让已发起，等待对方接受。'); emit('changed');
    await refreshStatus();
  } catch (reason) { if (current()) error.value = reason instanceof Error ? reason.message : '无法发起转让，请重试。'; }
  finally { if (current()) busy.value = false; }
}
async function cancelTransfer() {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try {
    await authRequest('account/transfer', 'DELETE', undefined, signal());
    if (!current()) return;
    offer.value = null; ended.value = '转让已撤回，你仍是服主。';
    emit('notice', '转让已撤回。'); emit('changed'); clearTimeout(timer);
  } catch (reason) { if (current()) error.value = reason instanceof Error ? reason.message : '无法撤回转让，请重试。'; }
  finally { if (current()) busy.value = false; }
}
function schedule() {
  clearTimeout(timer);
  if (current() && step.value === 'status' && !ended.value && !expired.value && document.visibilityState === 'visible') {
    timer = setTimeout(() => { if (locked.value) schedule(); else void refreshStatus(); }, 5_000);
  }
}
async function refreshStatus() {
  if (!current() || reading.value) return;
  reading.value = true;
  try {
    const status = await authRequest<{ administrator: boolean; outgoingTransfer: PendingOwnerTransfer | null }>('account', 'GET', undefined, signal());
    if (!current()) return;
    now.value = Date.now();
    error.value = '';
    administrator.value = status.administrator;
    if (!status.administrator) {
      ended.value = '权限已交接，你已成为普通成员。'; offer.value = null;
      emit('notice', ended.value); emit('changed'); window.dispatchEvent(new Event('lycan:account-updated'));
    } else {
      offer.value = status.outgoingTransfer;
      if (!offer.value) ended.value = '当前没有待接受的转让。';
    }
  } catch (reason) { if (current()) error.value = reason instanceof Error ? reason.message : '无法读取转让状态，请重试。'; }
  finally { if (current()) { reading.value = false; schedule(); } }
}
function visibilityChanged() { if (document.visibilityState === 'visible' && step.value === 'status' && !locked.value) void refreshStatus(); else clearTimeout(timer); }
function retire(element: Element) { (element as HTMLElement).inert = true; element.setAttribute('aria-hidden', 'true'); }
watch(step, async () => {
  clearTimeout(timer);
  const element = stage.value;
  if (!element) return;
  const from = element.getBoundingClientRect().height;
  animation?.cancel(); element.style.height = `${from}px`;
  const revision = ++motion;
  await nextTick();
  if (!current() || revision !== motion) return;
  const page = element.querySelector<HTMLElement>('.owner-transfer-page:not([inert])');
  if (!page) { element.style.removeProperty('height'); return; }
  const to = page.getBoundingClientRect().height;
  element.style.height = `${to}px`;
  const style = getComputedStyle(element);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const running = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: motionDurationMs(style.getPropertyValue('--motion-layout-duration')), easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = running;
    running.finished.then(() => { if (animation === running) element.style.removeProperty('height'); }, () => {});
  } else element.style.removeProperty('height');
  dialog.value?.focus({ preventScroll: true });
  schedule();
});
onMounted(() => { dialog.value?.focus(); schedule(); document.addEventListener('visibilitychange', visibilityChanged); });
onScopeDispose(() => { controller.abort(); clearTimeout(timer); animation?.cancel(); password.value = ''; document.removeEventListener('visibilitychange', visibilityChanged); });
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <section ref="dialog" class="owner-transfer-dialog" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keepDialogFocus">
      <header class="access-heading"><h2>{{ title }}</h2></header>
      <div ref="stage" class="owner-transfer-stage">
        <Transition name="entry-page" @before-leave="retire">
          <div :key="step" class="owner-transfer-page">
            <form v-if="step === 'password'" @submit.prevent="verifyPassword">
              <p>请输入当前服主恢复密码，再选择接任成员。</p>
              <PasswordField id="owner-transfer-password" v-model="password" label="服主恢复密码" :disabled="locked" required />
              <InlineFeedback :message="error" :pending="busy ? '正在验证…' : ''" />
              <div class="card-actions"><button type="button" :disabled="locked" @click="close">{{ returning ? '返回' : '关闭' }}</button><button class="confirm-button card-actions-end" :disabled="locked">下一步</button></div>
            </form>
            <template v-else-if="step === 'members'">
              <p>选择一位成员接任服主，下一步核对交接信息。</p>
              <MemberPicker v-model:search="search" :load="loadMembers" :selected="selected?.userId" :disabled="locked" label="搜索服务器成员" @select="select" />
              <div class="card-actions"><button type="button" :disabled="locked" @click="close">返回</button></div>
            </template>
            <form v-else-if="step === 'confirm'" @submit.prevent="submit">
              <p>确认将服务器的管理权限转让给这位成员？</p>
              <MemberIdentity v-if="selected" :member="selected" description="接受转让后成为服主" />
              <p>对方需在 24 小时内接受并设置自己的恢复密码，也可以拒绝。超时后转让自动失效。</p>
              <p>对方接受前，你仍是服主，可随时在“服主管理 → 转让服主”查看或撤回。</p>
              <p>对方接受后，权限交接即完成，你将成为普通成员，无法撤回。原服主恢复密码及未使用的账号邀请、恢复链接将失效。</p>
              <InlineFeedback :message="error" :pending="busy ? '正在发起转让…' : ''" />
              <button v-if="error" type="button" :disabled="locked" @click="step = 'password'; password = ''; error = ''">重新验证密码</button>
              <div class="card-actions"><button type="button" :disabled="locked" @click="close">返回</button><button class="confirm-button card-actions-end" :disabled="locked">发起转让</button></div>
            </form>
            <template v-else>
              <p>{{ ended || (expired ? '转让已过期，你仍是服主。' : '正在等待对方接受，完成前你仍是服主。') }}</p>
              <MemberIdentity v-if="offer" :member="offer" :description="expired ? '未在有效期内接受' : '等待接受转让'" />
              <p v-if="offer">{{ expired ? '已于' : '有效期至' }} {{ new Date(offer.expiresAt).toLocaleString() }}{{ expired ? '过期。' : '。对方接受前可撤回；对方也可以拒绝。' }}</p>
              <InlineFeedback :message="error" :pending="reading && !offer && !ended ? '正在读取转让状态…' : ''" />
              <button v-if="error" type="button" :disabled="locked || reading" @click="error = ''; refreshStatus()">重试</button>
              <div class="card-actions"><button type="button" :disabled="locked" @click="close">{{ returning ? '返回' : '关闭' }}</button><button v-if="offer && !expired" type="button" class="card-actions-end" :disabled="locked || reading" @click="cancelTransfer">撤回转让</button><button v-else-if="administrator && (expired || ended)" type="button" class="card-actions-end" :disabled="locked || reading" @click="restart">重新发起转让</button></div>
            </template>
          </div>
        </Transition>
      </div>
    </section>
  </div>
</template>

<style scoped>
.owner-transfer-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.access-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
h2 { margin: 0; font-size: 22px; line-height: 32px; }
p { margin: 0; font-size: 13px; line-height: 20px; color: var(--muted); }
.owner-transfer-stage { position: relative; overflow: hidden; }
.owner-transfer-page, .owner-transfer-page form { display: grid; gap: 12px; min-width: 0; }
.owner-transfer-page.entry-page-leave-active { position: absolute; inset: 0; }
@media (max-width: 420px) { .owner-transfer-dialog { padding: 20px; } }
</style>

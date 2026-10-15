<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { redemptionKey, type AccessOffer, type AccessPreview } from '../auth/accountAccess';
const props = defineProps<{ offer: AccessOffer; currentUser: AuthUser | null; currentServer: string }>();
const emit = defineEmits<{ cancel: []; joined: [result: { sessionToken?: string; user: AuthUser }, kind: string] }>();
const preview = ref<AccessPreview | null>(null);
const error = ref('');
const busy = ref(false);
const canRetryRedemption = ref(false);
const heading = ref<HTMLElement | null>(null);
const title = computed(() => {
  const server = preview.value?.serverName ?? 'LycanSync';
  if (props.currentUser) return server;
  if (preview.value?.kind === 'ACTIVATE') return `激活 ${server}`;
  if (preview.value?.kind === 'RECOVERY') return `恢复登录 · ${server}`;
  return `加入 ${server}`;
});
const subtitle = computed(() => preview.value?.kind === 'RECOVERY' ? '回到熟悉的小队'
  : preview.value?.kind === 'ACTIVATE' ? '让朋友们有个相聚的地方' : '一起开黑，一起看');
const canRedeem = computed(() => preview.value?.status === 'PENDING'
  || (preview.value?.status === 'COMPLETED' && canRetryRedemption.value));
let generation = 0;
const controller = new AbortController();
async function checkLink() {
  const task = ++generation;
  preview.value = null;
  canRetryRedemption.value = false;
  error.value = '';
  if (props.offer.server !== props.currentServer) return;
  try {
    const result = await authRequest<AccessPreview>('access/preview', 'POST', { token: props.offer.token },
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    if (task !== generation) return;
    preview.value = result;
    if (result.status === 'COMPLETED') {
      const key = sessionStorage.getItem(`lycan:redeem:${props.offer.token}`);
      canRetryRedemption.value = key !== null && /^[A-Za-z0-9_-]{43}$/.test(key);
    }
  } catch (exception) { if (task === generation) error.value = exception instanceof Error ? exception.message : '链接检查失败'; }
}

function close() { if (!busy.value) emit('cancel'); }
watch(() => [props.offer.token, props.offer.server, props.currentServer], () => { void checkLink(); }, { immediate: true });
onMounted(() => heading.value?.focus());
onScopeDispose(() => { generation++; controller.abort(); });

async function join() {
  if (busy.value || props.currentUser || !canRedeem.value || !preview.value) return;
  busy.value = true;
  error.value = '';
  const token = props.offer.token;
  const task = generation;
  const kind = preview.value.kind;
  try {
    const result = await authRequest<{ sessionToken?: string; user: AuthUser }>('access/redeem', 'POST', { token, redemptionKey: redemptionKey(token) });
    if (task !== generation) return;
    // 服务端兑换已完成；临时重试凭据清理失败不能把成功登录误报为兑换失败。
    try { sessionStorage.removeItem(`lycan:redeem:${token}`); }
    catch { console.warn('登录已完成，但本页临时重试凭据未能清理。'); }
    emit('joined', result, kind);
  } catch (exception) { if (task === generation) error.value = exception instanceof Error ? exception.message : '操作未完成，请重试'; }
  finally { busy.value = false; }
}

async function switchServer() {
  if (busy.value || props.currentUser) return;
  busy.value = true;
  try { await window.lycanDesktop?.prepareAccessLink(props.offer); }
  catch (exception) { error.value = exception instanceof Error ? exception.message : '服务器切换失败'; busy.value = false; }
}
</script>

<template>
  <section class="auth-card access-prompt" aria-labelledby="access-prompt-title" @keydown.esc.stop="close">
    <header class="access-header">
      <div><h1 id="access-prompt-title" ref="heading" tabindex="-1">{{ title }}</h1><p>{{ subtitle }}</p></div>
    </header>
    <div class="access-body">
      <template v-if="currentUser">
        <p>已登录 {{ currentUser.nickname }}。如需使用其他账号，请先退出登录。</p>
      </template>
      <template v-else-if="offer.server !== currentServer">
        <p>连接到 {{ offer.server }}，确认后应用将切换服务器并重启。</p>
      </template>
      <template v-else-if="preview">
        <p v-if="!canRedeem">链接已使用、过期或撤销，请联系服主获取新链接。</p>
        <p v-else>{{ preview.kind === 'ACTIVATE' ? '确认后成为本服务器的服主，管理成员与邀请。' : preview.kind === 'RECOVERY' ? '保留原账号的资料与权限，旧设备将退出登录。' : '这是你的专属邀请，加入后链接即失效。' }}</p>
      </template>
      <p v-else-if="!error">正在检查邀请…</p>
      <p v-else>暂时无法检查此链接，请重试。</p>
    </div>
    <footer class="card-actions" :class="{ 'card-actions-no-cancel': !!currentUser, 'card-actions-no-primary': !currentUser && offer.server === currentServer && !canRedeem && !error }">
      <button v-if="!currentUser" type="button" class="settings-button" :disabled="busy" @click="close">取消</button>
      <InlineFeedback class="card-feedback" :message="error" :status="busy ? '正在处理…' : ''" />
      <button v-if="currentUser" type="button" class="confirm-button card-actions-end" :disabled="busy" @click="close">返回应用</button>
      <button v-else-if="offer.server !== currentServer" type="button" class="confirm-button card-actions-end" :disabled="busy" @click="switchServer">连接并重启</button>
      <button v-else-if="canRedeem" type="button" class="confirm-button card-actions-end" :disabled="busy" @click="join">{{ preview?.kind === 'ACTIVATE' ? '确认激活' : preview?.kind === 'RECOVERY' ? '恢复登录' : '确认加入' }}</button>
      <button v-else-if="error" type="button" class="confirm-button card-actions-end" :disabled="busy" @click="checkLink">重新检查</button>
    </footer>
  </section>
</template>

<style scoped>
.access-prompt { width: min(480px, 100%); padding: 24px; }
.access-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.access-header > div { min-width: 0; }
.access-header h1 { margin: 0; font-size: 22px; line-height: 32px; overflow-wrap: anywhere; }
.access-header p { margin: 4px 0 0; font-size: 13px; line-height: 20px; }
.access-body { min-height: 64px; margin: 20px 0; }
.access-body p { margin: 0; color: var(--muted); font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
@media (max-width: 420px) { .access-prompt { padding: 20px; } .access-header h1 { font-size: 20px; } }
</style>

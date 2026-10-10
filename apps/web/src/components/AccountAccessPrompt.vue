<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { authRequest, type AuthUser } from '../auth/authApi';
import { redemptionKey, type AccessOffer, type AccessPreview } from '../auth/accountAccess';
const props = defineProps<{ offer: AccessOffer; currentUser: AuthUser | null; currentServer: string }>();
const emit = defineEmits<{ cancel: []; joined: [result: { sessionToken?: string; user: AuthUser }, kind: string] }>();
const preview = ref<AccessPreview | null>(null);
const error = ref('');
const busy = ref(false);
const canRedeem = computed(() => preview.value?.status === 'PENDING'
  || (preview.value?.status === 'COMPLETED' && !!sessionStorage.getItem(`lycan:redeem:${props.offer.token}`)));
let generation = 0;
const controller = new AbortController();
onScopeDispose(() => { generation++; controller.abort(); });
watch(() => [props.offer.token, props.currentServer], async () => {
  const task = ++generation;
  preview.value = null;
  error.value = '';
  if (props.offer.server !== props.currentServer) return;
  try {
    const result = await authRequest<AccessPreview>('access/preview', 'POST', { token: props.offer.token },
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    if (task === generation) preview.value = result;
  } catch (exception) { if (task === generation) error.value = exception instanceof Error ? exception.message : '链接检查失败'; }
}, { immediate: true });

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
    sessionStorage.removeItem(`lycan:redeem:${token}`);
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
  <section class="auth-card" aria-label="确认链接操作">
    <h1>{{ preview?.serverName ?? '打开 LycanSync' }}</h1>
    <template v-if="currentUser">
      <p>当前已登录 {{ currentUser.nickname }}。可以直接返回应用；需要使用其他账号时，请先退出登录。</p>
    </template>
    <template v-else-if="offer.server !== currentServer">
      <p>此链接连接到 {{ offer.server }}，确认后应用将切换服务器并重启。</p>
      <button :disabled="busy" @click="switchServer">确认连接此服务器</button>
    </template>
    <template v-else-if="preview">
      <p v-if="!canRedeem">链接已使用、过期或撤销。恢复原账号请联系服主；下载入口仍在原网页。</p>
      <template v-else>
        <p>{{ preview.kind === 'ACTIVATE' ? '确认后成为本服务器管理员。' : preview.kind === 'RECOVERY' ? '恢复原账号，保留资料与权限；成功后旧设备登录失效。' : '加入此服务器，接下来可以设置资料或直接跳过。' }}</p>
        <div class="button-actions">
          <button disabled>QQ 授权（尚未开通）</button>
          <button class="confirm-button" :disabled="busy" @click="join">{{ busy ? '正在处理…' : preview.kind === 'ACTIVATE' ? '确认激活' : preview.kind === 'RECOVERY' ? '确认恢复登录' : '暂不绑定 QQ，确认加入' }}</button>
        </div>
      </template>
    </template>
    <p v-else-if="!error">正在检查链接…</p>
    <p v-if="error" role="alert" class="auth-error">{{ error }}</p>
    <button :disabled="busy" @click="emit('cancel')">{{ currentUser ? '返回应用' : '取消' }}</button>
  </section>
</template>

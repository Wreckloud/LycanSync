<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { authRequest, type AuthUser } from '../../auth/authApi';
import { accessLinkStatus, type AccessLinkRecord } from '../../auth/accountAccess';
const props = defineProps<{ active: boolean }>();
const links = ref<AccessLinkRecord[]>([]);
const members = ref<AuthUser[]>([]);
const offset = ref(0);
const memberOffset = ref(0);
const note = ref('');
const target = ref('');
const generatedUrl = ref('');
const error = ref('');
const busy = ref(false);
const currentTime = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const controller = new AbortController();
onScopeDispose(() => { controller.abort(); clearInterval(timer); });
watch(() => props.active, (active) => {
  clearInterval(timer);
  if (active) { void refresh(); timer = setInterval(() => { currentTime.value = Date.now(); }, 30_000); }
}, { immediate: true });
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await Promise.all([
      authRequest<AccessLinkRecord[]>(`access/links?offset=${offset.value}`, 'GET', undefined, requestSignal()),
      authRequest<AuthUser[]>(`access/members?offset=${memberOffset.value}`, 'GET', undefined, requestSignal()),
    ]);
    links.value = result[0]; members.value = result[1]; currentTime.value = Date.now();
    target.value = '';
  } catch (exception) { if (!controller.signal.aborted) error.value = message(exception); }
  finally { busy.value = false; }
}
function requestSignal() { return AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]); }
function message(exception: unknown) { return exception instanceof Error ? exception.message : '操作失败，请重试'; }
async function generate(kind: 'INVITE' | 'RECOVERY', id?: string) {
  if (busy.value || (kind === 'RECOVERY' && !target.value && !id)) return;
  busy.value = true; error.value = ''; generatedUrl.value = '';
  try {
    const result = id
      ? await authRequest<{ url: string }>(`access/links/${id}/renew`, 'POST', undefined, requestSignal())
      : await authRequest<{ url: string }>('access/links', 'POST', { kind, targetId: kind === 'RECOVERY' ? target.value : null, note: note.value }, requestSignal());
    generatedUrl.value = result.url;
  } catch (exception) { if (!controller.signal.aborted) error.value = message(exception); }
  finally { busy.value = false; }
  if (!controller.signal.aborted && generatedUrl.value) await refresh();
}
async function revoke(id: string) {
  if (busy.value || !window.confirm('撤销后该链接立即失效，是否继续？')) return;
  busy.value = true;
  let revoked = false;
  error.value = '';
  try { await authRequest<void>(`access/links/${id}`, 'DELETE', undefined, requestSignal()); generatedUrl.value = ''; revoked = true; }
  catch (exception) { error.value = message(exception); }
  finally { busy.value = false; }
  if (!controller.signal.aborted && revoked) await refresh();
}
async function copyLink() {
  try { await navigator.clipboard.writeText(generatedUrl.value); }
  catch { error.value = '复制失败，请选择链接手动复制。'; }
}
function page(direction: number, memberPage = false) {
  if (busy.value) return;
  if (memberPage) memberOffset.value = Math.max(0, memberOffset.value + direction * 100);
  else offset.value = Math.max(0, offset.value + direction * 100);
  void refresh();
}
</script>
<template>
  <section class="settings-section">
    <section class="settings-block">
      <h2>邀请新朋友</h2><p>每人一条，3 天有效。成功加入后不能再使用。</p>
      <label>备注（仅服主可见）<input v-model="note" maxlength="100" :disabled="busy" /></label>
      <button :disabled="busy" @click="generate('INVITE')">邀请新朋友</button>
    </section>
    <section class="settings-block">
      <h2>恢复成员登录</h2><p>12 小时有效；成功后旧设备登录失效，原资料与权限保留。</p>
      <label>成员<select v-model="target" :disabled="busy"><option value="">请选择成员</option>
        <option v-for="member in members" :key="member.id" :value="member.id">{{ member.nickname }} · {{ member.id }}</option>
      </select></label>
      <button :disabled="busy || !target" @click="generate('RECOVERY')">恢复成员登录</button>
      <div class="button-actions"><button :disabled="busy || memberOffset === 0" @click="page(-1, true)">上一页成员</button>
        <button :disabled="busy || members.length < 100" @click="page(1, true)">下一页成员</button></div>
    </section>
    <section v-if="generatedUrl" class="settings-block">
      <h2>新链接</h2><p>请保存并发给对应朋友；服务器只保存摘要，离开后无法再次查看原链接。</p>
      <input :value="generatedUrl" readonly aria-label="生成的链接" /><button @click="copyLink">复制链接</button>
    </section>
    <section class="settings-block">
      <h2>链接记录</h2><button :disabled="busy" @click="refresh">刷新状态</button>
      <p v-if="!links.length">暂无记录</p>
      <article v-for="link in links" :key="link.id" class="access-record">
        <strong>{{ link.kind === 'INVITE' ? '邀请新朋友' : '恢复成员登录' }} · {{ accessLinkStatus(link, currentTime) }}</strong>
        <span>{{ link.note || '无备注' }}</span><small>到期：{{ new Date(link.expiresAt).toLocaleString() }}</small>
        <small v-if="link.resultUserId">已完成成员：{{ link.resultUserId }}</small>
        <small v-if="link.lastFailure">上次失败：{{ link.lastFailure }}（失败不会消耗链接）</small>
        <div v-if="!link.consumedAt" class="button-actions"><button :disabled="busy" @click="generate(link.kind === 'RECOVERY' ? 'RECOVERY' : 'INVITE', link.id)">重新生成</button>
          <button :disabled="busy || !!link.revokedAt" @click="revoke(link.id)">撤销</button></div>
      </article>
      <div class="button-actions"><button :disabled="busy || offset === 0" @click="page(-1)">上一页记录</button><button :disabled="busy || links.length < 100" @click="page(1)">下一页记录</button></div>
    </section>
    <p v-if="error" role="alert" class="auth-error">{{ error }}</p>
  </section>
</template>
<style scoped>
label,.access-record { display:grid; gap:8px; }
input,select { max-width:100%; width:100%; padding:8px; background:var(--panel); color:var(--text); border:1px solid var(--border); }
.settings-block > button, .settings-block > .button-actions { margin-top: 8px; }
.access-record { padding:12px 0; border-bottom:1px solid var(--border-soft); overflow-wrap:anywhere; }
</style>

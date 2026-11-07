<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { authRequest } from '../../auth/authApi';
import { useQqLogin } from '../../auth/useQqLogin';
import InlineFeedback from '../InlineFeedback.vue';
import AccountLifecycleSettings from './AccountLifecycleSettings.vue';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean }>();
const emit = defineEmits<{ logout: [] }>();
const expanded = ref<'qq' | null>(null);
const qqAvailable = ref(false);
const binding = ref<{ bound: boolean; nickname: string } | null>(null);
const qqError = ref('');
let request: AbortController | undefined;
async function refreshBinding() {
  request?.abort();
  const current = new AbortController();
  request = current;
  qqError.value = '';
  try {
    const options = await authRequest<{ qqAvailable: boolean }>('options', 'GET', undefined, current.signal);
    if (current.signal.aborted) return;
    qqAvailable.value = options.qqAvailable;
    if (options.qqAvailable) {
      const result = await authRequest<{ bound: boolean; nickname: string }>('qq/binding', 'GET', undefined, current.signal);
      if (!current.signal.aborted) binding.value = result;
    }
  } catch (reason) {
    if (!current.signal.aborted) qqError.value = reason instanceof Error ? reason.message : '无法读取 QQ 绑定状态';
  }
}
const qq = useQqLogin(() => {}, refreshBinding);
onScopeDispose(() => request?.abort());

function toggleEntry(entry: 'qq') {
  expanded.value = expanded.value === entry ? null : entry;
}
watch(() => props.active, (active) => {
  if (!active) { expanded.value = null; request?.abort(); qq.cancel(); return; }
  void refreshBinding();
}, { immediate: true });
</script>

<template>
  <section class="settings-section account-settings">
    <p>退出登录会保留本机凭据。已绑定 QQ 的账号可通过 QQ 重新登录；未绑定时，服主使用恢复密码，成员向服主获取恢复链接。</p>
    <section class="settings-block">
      <h2>第三方账号</h2>
      <div v-if="qqAvailable" class="account-row"><div class="account-copy"><span>QQ 登录</span>
        <small>{{ binding?.bound ? `已绑定 · ${binding.nickname}` : '绑定后可通过 QQ 登录原账号，保留资料与权限' }}</small></div>
        <button v-if="!binding?.bound" type="button" :disabled="!binding || leaving || qq.busy.value" @click="qq.start(true)">绑定 QQ</button>
        <button v-if="qq.busy.value" type="button" :disabled="qq.finishing.value" @click="qq.cancel">取消等待</button></div>
      <div v-else class="account-row"><div class="account-copy"><span>QQ 登录</span>
        <div class="account-row-description"><p v-if="expanded === 'qq'" id="qq-entry" class="account-entry-note">当前服务器尚未开启 QQ 登录，已有账号与群聊仍可正常使用。</p><small v-else>当前服务器未开启</small></div></div>
        <button type="button" :aria-expanded="expanded === 'qq'" aria-controls="qq-entry" @click="toggleEntry('qq')">{{ expanded === 'qq' ? '收起说明' : '查看 QQ 绑定说明' }}</button></div>
      <InlineFeedback :message="qq.error.value || qqError" :status="qq.busy.value && !qq.finishing.value ? '请在浏览器确认 QQ 身份，再返回应用完成绑定' : ''"
        :pending="qq.finishing.value ? '正在确认绑定…' : qqAvailable && !binding && !qqError ? '正在读取绑定状态…' : ''" />
    </section>
    <section class="settings-block account-session">
      <h2>账号操作</h2>
      <div class="account-row"><div class="account-copy"><span>退出当前账号</span></div>
        <button type="button" :disabled="leaving" @click="emit('logout')">退出登录</button></div>
    </section>
    <AccountLifecycleSettings v-if="!administrator" :active="active" :leaving="leaving" :administrator="false" />
  </section>
</template>

<style scoped>
.account-settings { max-width: 820px; }
.account-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 44px; }
.account-copy { display: grid; gap: 4px; min-width: 0; flex: 1; }
.account-copy small { display: block; line-height: 16px; }
.account-row-description { color: var(--muted); font-size: 12px; line-height: 16px; }
.account-row button { flex-shrink: 0; }
.account-row .account-danger { color: var(--danger); }
.account-entry-note { font-size: 12px; line-height: 16px; }
.account-session { gap: 12px; border-bottom: 0; }
@media (max-width: 520px) { .account-row { align-items: flex-start; gap: 12px; } }
</style>

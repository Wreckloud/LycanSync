<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { authRequest } from '../../auth/authApi';
import { useQqLogin } from '../../auth/useQqLogin';
import InlineFeedback from '../InlineFeedback.vue';
import AccountLifecycleSettings from './AccountLifecycleSettings.vue';
import type { GroupDetail } from '../../group/groupApi';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean; userId: string }>();
const emit = defineEmits<{ logout: []; resolveOwner: []; groupUpdated: [group: GroupDetail]; groupRemoved: [id: string] }>();
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
    <h2>账号操作</h2>
    <section class="settings-block account-operation">
      <div class="settings-action-row"><h3>绑定第三方账号</h3>
        <span class="settings-actions">
          <button v-if="qqAvailable && !binding?.bound" type="button" :disabled="!binding || leaving || qq.busy.value" @click="qq.start(true)">绑定 QQ</button>
          <button v-if="qq.busy.value" type="button" :disabled="qq.finishing.value" @click="qq.cancel">取消等待</button>
          <button v-if="!qqAvailable" type="button" :aria-expanded="expanded === 'qq'" aria-controls="qq-entry" @click="toggleEntry('qq')">{{ expanded === 'qq' ? '收起说明' : '查看 QQ 绑定说明' }}</button>
        </span>
      </div>
      <p>{{ binding?.bound ? `已绑定 QQ · ${binding.nickname}` : '绑定 QQ，方便下次登录当前账号。' }}</p>
      <small v-if="!qqAvailable && expanded !== 'qq'">当前服务器未开启 QQ 登录。</small>
      <p v-if="!qqAvailable && expanded === 'qq'" id="qq-entry">当前服务器尚未开启 QQ 登录。</p>
      <InlineFeedback :message="qq.error.value || qqError" :status="qq.busy.value && !qq.finishing.value ? '请在浏览器确认 QQ 绑定' : ''"
        :pending="qq.finishing.value ? '正在确认绑定…' : qqAvailable && !binding && !qqError ? '正在读取绑定状态…' : ''" />
    </section>
    <section class="settings-block account-operation">
      <div class="settings-action-row"><h3>退出当前账号</h3>
        <button type="button" :disabled="leaving" @click="emit('logout')">退出登录</button></div>
      <p>返回登录页，并记住此账号，方便下次登录。</p>
    </section>
    <AccountLifecycleSettings :active="active" :leaving="leaving" :administrator="administrator" :user-id="userId" section="account"
      @resolve-owner="emit('resolveOwner')" @group-updated="emit('groupUpdated', $event)" @group-removed="emit('groupRemoved', $event)" />
  </section>
</template>

<style scoped>
.account-settings { max-width: 820px; }
.account-settings :deep(.account-operation > .settings-action-row > button),
.account-settings :deep(.account-operation > .settings-action-row > .settings-actions > button) { min-width: 128px; white-space: nowrap; }
@media (max-width: 520px) { .account-operation .settings-action-row { align-items: flex-start; } }
</style>

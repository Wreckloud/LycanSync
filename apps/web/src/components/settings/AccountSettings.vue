<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { authRequest } from '../../auth/authApi';
import { useQqLogin } from '../../auth/useQqLogin';
import { useSettingsRead } from '../../settings/useSettingsRead';
import InlineFeedback from '../InlineFeedback.vue';
import { useLoadingHint } from '../useLoadingHint';
import AccountLifecycleSettings from './AccountLifecycleSettings.vue';
import type { GroupDetail } from '../../group/groupApi';

const props = defineProps<{ active: boolean; leaving: boolean; administrator?: boolean; userId: string; nickname: string }>();
const emit = defineEmits<{ logout: []; notice: [message: string]; groupUpdated: [group: GroupDetail]; groupRemoved: [id: string] }>();
const qqAvailable = ref(false);
const { value: binding, error: qqError, loading, refresh, clear } = useSettingsRead(async signal => {
  const options = await authRequest<{ qqAvailable: boolean }>('options', 'GET', undefined, signal);
  signal.throwIfAborted();
  qqAvailable.value = options.qqAvailable;
  return options.qqAvailable
    ? authRequest<{ bound: boolean; nickname: string }>('qq/binding', 'GET', undefined, signal)
    : null;
}, '无法读取 QQ 绑定状态', () => { qqAvailable.value = false; });
function bindingChanged() {
  clear();
  if (props.active) return refresh();
}
defineExpose({ bindingChanged });
const qq = useQqLogin(() => {}, bindingChanged);
const readingBinding = useLoadingHint(() => props.active && qqAvailable.value && loading.value && !binding.value);
const bindingDescription = computed(() => {
  if (readingBinding.value) return '正在读取绑定状态…';
  if (!binding.value) return loading.value ? '—' : '尚未确认绑定状态。';
  return binding.value.bound ? `已绑定 QQ · ${binding.value.nickname}` : '绑定 QQ，方便下次登录当前账号。';
});

watch(() => props.active, (active) => {
  if (!active) { qq.cancel(); return; }
  qq.error.value = '';
  void refresh();
}, { immediate: true });
</script>

<template>
  <section class="settings-section account-settings">
    <h2>账号操作</h2>
    <section v-if="qqAvailable" class="settings-block account-operation">
      <div class="settings-action-row qq-binding-row"><h3>绑定第三方账号</h3>
        <span class="settings-actions settings-control settings-control-buttons">
          <button v-if="binding && !binding.bound" type="button" :disabled="leaving || qq.busy.value || !!qqError" @click="qq.start(true)">绑定 QQ</button>
          <button v-if="qq.busy.value" type="button" :disabled="qq.finishing.value" @click="qq.cancel">取消等待</button>
        </span>
      </div>
      <p>{{ bindingDescription }}</p>
      <InlineFeedback :message="qq.error.value || qqError" :status="qq.busy.value && !qq.finishing.value ? '请在浏览器确认 QQ 绑定' : ''"
        :pending="qq.finishing.value ? '正在确认绑定…' : ''" />
    </section>
    <InlineFeedback v-if="!qqAvailable" :message="qqError" />
    <button v-if="qqError" type="button" :disabled="loading || leaving || qq.busy.value" @click="refresh">重试</button>
    <section class="settings-block account-operation">
      <div class="settings-action-row"><h3>退出当前账号</h3>
        <button type="button" class="settings-button settings-control" :disabled="leaving" @click="emit('logout')">退出登录</button></div>
      <p>返回登录页，并记住此账号，方便下次登录。</p>
    </section>
    <AccountLifecycleSettings :active="active" :leaving="leaving" :administrator="administrator" :user-id="userId" :nickname="nickname" section="account"
      @notice="emit('notice', $event)" @group-updated="emit('groupUpdated', $event)" @group-removed="emit('groupRemoved', $event)" />
  </section>
</template>

<style scoped>
.account-settings { max-width: 820px; }
.qq-binding-row { min-height: var(--button-height); }
@media (max-width: 520px) { .account-operation .settings-action-row { align-items: flex-start; } }
</style>

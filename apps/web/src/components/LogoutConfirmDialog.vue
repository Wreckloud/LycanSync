<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ administrator: boolean; busy: boolean; error: string; mode?: 'logout' | 'remove' }>();
const removing = computed(() => props.mode === 'remove');
const action = computed(() => removing.value ? '清除登录信息' : '退出登录');
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const dialog = ref<HTMLElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);

function cancel() { if (!props.busy) emit('cancel'); }
function confirm() { if (!props.busy) emit('confirm'); }

onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
    <section ref="dialog" class="logout-confirm-dialog" role="dialog" aria-modal="true"
      aria-labelledby="logout-confirm-title" aria-describedby="logout-confirm-description" tabindex="-1" @keydown="keepDialogFocus">
      <header><h2 id="logout-confirm-title">{{ removing ? '从此设备移除账号？' : '退出当前账号？' }}</h2><p v-if="!removing">回到登录页，保留本机凭据。</p></header>
      <p v-if="removing" id="logout-confirm-description">{{ administrator
        ? '清除后，再次登录需要已设置的恢复密码或已绑定的登录方式。'
        : '清除后，再次登录需要服主提供的恢复链接或已绑定的登录方式。' }}</p>
      <p v-else id="logout-confirm-description">退出后将结束通话、共享和远控，保存正在录制的录像与诊断记录。未保存的即时回放将丢弃。</p>
      <footer class="card-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <InlineFeedback class="card-feedback" :message="error" :pending="busy ? '正在处理…' : ''" />
        <button type="button" class="confirm-button card-actions-end" :disabled="busy" @click="confirm">{{ action }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.logout-confirm-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.logout-confirm-dialog header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.logout-confirm-dialog header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.logout-confirm-dialog > p { margin: 16px 0; color: var(--muted); }
@media (max-width: 420px) { .logout-confirm-dialog { padding: 20px; } }
</style>

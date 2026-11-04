<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';

const props = defineProps<{ administrator: boolean; busy: boolean; error: string; mode?: 'logout' | 'remove' }>();
const removing = computed(() => props.mode === 'remove');
const action = computed(() => removing.value ? '清除凭据' : '退出登录');
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const dialog = ref<HTMLElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);

function cancel() { if (!props.busy) emit('cancel'); }
function confirm() { if (!props.busy) emit('confirm'); }
function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
    <section ref="dialog" class="logout-confirm-dialog" role="dialog" aria-modal="true"
      aria-labelledby="logout-confirm-title" aria-describedby="logout-confirm-description" tabindex="-1" @keydown="keepFocus">
      <header><h2 id="logout-confirm-title">{{ removing ? '从此设备移除账号？' : '退出当前账号？' }}</h2><p>{{ removing ? (administrator ? '再次登录需要已设置的服主恢复密码。' : '再次登录需要新的恢复登录链接。') : '回到登录页，保留本机凭据。' }}</p></header>
      <p id="logout-confirm-description">将结束当前通话、屏幕共享、远控、录制与即时回放。已保存的录像和诊断报告会保留，未保存的回放缓存会清空。</p>
      <p v-if="removing">将清除本机登录凭据和聊天缓存，并尝试撤销服务器会话。此操作不会注销账号。</p>
      <p v-if="removing">{{ administrator ? '你是服主，请先确认已在服主管理中设置恢复密码。移除后可从欢迎页“群组恢复”找回账号，旧激活链接不能再次登录。' : '请先确认能联系服主获取新的恢复登录链接，旧邀请链接不能重复使用。' }}</p>
      <footer class="card-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <InlineFeedback class="card-feedback" :message="error" :status="busy ? '正在处理…' : ''" />
        <button type="button" class="confirm-button card-actions-end" :disabled="busy" @click="confirm">{{ busy ? '正在处理…' : action }}</button>
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

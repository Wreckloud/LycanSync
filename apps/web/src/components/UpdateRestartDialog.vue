<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';

const props = defineProps<{ version: string; busy: boolean; error: string }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const dialog = ref<HTMLElement | null>(null);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

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
onScopeDispose(() => { void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); }); });
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop" @keydown.esc.stop="cancel">
      <section ref="dialog" class="update-restart-dialog" role="dialog" aria-modal="true"
        aria-labelledby="update-restart-title" aria-describedby="update-restart-description" tabindex="-1" @keydown="keepFocus">
        <header><h2 id="update-restart-title">发现新版本 {{ version }}</h2><p>重启软件并更新？</p></header>
        <p id="update-restart-description">重启会结束当前通话、屏幕共享和远控。随后自动下载并安装新版，完成后重新打开；下载失败仍可使用当前版本。</p>
        <footer class="card-actions">
          <button type="button" :disabled="busy" @click="cancel">取消</button>
          <InlineFeedback class="card-feedback" :message="error" :status="busy ? '正在结束通话并重启…' : ''" />
          <button type="button" class="confirm-button card-actions-end" :disabled="busy" @click="confirm">{{ busy ? '正在重启…' : '重启更新' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.update-restart-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.update-restart-dialog header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.update-restart-dialog header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.update-restart-dialog > p { margin: 20px 0; color: var(--muted); }
@media (max-width: 420px) { .update-restart-dialog { padding: 20px; } }
</style>

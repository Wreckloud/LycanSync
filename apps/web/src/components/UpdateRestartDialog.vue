<script setup lang="ts">
import { onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ version: string; busy: boolean; error: string }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const dialog = ref<HTMLElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);

function cancel() { if (!props.busy) emit('cancel'); }
function confirm() { if (!props.busy) emit('confirm'); }

onMounted(() => dialog.value?.focus());
</script>

<template>
    <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
      <section ref="dialog" class="dialog-panel update-restart-dialog" role="dialog" aria-modal="true"
        aria-labelledby="update-restart-title" aria-describedby="update-restart-description" tabindex="-1" @keydown="keepDialogFocus">
        <header><h2 id="update-restart-title">发现新版本 {{ version }}</h2><p>重启软件并更新？</p></header>
        <p id="update-restart-description">下载并检查新版后，将保存录制并结束通话、共享和远控，再重启安装。完成后自动打开，下载失败仍可使用当前版本。</p>
        <footer class="card-actions">
          <button type="button" :disabled="busy" @click="cancel">取消</button>
          <InlineFeedback class="card-feedback" :message="error" :pending="busy ? '正在准备更新…' : ''" />
          <button type="button" class="confirm-button card-actions-end" :disabled="busy" @click="confirm">重启更新</button>
        </footer>
      </section>
    </div>
</template>

<style scoped>
.update-restart-dialog > p { margin: 20px 0; color: var(--muted); }
</style>

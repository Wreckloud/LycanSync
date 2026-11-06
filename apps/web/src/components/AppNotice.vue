<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { X } from '@lucide/vue';

const props = defineProps<{ message: string; kind?: 'success' }>();
const emit = defineEmits<{ dismiss: [] }>();
const visible = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;

function dismiss() {
  clearTimeout(timer);
  visible.value = false;
  emit('dismiss');
}

watch(() => [props.message, props.kind], () => {
  clearTimeout(timer);
  visible.value = true;
  timer = setTimeout(dismiss, 4000);
}, { immediate: true });
onScopeDispose(() => clearTimeout(timer));
</script>

<template>
  <aside v-if="visible" class="app-notice" :class="{ 'is-success': kind === 'success' }">
    <div class="notice" :role="kind === 'success' ? 'status' : 'alert'">
      <span class="notice-message">{{ message }}</span>
      <button type="button" class="notice-close" aria-label="关闭提示" @click="dismiss"><X :size="14" /></button>
    </div>
  </aside>
</template>

<style scoped>
.app-notice { position: fixed; z-index: 50; top: 54px; left: 50%; transform: translateX(-50%); width: min(680px, calc(100% - 32px)); }
.notice { display: flex; align-items: flex-start; gap: 12px; padding: 10px 13px; border: 1px solid #6c533a; border-radius: 5px; background: #332820; color: #f3cfaa; box-shadow: 0 12px 35px #0008; font-size: 14px; }
.notice-message { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 24px; }
.is-success .notice { border-color: var(--good); background: var(--panel); color: var(--text); }
.notice-close { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.notice-close:hover { background: #ffffff0d; }
</style>

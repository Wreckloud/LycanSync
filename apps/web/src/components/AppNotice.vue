<script setup lang="ts">
import { ref, watch } from 'vue';
import { ChevronDown, ChevronUp, CircleAlert } from '@lucide/vue';

const props = defineProps<{ message: string }>();
const collapsed = ref(false);

watch(() => props.message, () => { collapsed.value = false; });
</script>

<template>
  <aside class="app-notice" :class="{ 'is-collapsed': collapsed }">
    <button v-if="collapsed" type="button" class="notice-summary" aria-label="展开提示" :aria-expanded="false" @click="collapsed = false">
      <CircleAlert :size="14" /><span>提示</span><ChevronDown :size="14" />
    </button>
    <div v-else class="notice" role="alert">
      <span class="notice-message">{{ message }}</span>
      <button type="button" class="notice-collapse" aria-label="收起提示" :aria-expanded="true" @click="collapsed = true">收起<ChevronUp :size="14" /></button>
    </div>
  </aside>
</template>

<style scoped>
.app-notice { position: fixed; z-index: 50; top: 54px; left: 50%; transform: translateX(-50%); width: min(680px, calc(100% - 32px)); }
.notice { display: flex; align-items: flex-start; gap: 12px; padding: 10px 13px; border: 1px solid #6c533a; border-radius: 5px; background: #332820; color: #f3cfaa; box-shadow: 0 12px 35px #0008; font-size: 14px; }
.notice-message { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 24px; }
.notice-collapse { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; min-height: 24px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.notice-collapse:hover { background: #ffffff0d; }
.app-notice.is-collapsed { width: auto; }
.notice-summary { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 4px 10px; border: 1px solid var(--border-soft); border-radius: 5px; background: var(--panel-raised); color: #f3cfaa; font-size: 12px; cursor: pointer; }
.notice-summary:hover { background: var(--panel-soft); }
</style>

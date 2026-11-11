<script setup lang="ts">
import { onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ initialName: string; busy: boolean; error: string }>();
const emit = defineEmits<{ cancel: []; save: [name: string] }>();
const name = ref(props.initialName);
const input = ref<HTMLInputElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);

function cancel() { if (!props.busy) emit('cancel'); }
function save() { if (!props.busy && name.value.trim()) emit('save', name.value.trim()); }

onMounted(() => { input.value?.focus(); input.value?.select(); });
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
    <form class="activity-name-dialog" role="dialog" aria-modal="true" aria-labelledby="activity-name-title"
      tabindex="-1" @submit.prevent="save" @keydown="keepDialogFocus">
      <h2 id="activity-name-title">修改动态名称</h2>
      <label for="activity-display-name">显示名称</label>
      <input id="activity-display-name" ref="input" v-model="name" aria-label="动态显示名称" maxlength="80"
        aria-describedby="activity-name-feedback" :readonly="busy" @keydown.enter="($event.isComposing || busy) && $event.preventDefault()" />
      <InlineFeedback id="activity-name-feedback" :message="error" :pending="busy ? '正在保存…' : ''" />
      <footer class="card-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <button type="submit" class="confirm-button card-actions-end" :disabled="busy || !name.trim()">保存名称</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.activity-name-dialog { display: grid; gap: 12px; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 14px; line-height: 22px; }
.activity-name-dialog h2 { margin: 0 0 4px; font-size: 22px; line-height: 32px; }
.activity-name-dialog label { font-size: 13px; }
.activity-name-dialog input { min-width: 0; width: 100%; box-sizing: border-box; height: var(--button-height); padding: var(--button-padding); border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; font-size: 13px; }
@media (max-width: 420px) { .activity-name-dialog { padding: 20px; } }
</style>

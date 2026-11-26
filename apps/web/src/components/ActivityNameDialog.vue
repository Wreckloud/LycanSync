<script setup lang="ts">
import { onMounted, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';
import { useBackdropDismiss } from './useBackdropDismiss';
import { keepDialogFocus } from './dialogFocus';

const props = defineProps<{ initialName: string; hasAlias: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ cancel: []; save: [name: string]; remove: [] }>();
const name = ref(props.initialName);
const input = ref<HTMLInputElement | null>(null);
const backdropEvents = useBackdropDismiss(cancel);

function cancel() { if (!props.busy) emit('cancel'); }
function save() { if (!props.busy && name.value.trim()) emit('save', name.value.trim()); }

onMounted(() => { input.value?.focus(); input.value?.select(); });
</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
    <form class="dialog-panel activity-name-dialog" role="dialog" aria-modal="true" aria-labelledby="activity-name-title"
      tabindex="-1" @submit.prevent="save" @keydown="keepDialogFocus">
      <h2 id="activity-name-title">修改动态名称</h2>
      <label for="activity-display-name">显示名称</label>
      <input id="activity-display-name" ref="input" v-model="name" aria-label="动态显示名称" maxlength="80"
        aria-describedby="activity-name-feedback" :readonly="busy" @keydown.enter="($event.isComposing || busy) && $event.preventDefault()" />
      <InlineFeedback id="activity-name-feedback" :message="error" :pending="busy ? '正在保存…' : ''" />
      <footer class="card-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <button v-if="hasAlias" type="button" :disabled="busy" @click="emit('remove')">移除自定义名称</button>
        <button type="submit" class="confirm-button card-actions-end" :disabled="busy || !name.trim()">保存名称</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.activity-name-dialog { --dialog-width: 420px; display: grid; gap: 12px; }
.activity-name-dialog .card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.activity-name-dialog .card-actions-end { margin-left: auto; }
.activity-name-dialog label { font-size: 13px; }
.activity-name-dialog input { min-width: 0; width: 100%; box-sizing: border-box; height: var(--button-height); padding: var(--button-padding); border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: var(--text); font: inherit; font-size: 13px; }
</style>

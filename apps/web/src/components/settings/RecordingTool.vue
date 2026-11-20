<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';

const props = defineProps<{ label: string; disabled?: boolean }>();
const visible = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
function hide() {
  clearTimeout(timer);
  visible.value = false;
}
function show(event: PointerEvent | FocusEvent) {
  hide();
  if (props.disabled || ('pointerType' in event && event.pointerType === 'touch')) return;
  if (event.type === 'focus' && !(event.target as HTMLElement).matches(':focus-visible')) return;
  timer = setTimeout(() => { visible.value = true; }, 500);
}
watch(() => [props.disabled, props.label], hide);
onScopeDispose(hide);
</script>

<template>
  <button type="button" class="recording-tool" :aria-label="label" :disabled="disabled"
    @pointerenter="show" @pointerleave="hide" @pointerdown="hide" @click="hide" @focus="show" @blur="hide">
    <slot /><span v-if="visible" class="tool-tag" aria-hidden="true">{{ label }}</span>
  </button>
</template>

<style scoped>
.recording-tool { position: relative; display: grid; place-items: center; width: 42px; height: 42px; padding: 0; border: 0; border-radius: 5px; color: var(--text); background: transparent; overflow: visible; }
.recording-tool:hover:enabled { background: var(--panel-raised); }
.tool-tag { position: absolute; top: calc(100% + 3px); left: 50%; transform: translateX(-50%); pointer-events: none; white-space: nowrap; z-index: 1; background: #252c34; color: #eef2f6; border: 1px solid #353e47; border-radius: 4px; padding: 2px 6px; font-size: 12px; line-height: 16px; }
</style>

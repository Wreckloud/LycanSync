<script setup lang="ts">
import { RotateCcw } from '@lucide/vue';
import { ref, watch } from 'vue';

const props = withDefaults(defineProps<{ value: number; label: string; disabled?: boolean; active?: boolean; ready?: boolean }>(), {
  active: true, ready: true,
});
defineEmits<{ reset: [value: number] }>();
const initialValue = ref(props.value);
// 按页面进入记录撤回基准；异步设置加载完成前的占位值不算用户修改。
watch([() => props.active, () => props.ready, () => props.value], ([active, ready, value], [wasActive, wasReady]) => {
  if (!active || !ready || !wasActive || !wasReady) initialValue.value = value;
});
</script>

<template>
  <span class="range-value">
    <button type="button" class="range-reset" :class="{ 'is-hidden': !active || !ready || value === initialValue }" :aria-label="label"
      title="恢复本次调整前的值" :disabled="disabled || !active || !ready || value === initialValue"
      @click.stop.prevent="$emit('reset', initialValue)"><RotateCcw :size="14" aria-hidden="true" /></button>
    <strong><slot /></strong>
  </span>
</template>

<style scoped>
.range-value { display: inline-flex; align-items: center; flex-shrink: 0; gap: 4px; }
.range-value strong { width: 5ch; flex-shrink: 0; text-align: right; font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }
.range-value .range-reset { display: grid; place-items: center; width: 20px; min-width: 20px; height: 20px; min-height: 20px; padding: 0; border: 0; background: transparent; color: var(--muted); }
.range-value .range-reset:hover:not(:disabled) { background: transparent; color: var(--text); }
.range-reset.is-hidden { visibility: hidden; }
</style>

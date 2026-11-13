<script setup lang="ts">
import { RotateCcw } from '@lucide/vue';

defineProps<{ value: number; defaultValue: number; label: string; disabled?: boolean }>();
defineEmits<{ reset: [] }>();
</script>

<template>
  <span class="range-value">
    <button type="button" class="range-reset" :class="{ 'is-hidden': value === defaultValue }" :aria-label="label"
      :disabled="disabled || value === defaultValue" @click.stop.prevent="$emit('reset')"><RotateCcw :size="14" aria-hidden="true" /></button>
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

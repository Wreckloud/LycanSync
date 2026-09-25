<script setup lang="ts">
withDefaults(defineProps<{ label: string; tooltip?: string; showTooltip?: boolean }>(), { showTooltip: true });
</script>

<template>
  <button type="button" class="icon-button" :aria-label="label" :data-tooltip="showTooltip ? tooltip ?? label : undefined"><slot /></button>
</template>

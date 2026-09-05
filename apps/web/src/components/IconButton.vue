<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <button type="button" class="icon-button" :aria-label="label" :data-tooltip="label"><slot /></button>
</template>

<script setup lang="ts">
import { useLoadingHint } from './useLoadingHint';

const props = defineProps<{ message?: string; status?: string; pending?: string }>();
const pendingVisible = useLoadingHint(() => !props.message && !props.status ? props.pending || '' : '', 1000);
</script>

<template>
  <div v-if="message || status || pendingVisible" class="inline-feedback">
    <p v-if="message" role="alert">{{ message }}</p>
    <span v-else-if="status" role="status">{{ status }}</span>
    <span v-else role="status">{{ pending }}</span>
  </div>
</template>

<style scoped>
.inline-feedback { min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: 12px; line-height: 16px; }
.inline-feedback p { margin: 0; color: var(--danger); font-size: inherit; line-height: inherit; }
</style>

<script setup lang="ts">
defineProps<{ message?: string; status?: string }>();
</script>

<template>
  <div class="inline-feedback">
    <p v-if="message" role="alert">{{ message }}</p>
    <span v-else-if="status" role="status">{{ status }}</span>
  </div>
</template>

<style scoped>
.inline-feedback { min-width: 0; height: 32px; overflow: auto; color: var(--muted); font-size: 12px; line-height: 16px; }
.inline-feedback p { margin: 0; color: var(--danger); font-size: inherit; line-height: inherit; }
</style>

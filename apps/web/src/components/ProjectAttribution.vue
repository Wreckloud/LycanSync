<script setup lang="ts">
import { ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';

const error = ref('');
function openProject(event: MouseEvent) {
  const link = (event.target as Element).closest('a');
  if (!link || !window.lycanDesktop) return;
  event.preventDefault();
  error.value = '';
  void window.lycanDesktop.openExternal(link.href).catch(() => {
    error.value = '无法打开默认浏览器。';
  });
}
</script>

<template>
  <div class="project-attribution">
    <small @click="openProject"><slot /></small>
    <InlineFeedback :message="error" />
  </div>
</template>

<style scoped>
.project-attribution { display: grid; gap: 4px; }
.project-attribution small { color: var(--muted); font-size: 12px; line-height: 1.6; }
</style>

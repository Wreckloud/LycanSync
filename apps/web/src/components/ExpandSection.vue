<script setup lang="ts">
defineProps<{ open: boolean; id?: string }>();
</script>

<template>
  <Transition name="layout-reveal" @before-enter="($event as HTMLElement).inert = false" @before-leave="($event as HTMLElement).inert = true">
    <div v-show="open" :id="id" class="layout-reveal expand-section">
      <div class="layout-reveal-inner"><slot /></div>
    </div>
  </Transition>
</template>

<style scoped>
.expand-section { --motion-layout-duration: var(--motion-expand-duration); }
</style>

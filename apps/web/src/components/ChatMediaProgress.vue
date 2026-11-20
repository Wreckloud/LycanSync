<script setup lang="ts">
defineProps<{ label: string; percent?: number }>();
</script>

<template>
  <span class="chat-media-play" aria-hidden="true"><template v-if="percent !== undefined">{{ percent }}%</template><slot v-else /></span>
  <progress class="chat-media-progress" max="100" :value="percent" :aria-label="label" />
</template>

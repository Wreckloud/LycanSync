<script setup lang="ts">
import AppProgress from './AppProgress.vue';
defineProps<{ label: string; percent?: number }>();
</script>

<template>
  <span v-if="percent !== undefined || $slots.default" class="chat-media-play" aria-hidden="true"><template v-if="percent !== undefined">{{ percent }}%</template><slot v-else /></span>
  <AppProgress class="chat-media-progress" :percent="percent" :label="label" />
</template>

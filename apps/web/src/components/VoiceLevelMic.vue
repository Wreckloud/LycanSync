<script setup lang="ts">
import { computed } from 'vue';
import { normalizeVoiceLevel } from '../rtc/voiceLevel';

const props = defineProps<{ level: number; size: number }>();
const fillStyle = computed(() => ({ '--voice-level': normalizeVoiceLevel(props.level) }));
</script>

<template>
  <svg class="voice-level-mic" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect class="voice-level-fill" x="10" y="3" width="4" height="11" rx="2" :style="fillStyle" />
    <path d="M12 19v3" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <rect x="9" y="2" width="6" height="13" rx="3" />
  </svg>
</template>

<style scoped>
.voice-level-mic { display: block; }
.voice-level-fill {
  fill: var(--accent);
  stroke: none;
  transform: scaleY(var(--voice-level));
  transform-box: fill-box;
  transform-origin: center bottom;
  transition: transform 120ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .voice-level-fill { transition: none; }
}
</style>

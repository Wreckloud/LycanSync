<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionQuality } from 'livekit-client';

const props = defineProps<{ quality?: ConnectionQuality }>();
const levels = { excellent: [3, '优秀'], good: [2, '良好'], poor: [1, '较弱'], lost: [0, '中断'], unknown: [0, '未知'] } as const;
const level = computed(() => levels[props.quality ?? 'unknown']);
</script>

<template>
  <span class="signal-bars" role="img" :aria-label="'连接质量：' + level[1]">
    <i v-for="n in 3" :key="n" :class="{ lit: n <= level[0] }" aria-hidden="true" />
  </span>
</template>

<style scoped>
.signal-bars { width: 10px; height: 10px; flex: none; display: inline-flex; align-items: flex-end; gap: 2px; }
.signal-bars i { width: 2px; height: 4px; background: currentColor; opacity: .45; }
.signal-bars i:nth-child(2) { height: 7px; }
.signal-bars i:nth-child(3) { height: 10px; }
.signal-bars .lit { opacity: 1; }
</style>

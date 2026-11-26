<script setup lang="ts">
import { computed } from 'vue';
import HoverHint from './HoverHint.vue';
import type { ConnectionQuality } from 'livekit-client';

const props = defineProps<{ quality?: ConnectionQuality; subject?: string; detail?: string }>();
const levels = { excellent: [3, '优秀'], good: [2, '良好'], poor: [1, '较弱'], lost: [0, '中断'], unknown: [0, '未知'] } as const;
const level = computed(() => levels[props.quality ?? 'unknown']);
</script>

<template>
  <HoverHint class="signal-hint" boundary=".signal-hint" :text="'连接质量：' + level[1] + (detail ? '\n' + detail : '')" v-slot="{ descriptionId }">
    <span class="signal-bars" role="img" tabindex="0" :aria-label="(subject ?? '成员') + '连接质量：' + level[1]" :aria-describedby="descriptionId">
      <i v-for="n in 3" :key="n" :class="{ lit: n <= level[0] }" aria-hidden="true" />
    </span>
  </HoverHint>
</template>

<style scoped>
.signal-bars { width: 10px; height: 10px; flex: none; display: inline-flex; align-items: flex-end; gap: 2px; }
.signal-bars i { width: 2px; height: 4px; background: currentColor; opacity: .45; }
.signal-bars i:nth-child(2) { height: 7px; }
.signal-bars i:nth-child(3) { height: 10px; }
.signal-bars .lit { opacity: 1; }
</style>

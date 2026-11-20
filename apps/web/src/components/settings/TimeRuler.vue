<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { recordingTime } from '../../recording/recordingTime';

const props = defineProps<{ first: number; span: number }>();
const ruler = ref<HTMLElement | null>(null);
const width = ref(0);
let resize: ResizeObserver | undefined;

// 按屏幕宽度选择主刻度，所有刻度都对齐原片时间零点。
const intervals = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const ticks = computed(() => {
  if (!width.value || !props.span) return [];
  const target = props.span * 84 / width.value;
  const major = intervals.find(interval => interval >= target) ?? Math.ceil(target / 3600) * 3600;
  const divisions = major >= 30 && major % 30 === 0 ? 6 : 5;
  const minor = major / divisions;
  const firstIndex = Math.ceil(props.first / minor - 1e-8);
  const lastIndex = Math.floor((props.first + props.span) / minor + 1e-8);
  return Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) => {
    const index = firstIndex + offset;
    const time = index * minor;
    const position = (time - props.first) / props.span;
    return { index, position, label: index % divisions === 0 ? recordingTime(Math.round(time * 100) / 100, major < 1) : '' };
  });
});

onMounted(() => {
  resize = new ResizeObserver(([entry]) => { width.value = entry.contentRect.width; });
  resize.observe(ruler.value!);
});
onScopeDispose(() => resize?.disconnect());
</script>

<template>
  <div ref="ruler" class="time-ruler" aria-hidden="true">
    <span v-for="tick in ticks" :key="tick.index" class="tick" :class="{ major: tick.label }" :style="{ left: tick.position * 100 + '%' }">
      <span v-if="tick.label" class="tick-label" :class="{ leading: tick.position * width < 32, trailing: (1 - tick.position) * width < 32 }">{{ tick.label }}</span>
    </span>
  </div>
</template>

<style scoped>
.time-ruler { position: relative; height: 19px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 12px; pointer-events: none; }
.tick { position: absolute; top: 0; height: 3px; border-left: 1px solid var(--border); }
.tick.major { height: 5px; border-color: var(--subtle); }
.tick-label { position: absolute; top: 5px; left: 0; transform: translateX(-50%); white-space: nowrap; }
.tick-label.leading { transform: none; }
.tick-label.trailing { transform: translateX(-100%); }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { recordingTime } from '../../recording/recordingTime';

type Marker = 'cursor' | 'start' | 'end';
const props = defineProps<{ duration: number; cursor: number; start: number; end: number; editing: boolean; disabled: boolean }>();
const emit = defineEmits<{ position: [marker: Marker, seconds: number, precise: boolean]; step: [marker: Marker, direction: number] }>();
const track = ref<HTMLElement | null>(null);
const drag = ref<Marker | null>(null);
const first = ref(0);
const span = ref(0);
watch(() => props.duration, seconds => { first.value = 0; span.value = seconds; }, { immediate: true });
const marks = computed(() => props.editing ? (['start', 'end', 'cursor'] as const) : (['cursor'] as const));
const labels = { start: '片段起点', end: '片段终点', cursor: '播放游标' };
const fraction = (seconds: number) => span.value ? Math.max(0, Math.min(1, (seconds - first.value) / span.value)) : 0;
function pointerFraction(event: MouseEvent) {
  const rect = track.value!.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}
function move(event: PointerEvent, precise: boolean) {
  if (drag.value && track.value?.hasPointerCapture(event.pointerId))
    emit('position', drag.value, first.value + span.value * pointerFraction(event), precise);
}
function begin(event: PointerEvent) {
  if (event.button !== 0 || props.disabled || !props.duration || drag.value) return;
  const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-marker]');
  drag.value = marker?.dataset.marker === 'start' || marker?.dataset.marker === 'end' ? marker.dataset.marker : 'cursor';
  track.value!.setPointerCapture(event.pointerId);
  track.value!.querySelector<HTMLElement>(`[data-marker="${drag.value}"]`)?.focus({ preventScroll: true });
  move(event, true);
}
function zoom(event: WheelEvent) {
  if (!span.value || drag.value || !event.deltaY) return;
  const ratio = pointerFraction(event);
  const anchor = first.value + ratio * span.value;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1);
  const scale = Math.exp(Math.max(-400, Math.min(400, delta)) * 0.0025);
  span.value = Math.min(props.duration, Math.max(1, span.value * scale));
  // 缩放时保持鼠标下的时间点，游标和选区始终使用原片时间。
  first.value = Math.max(0, Math.min(props.duration - span.value, anchor - ratio * span.value));
}
function reveal(seconds: number) {
  if (seconds < first.value || seconds > first.value + span.value)
    first.value = Math.max(0, Math.min(props.duration - span.value, seconds - span.value / 3));
}
defineExpose({ reveal });
</script>

<template>
  <div ref="track" class="timeline" @wheel.prevent="zoom" @pointerdown.prevent="begin" @pointermove="move($event, false)"
    @pointerup="move($event, true)" @lostpointercapture="drag = null">
    <div class="rail"><div class="fill" :class="{ selected: editing }" :style="editing
      ? { left: fraction(start) * 100 + '%', width: (fraction(end) - fraction(start)) * 100 + '%' }
      : { width: fraction(cursor) * 100 + '%' }" /></div>
    <template v-for="marker in marks" :key="marker">
      <span v-show="props[marker] >= first && props[marker] <= first + span + 0.000001" :data-marker="marker"
        role="slider" :tabindex="disabled ? -1 : 0" :aria-label="labels[marker]" :aria-disabled="disabled"
        :aria-valuemin="0" :aria-valuemax="duration" :aria-valuenow="props[marker]" :aria-valuetext="recordingTime(props[marker], true)"
        :style="{ left: fraction(props[marker]) * 100 + '%' }"
        @keydown.left.prevent.stop="emit('step', marker, -1)" @keydown.right.prevent.stop="emit('step', marker, 1)">
        <small v-if="drag === marker">{{ recordingTime(props[marker], true) }}</small>
      </span>
    </template>
    <div v-if="span < duration" class="bounds"><span>{{ recordingTime(first, true) }}</span><span>{{ recordingTime(first + span, true) }}</span></div>
  </div>
</template>

<style scoped>
.timeline { height: 38px; position: relative; margin: 0 7px; touch-action: none; user-select: none; cursor: pointer; }
.rail,.fill { position: absolute; top: 16px; height: 4px; border-radius: 4px; background: var(--border); width: 100%; }
.fill { top: 0; background: var(--muted); }.fill.selected { background: var(--accent); }
[data-marker] { position: absolute; top: 13px; height: 22px; width: 20px; transform: translateX(-50%); cursor: pointer; }
[data-marker]::before { content: ''; display: block; margin: 0 auto; height: 15px; width: 8px; background: var(--text); border-radius: 2px; }
[data-marker=cursor] { top: 0; height: 17px; }
[data-marker=cursor]::before { margin-top: 5px; width: 9px; height: 7px; clip-path: polygon(0 0,100% 0,50% 100%); }
[data-marker=cursor]::after { content: ''; position: absolute; top: 10px; left: 9px; width: 2px; height: 12px; background: var(--text); pointer-events: none; }
small { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 2px 6px; border-radius: 4px; background: #252c34; color: var(--text); white-space: nowrap; }
.bounds { position: absolute; inset: auto 0 0; display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; pointer-events: none; }
</style>

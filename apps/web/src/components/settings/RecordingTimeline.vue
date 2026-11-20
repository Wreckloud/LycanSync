<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { recordingTime } from '../../recording/recordingTime';
import RecordingFilmstrip from './RecordingFilmstrip.vue';
import TimeRuler from './TimeRuler.vue';

type Marker = 'cursor' | 'start' | 'end';
const props = defineProps<{ source: string; duration: number; cursor: number; start: number; end: number; editing: boolean; playing: boolean; disabled: boolean }>();
const emit = defineEmits<{ position: [marker: Marker, seconds: number, precise: boolean]; step: [marker: Marker, direction: number] }>();
const track = ref<HTMLElement | null>(null);
const drag = ref<Marker | null>(null);
let grabOffset = 0;
const first = ref(0);
const span = ref(0);
watch(() => [props.duration, props.editing], () => { first.value = 0; span.value = props.duration; }, { immediate: true });
const marks = computed(() => props.editing ? (['start', 'end', 'cursor'] as const) : (['cursor'] as const));
const labels = { start: '片段起点', end: '片段终点', cursor: '播放游标' };
const fraction = (seconds: number) => span.value ? Math.max(0, Math.min(1, (seconds - first.value) / span.value)) : 0;
function pointerFraction(event: MouseEvent) {
  const rect = track.value!.getBoundingClientRect();
  return (event.clientX - rect.left) / rect.width;
}
function move(event: PointerEvent, precise: boolean) {
  if (!drag.value || !track.value?.hasPointerCapture(event.pointerId)) return;
  const relative = Math.max(0, Math.min(span.value, span.value * pointerFraction(event) + grabOffset));
  emit('position', drag.value, first.value + relative, precise);
}
function begin(event: PointerEvent) {
  if (event.button !== 0 || props.disabled || !props.duration || drag.value) return;
  const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-marker]');
  drag.value = marker?.dataset.marker === 'start' || marker?.dataset.marker === 'end' ? marker.dataset.marker : 'cursor';
  grabOffset = marker ? props[drag.value] - first.value - span.value * pointerFraction(event) : 0;
  track.value!.setPointerCapture(event.pointerId);
  track.value!.querySelector<HTMLElement>(`[data-marker="${drag.value}"]`)?.focus({ preventScroll: true });
  move(event, true);
}
function scrollTimeline(event: WheelEvent) {
  if (!props.editing || !track.value) return;
  if (event.ctrlKey) event.preventDefault();
  if (props.disabled || !span.value || drag.value) return;
  const width = track.value.getBoundingClientRect().width;
  if (!width) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
  if (!event.ctrlKey) {
    if (span.value >= props.duration) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    event.preventDefault();
    first.value = Math.max(0, Math.min(props.duration - span.value, first.value + delta * unit / width * span.value));
    return;
  }
  if (!event.deltaY) return;
  const ratio = Math.max(0, Math.min(1, pointerFraction(event)));
  const anchor = first.value + ratio * span.value;
  const delta = event.deltaY * unit;
  const scale = Math.exp(Math.max(-400, Math.min(400, delta)) * 0.0025);
  span.value = Math.min(props.duration, Math.max(1, span.value * scale));
  // 缩放时保持鼠标下的时间点，游标和选区始终使用原片时间。
  first.value = Math.max(0, Math.min(props.duration - span.value, anchor - ratio * span.value));
}
function reveal(seconds: number) {
  if (seconds < first.value || seconds > first.value + span.value)
    first.value = Math.max(0, Math.min(props.duration - span.value, seconds - span.value / 3));
}
function pan(event: Event) {
  first.value = (event.currentTarget as HTMLInputElement).valueAsNumber;
}
defineExpose({ reveal });
</script>

<template>
  <div class="timeline-panel" @wheel="scrollTimeline">
    <div ref="track" class="timeline" :class="{ editing }" :title="editing ? '滚轮平移，Ctrl + 滚轮缩放' : undefined"
      @pointerdown.prevent="begin" @pointermove="move($event, false)"
      @pointerup="move($event, true)" @lostpointercapture="drag = null">
      <div class="rail"><RecordingFilmstrip v-if="editing && duration > 0" :key="source" :source="source" :first="first" :span="span"
          :suspended="playing || disabled || drag !== null" />
        <div class="fill" :class="{ selected: editing }" :style="editing
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
      <TimeRuler v-if="editing" class="scale" :first="first" :span="span" />
    </div>
    <input v-if="editing && span > 0 && span < duration" class="viewport-scroll" type="range" aria-label="平移时间轴"
      min="0" :max="duration - span" step="any" :value="first" :disabled="disabled"
      :aria-valuetext="recordingTime(first, true) + ' 至 ' + recordingTime(first + span, true)"
      :style="{ '--thumb-width': (span / duration * 100) + '%', '--clip-start': (start / duration * 100) + '%', '--clip-end': (end / duration * 100) + '%' }" @input="pan"
      @keydown.left.stop @keydown.right.stop @keydown.space.stop />
  </div>
</template>

<style scoped>
.timeline-panel { position: relative; margin: 0 12px; }
.timeline { height: 38px; position: relative; touch-action: none; user-select: none; cursor: default; }
.rail,.fill { position: absolute; top: 16px; height: 4px; border-radius: 4px; background: var(--border); width: 100%; }
.fill { top: 0; background: var(--muted); }.fill.selected { background: var(--accent); }
[data-marker] { position: absolute; top: 7px; height: 22px; width: 20px; transform: translateX(-50%); cursor: default; }
[data-marker]::before { content: ''; display: block; margin: 0 auto; height: 15px; width: 8px; background: var(--text); border-radius: 2px; }
.timeline:not(.editing) [data-marker=cursor]::before { margin-top: 4px; width: 6px; height: 14px; }
small { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 2px 6px; border-radius: 4px; background: #252c34; color: var(--text); white-space: nowrap; }
.timeline.editing { --strip-top: 18px; --strip-height: clamp(34px, 6.5vh, 54px); height: calc(var(--strip-top) + var(--strip-height) + 42px); }
.scale { position: absolute; inset: calc(var(--strip-top) + var(--strip-height) + 3px) 0 auto; }
.viewport-scroll { position: absolute; inset: auto 0 1px; appearance: none; width: 100%; height: 15px; margin: 0; padding: 0; border: 0; background: transparent; cursor: default; }
.viewport-scroll::-webkit-slider-runnable-track {
  height: 5px; border-radius: 3px;
  background: linear-gradient(to right, var(--panel-raised) 0 var(--clip-start), var(--accent) var(--clip-start) var(--clip-end), var(--panel-raised) var(--clip-end) 100%);
}
.viewport-scroll::-webkit-slider-thumb { appearance: none; width: max(24px, var(--thumb-width)); height: 9px; margin-top: -2px; border: 1px solid var(--subtle); border-radius: 3px; background: color-mix(in srgb, var(--muted) 28%, transparent); }
.viewport-scroll:is(:hover, :focus-visible)::-webkit-slider-thumb { border-color: var(--muted); }
.editing .rail { top: var(--strip-top); height: var(--strip-height); overflow: hidden; }
.editing .fill.selected { height: 100%; box-sizing: border-box; border-block: 1px solid var(--accent); border-radius: 0; background: transparent; box-shadow: 0 0 0 100vw #080a0cb0; }
.editing :is([data-marker=start], [data-marker=end]) { top: var(--strip-top); height: var(--strip-height); width: 18px; z-index: 1; }
.editing :is([data-marker=start], [data-marker=end])::before { position: absolute; height: 100%; width: 9px; background: var(--accent); }
.editing :is([data-marker=start], [data-marker=end])::after { content: ''; position: absolute; top: 34%; bottom: 34%; width: 2px; border-radius: 1px; background: var(--text); }
.editing [data-marker=start] { transform: translateX(-100%); }
.editing [data-marker=start]::before { right: 0; border-radius: 3px 0 0 3px; }
.editing [data-marker=start]::after { right: 3.5px; }
.editing [data-marker=end] { transform: none; }
.editing [data-marker=end]::before { left: 0; border-radius: 0 3px 3px 0; }
.editing [data-marker=end]::after { left: 3.5px; }
.editing [data-marker=cursor] { top: 0; z-index: 2; height: var(--strip-top); }
.editing [data-marker=cursor]::before { margin-top: 2px; width: 10px; height: 14px; clip-path: polygon(0 0,100% 0,100% 70%,50% 100%,0 70%); }
.editing [data-marker=cursor]::after { content: ''; position: absolute; top: 15px; left: calc(50% - 1px); width: 2px; height: calc(var(--strip-top) + var(--strip-height) - 15px); background: var(--text); pointer-events: none; }
</style>

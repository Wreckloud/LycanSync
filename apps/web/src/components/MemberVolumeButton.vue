<script setup lang="ts">
import { ref } from 'vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, normalizeAudioVolume } from '../rtc/audioPreferences';

const props = withDefaults(defineProps<{ volume: number; label: string; max?: number; sliderLabel?: string }>(), { max: AUDIO_VOLUME_MAX });
const emit = defineEmits<{ toggle: []; change: [volume: number] }>();
const dragging = ref(false);
let gesture: { id: number; x: number; y: number; initial: number } | undefined;
let suppressClick = false;
let wheelPixels = 0;

function change(value: number) {
  const next = normalizeAudioVolume(value, props.max);
  if (next !== props.volume) emit('change', next);
}

function wheel(event: WheelEvent) {
  if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  event.stopPropagation();
  if (gesture) return;
  const delta = event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * 24;
  if (Math.sign(delta) !== Math.sign(wheelPixels)) wheelPixels = 0;
  wheelPixels += delta;
  if (Math.abs(wheelPixels) >= 24) {
    change(props.volume - Math.sign(wheelPixels) * AUDIO_VOLUME_STEP);
    wheelPixels = 0;
  }
}

function begin(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || gesture) return;
  suppressClick = false;
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: props.volume };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function move(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.id) return;
  const upward = gesture.y - event.clientY;
  if (!dragging.value && Math.hypot(event.clientX - gesture.x, upward) < 3) return;
  dragging.value = true;
  // 在屏幕边缘也能用剩余行程调到端点。
  const viewport = (event.currentTarget as HTMLElement).ownerDocument.documentElement;
  const available = upward > 0 ? gesture.y : viewport.clientHeight - gesture.y - 1;
  const range = upward > 0 ? props.max - gesture.initial : gesture.initial;
  const distance = Math.max(1, Math.min(available, 84 * range / props.max));
  change(gesture.initial + upward * range / distance);
}

function finish(event: PointerEvent) {
  if (event.pointerId !== gesture?.id) return;
  if (event.type === 'pointerup') move(event);
  suppressClick = dragging.value || event.type !== 'pointerup';
  dragging.value = false;
  gesture = undefined;
}

function click(event: MouseEvent) {
  if (!suppressClick || event.detail === 0) emit('toggle');
  suppressClick = false;
}
</script>

<template>
  <span v-if="sliderLabel" class="inline-volume" @wheel="wheel" @pointerleave="wheelPixels = 0">
    <button type="button" :aria-label="label" :aria-pressed="volume === 0" @click.stop="emit('toggle')">
      <slot />
    </button>
    <input class="inline-volume-slider" type="range" min="0" :max="max" :step="AUDIO_VOLUME_STEP" :value="volume"
      :aria-label="sliderLabel" :aria-valuetext="Math.round(volume * 100) + '%'"
      @input="change(($event.target as HTMLInputElement).valueAsNumber)" />
  </span>
  <button v-else type="button" class="participant-state participant-state-button volume-button"
    :class="{ 'is-off': volume === 0, 'is-dragging': dragging }" :aria-label="label"
    :aria-pressed="volume === 0" :aria-description="`当前音量 ${Math.round(volume * 100)}%，上下拖动、滚轮或上下方向键可调整音量`"
    @pointerdown="begin" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish"
    @pointerleave="wheelPixels = 0" @click.stop="click" @contextmenu.prevent @wheel="wheel"
    @keydown.up.prevent="change(volume + AUDIO_VOLUME_STEP)" @keydown.down.prevent="change(volume - AUDIO_VOLUME_STEP)">
    <slot />
    <svg class="volume-ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="11.5" />
      <circle class="ring-value" cx="14" cy="14" r="11.5" pathLength="1" stroke-dasharray="1 1"
        :stroke-dashoffset="1 - volume / max" transform="rotate(-90 14 14)" />
    </svg>
  </button>
</template>

<style scoped>
.inline-volume { position: relative; display: inline-flex; align-items: center; }
.inline-volume-slider { position: absolute; right: 100%; top: 50%; box-sizing: border-box; width: var(--view-volume-width, 84px); height: 24px; margin: 0; padding: 0 5px; translate: 0 -50%; border: 0; background: transparent; appearance: none; color: var(--text); opacity: 0; pointer-events: none; transform: scaleX(.85); transform-origin: right center; }
.inline-volume-slider::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--muted); }
.inline-volume-slider::-webkit-slider-thumb { appearance: none; width: 9px; height: 9px; margin-top: -3px; border-radius: 50%; background: currentColor; }
.inline-volume:is(:hover, :has(:focus-visible, :active)) .inline-volume-slider { opacity: 1; transform: none; pointer-events: auto; }
@media (hover: none) { .inline-volume-slider { opacity: 1; transform: none; pointer-events: auto; } }
@media (prefers-reduced-motion: no-preference) { .inline-volume-slider { transition: opacity var(--motion-surface-duration) ease, transform var(--motion-surface-duration) var(--motion-ease); } }
.volume-button { position: relative; width: 24px; height: 32px; margin: -6px -2px; touch-action: none; user-select: none; }
.volume-ring { position: absolute; left: 50%; top: 50%; translate: -50% -50%; pointer-events: none; fill: none; stroke: var(--border); stroke-width: 1.5; opacity: 0; scale: .8; }
.volume-ring .ring-value { stroke: var(--accent); }
.volume-button:is(:focus-visible, :active, .is-dragging) .volume-ring { opacity: 1; scale: 1; }
@media (hover: hover) { .volume-button:hover .volume-ring { opacity: 1; scale: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .volume-ring { transition: opacity 120ms var(--motion-ease), scale 120ms var(--motion-ease); }
}
</style>

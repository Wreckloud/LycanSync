<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, normalizeAudioVolume } from '../rtc/audioPreferences';

const props = withDefaults(defineProps<{ volume: number; label: string; disabled?: boolean; max?: number }>(), { max: AUDIO_VOLUME_MAX });
const emit = defineEmits<{ toggle: []; change: [volume: number] }>();
const button = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const draft = ref(0);
const left = ref(0);
const top = ref(0);
const height = ref(144);
const origin = ref(0);
const percent = computed(() => Math.round(draft.value * 100));
let timer: ReturnType<typeof setTimeout> | undefined;
let pointer: number | undefined;
let startX = 0;
let startY = 0;
let initial = 0;
let suppressClick = false;
let wheelPixels = 0;

function positionPopup(target: HTMLButtonElement) {
  const rect = target.getBoundingClientRect();
  const viewport = target.ownerDocument.documentElement;
  left.value = Math.max(24, Math.min(rect.left + rect.width / 2, viewport.clientWidth - 24));
  height.value = Math.min(144, viewport.clientHeight - 24);
  const center = rect.top + rect.height / 2;
  top.value = Math.max(12, Math.min(center - height.value * (1 - props.volume / props.max),
    viewport.clientHeight - height.value - 12));
  origin.value = center - top.value;
}

function closePopup() {
  clearTimeout(timer);
  open.value = false;
  wheelPixels = 0;
}

function wheel(event: WheelEvent) {
  if (props.disabled || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  event.stopPropagation();
  if (pointer !== undefined || !button.value) return;
  if (!open.value) positionPopup(button.value);
  open.value = true;
  // 普通滚轮每次一档；触控板的细小像素增量累积到一档再生效。
  const threshold = 24;
  const delta = event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * threshold;
  if (Math.sign(delta) !== Math.sign(wheelPixels)) wheelPixels = 0;
  wheelPixels += delta;
  draft.value = props.volume;
  if (Math.abs(wheelPixels) >= threshold) {
    draft.value = normalizeAudioVolume(props.volume - Math.sign(wheelPixels) * AUDIO_VOLUME_STEP, props.max);
    wheelPixels = 0;
    if (draft.value !== props.volume) emit('change', draft.value);
  }
  clearTimeout(timer);
  timer = setTimeout(closePopup, 700);
}

function begin(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || pointer !== undefined || !button.value) return;
  closePopup();
  suppressClick = false;
  const target = button.value;
  positionPopup(target);
  initial = draft.value = props.volume;
  startY = event.clientY;
  startX = event.clientX;
  pointer = event.pointerId;
  target.setPointerCapture(pointer);
  timer = setTimeout(() => { open.value = true; suppressClick = true; }, 300);
}

function move(event: PointerEvent) {
  if (event.pointerId !== pointer) return;
  if (!open.value) {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) end();
    return;
  }
  const travel = startY - event.clientY;
  // 靠近窗口边缘时，剩余的鼠标行程也应能调到端点。
  const distance = travel > 0 ? startY : button.value!.ownerDocument.documentElement.clientHeight - startY - 1;
  const range = travel > 0 ? props.max - initial : initial;
  const pixels = Math.max(1, Math.min(distance, height.value * range / props.max));
  draft.value = normalizeAudioVolume(initial + travel / pixels * range, props.max);
}

function end(event?: PointerEvent, commit = false) {
  if (event && event.pointerId !== pointer) return;
  if (pointer === undefined) { closePopup(); return; }
  if (open.value && commit && event) {
    move(event);
    if (draft.value !== initial) emit('change', draft.value);
  }
  if (!commit) suppressClick = true;
  const id = pointer;
  pointer = undefined;
  closePopup();
  if (button.value?.hasPointerCapture(id)) button.value.releasePointerCapture(id);
}

function click(event: MouseEvent) {
  if (!suppressClick || event.detail === 0) emit('toggle');
  suppressClick = false;
}

watch(() => props.disabled, (disabled) => { if (disabled) end(); });
onScopeDispose(() => end());
</script>

<template>
  <button ref="button" type="button" class="participant-state participant-state-button volume-button"
    :class="{ 'is-off': disabled || volume === 0 }" :disabled="disabled" :aria-label="label"
    :aria-pressed="volume === 0" aria-description="滚轮、长按拖动或上下方向键可调整音量"
    @pointerdown="begin" @pointermove="move" @pointerup="end($event, true)" @pointercancel="end($event)"
    @lostpointercapture="end($event)" @click.stop="click" @contextmenu.prevent @wheel="wheel"
    @keydown.up.prevent="emit('change', normalizeAudioVolume(volume + AUDIO_VOLUME_STEP, max))"
    @keydown.down.prevent="emit('change', normalizeAudioVolume(volume - AUDIO_VOLUME_STEP, max))" @keydown.esc="end()">
    <slot />
  </button>
  <Teleport v-if="button" :to="button.ownerDocument.body">
    <Transition name="volume-pop">
      <div v-if="open" class="volume-popup" aria-hidden="true"
        :style="{ left: left + 'px', top: top + 'px', height: height + 'px', transformOrigin: '50% ' + origin + 'px' }">
        <span class="volume-track"><i :style="{ height: percent / max + '%' }" /></span>
        <output>{{ percent }}%</output>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.volume-button { touch-action: none; user-select: none; }
.volume-popup { position: fixed; z-index: 50; width: 40px; margin-left: -20px; pointer-events: none; border-radius: 8px; background: var(--panel-soft); border: 1px solid var(--border); box-shadow: 0 4px 14px #0005; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 9px 2px 5px; color: var(--text); }
.volume-track { display: flex; align-items: end; flex: 1; width: 4px; border-radius: 4px; background: var(--border); }
.volume-track i { position: relative; width: 100%; border-radius: inherit; background: var(--accent); }
.volume-track i::before { content: ''; position: absolute; top: -3px; left: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--text); }
.volume-popup output { font-size: 11px; font-variant-numeric: tabular-nums; }
.volume-pop-enter-active, .volume-pop-leave-active { transition: transform var(--motion-surface-duration) var(--motion-ease), opacity var(--motion-surface-duration) ease; }
.volume-pop-enter-from, .volume-pop-leave-to { transform: scaleY(.05); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .volume-pop-enter-active, .volume-pop-leave-active { transition: none; } }
</style>

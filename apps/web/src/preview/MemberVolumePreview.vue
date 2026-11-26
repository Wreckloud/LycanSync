<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { MicOff, Monitor, Volume2, VolumeX } from '@lucide/vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, SHARE_VOLUME_MAX, normalizeAudioVolume } from '../rtc/audioPreferences';

type Channel = 'voice' | 'share';
const modes = [
  { id: 'ticks', label: '两侧刻度' }, { id: 'ring', label: '图标环' }, { id: 'line', label: '底部细线' },
] as const;
const mode = ref<typeof modes[number]['id']>('ring');
const presets = [{ value: .25, label: '轻声' }, { value: 1, label: '原声' }, { value: 1.75, label: '增强' }];
const atEdge = ref(false), mutedMic = ref(true), sharing = ref(true);
const channels = computed<Channel[]>(() => sharing.value ? ['share', 'voice'] : ['voice']);
const names = { voice: '成员语音', share: '共享声音' };
const maxima = { voice: AUDIO_VOLUME_MAX, share: SHARE_VOLUME_MAX };
const volume = ref({ voice: .25, share: .25 });
const lastAudible = { ...volume.value };
const active = ref<Channel>();
// 手势行程独立于图形宽度，短刻度仍然允许稳定拖动。
const dragTravel = 84;
let timer: ReturnType<typeof setTimeout> | undefined;
let iconDrag: { id: number; x: number; y: number; initial: number; moved: boolean } | undefined;
let suppressClick = false;
let wheelPixels = 0;

function setVolume(channel: Channel, value: number) {
  const next = normalizeAudioVolume(value, maxima[channel]);
  volume.value[channel] = next;
  if (next > 0) lastAudible[channel] = next;
}
function close() {
  clearTimeout(timer);
  active.value = undefined;
  wheelPixels = 0;
}
function show(channel: Channel) {
  clearTimeout(timer);
  if (active.value !== channel) wheelPixels = 0;
  active.value = channel;
}
function enter(channel: Channel, event: PointerEvent) {
  if (event.pointerType === 'touch' || iconDrag) return;
  if (mode.value === 'ring') { show(channel); return; }
  clearTimeout(timer);
  timer = setTimeout(() => show(channel), 180);
}
function leave(event: PointerEvent) {
  if (iconDrag) return;
  clearTimeout(timer);
  if ((event.currentTarget as HTMLElement).matches(':focus-visible')) return;
  if (mode.value === 'ring') close();
  else timer = setTimeout(close, 250);
}
function arrow(channel: Channel, event: KeyboardEvent) {
  const maximum = maxima[channel];
  const values: Record<string, number> = {
    ArrowLeft: volume.value[channel] - AUDIO_VOLUME_STEP, ArrowDown: volume.value[channel] - AUDIO_VOLUME_STEP,
    ArrowRight: volume.value[channel] + AUDIO_VOLUME_STEP, ArrowUp: volume.value[channel] + AUDIO_VOLUME_STEP,
    Home: 0, End: maximum,
  };
  if (!(event.key in values)) return;
  event.preventDefault();
  show(channel);
  setVolume(channel, values[event.key]!);
}
function begin(channel: Channel, event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  const button = event.currentTarget as HTMLElement;
  show(channel);
  suppressClick = false;
  iconDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: volume.value[channel], moved: false };
  button.setPointerCapture(event.pointerId);
}
function move(channel: Channel, event: PointerEvent) {
  if (!iconDrag || iconDrag.id !== event.pointerId) return;
  const upward = iconDrag.y - event.clientY;
  if (!iconDrag.moved && Math.hypot(event.clientX - iconDrag.x, upward) < 3) return;
  iconDrag.moved = true;
  const available = upward > 0 ? iconDrag.y : document.documentElement.clientHeight - iconDrag.y - 1;
  const remaining = upward > 0 ? maxima[channel] - iconDrag.initial : iconDrag.initial;
  const distance = Math.max(1, Math.min(available, dragTravel * remaining / maxima[channel]));
  setVolume(channel, iconDrag.initial + upward * remaining / distance);
}
function finish(channel: Channel, event: PointerEvent) {
  if (!iconDrag || iconDrag.id !== event.pointerId) return;
  suppressClick = iconDrag.moved || event.type !== 'pointerup';
  // 触屏拖动后浏览器可能省略下一次合成 click，轻点在抬手时只结算一次。
  if (!suppressClick && event.pointerType === 'touch') {
    toggleMute(channel);
    suppressClick = true;
  }
  iconDrag = undefined;
  const target = event.currentTarget as HTMLElement;
  if (event.pointerType === 'touch' || !target.matches(':hover, :focus-visible')) timer = setTimeout(close, 250);
}
function toggleMute(channel: Channel) {
  setVolume(channel, volume.value[channel] ? 0 : lastAudible[channel]);
}
function click(channel: Channel, event: MouseEvent) {
  if (!suppressClick || event.detail === 0) toggleMute(channel);
  suppressClick = false;
}
function wheel(channel: Channel, event: WheelEvent) {
  if (iconDrag || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  show(channel);
  const delta = event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * 24;
  if (Math.sign(wheelPixels) !== Math.sign(delta)) wheelPixels = 0;
  wheelPixels += delta;
  if (Math.abs(wheelPixels) >= 24) {
    setVolume(channel, volume.value[channel] - Math.sign(wheelPixels) * AUDIO_VOLUME_STEP);
    wheelPixels = 0;
  }
}
watch([mode, sharing, atEdge], close, { flush: 'sync' });
onScopeDispose(close);
</script>

<template>
  <section class="volume-lab" aria-labelledby="volume-title">
    <h1 id="volume-title">成员卡片音量</h1>
    <SegmentedControl v-model="mode" :options="modes" label="展开方式" />
    <p>按住图标向上拖增大音量，向下拖减小。滚轮微调，单击静音或恢复。</p>
    <div class="volume-stage" :class="{ 'at-edge': atEdge }">
      <article class="participant-card">
        <div class="participant-media">
          <Monitor v-if="sharing" :size="34" aria-label="模拟共享画面" />
          <span v-else class="large-avatar">林</span>
          <MicOff v-if="mutedMic" class="muted-badge" :size="20" aria-label="对方已闭麦" />
        </div>
        <div class="participant-meta">
          <strong class="participant-name">林间</strong>
          <button v-for="channel in channels" :key="channel" type="button"
            class="participant-state participant-state-button volume-control" :class="{ 'is-off': volume[channel] === 0 }"
            :aria-label="names[channel] + '，' + Math.round(volume[channel] * 100) + '%'" :aria-pressed="volume[channel] === 0"
            aria-description="向上拖动增大音量，向下拖动减小音量，滚轮或方向键微调，单击静音或恢复"
            @pointerenter="enter(channel, $event)" @pointerleave="leave" @wheel="wheel(channel, $event)"
            @focus="($event.currentTarget as HTMLElement).matches(':focus-visible') && show(channel)" @blur="close"
            @keydown="arrow(channel, $event)" @keydown.esc.prevent="close"
            @pointerdown="begin(channel, $event)" @pointermove="move(channel, $event)"
            @pointerup="finish(channel, $event)" @pointercancel="finish(channel, $event)" @lostpointercapture="finish(channel, $event)" @click="click(channel, $event)">
            <template v-if="channel === 'voice'"><MicOff v-if="mutedMic || !volume.voice" :size="14" /><VoiceLevelMic v-else :level="0" :size="14" /></template>
            <template v-else><Volume2 v-if="volume.share" :size="14" /><VolumeX v-else :size="14" /></template>
            <Transition name="volume-feedback">
              <span v-if="active === channel" class="volume-mark" :class="mode" aria-hidden="true"
                :style="{ '--level': volume[channel] / maxima[channel] }">
                <template v-if="mode === 'ticks'">
                  <span v-for="side in ['left', 'right']" :key="side" class="tick-bank" :class="side">
                    <i v-for="n in 5" :key="n" :style="{ '--tick': n }" />
                  </span>
                </template>
                <svg v-else-if="mode === 'ring'" width="28" height="28" viewBox="0 0 28 28">
                  <circle class="ring-track" cx="14" cy="14" r="11.5" />
                  <circle class="ring-value" cx="14" cy="14" r="11.5" pathLength="1" stroke-dasharray="1 1"
                    :stroke-dashoffset="1 - volume[channel] / maxima[channel]" transform="rotate(-90 14 14)" />
                </svg>
                <span v-else class="line-track"><i /></span>
              </span>
            </Transition>
          </button>
        </div>
      </article>
    </div>
    <div class="volume-options">
      <div class="preview-actions"><span>语音起始音量</span>
        <button v-for="preset in presets" :key="preset.value" type="button" :aria-pressed="volume.voice === preset.value"
          @click="setVolume('voice', preset.value)">{{ preset.label }}</button>
      </div>
      <label><input v-model="mutedMic" type="checkbox" /> 对方闭麦</label>
      <label><input v-model="sharing" type="checkbox" /> 同时共享声音</label>
      <label><input v-model="atEdge" type="checkbox" /> 卡片靠右</label>
    </div>
  </section>
</template>

<style scoped>
.volume-lab { padding: 24px 0; }
.volume-lab > :is(h1, p, .segmented-control, .volume-options) { margin-inline: auto; }
.volume-lab > :is(h1, p) { text-align: center; }
.volume-lab h1 { margin: 0 0 12px; font-size: 22px; }
.volume-lab p, .volume-options { color: var(--muted); }
.volume-lab :deep(.segmented-control) { width: fit-content; }
.volume-stage { display: flex; justify-content: center; margin-block: 22px 54px; }
.volume-stage.at-edge { justify-content: flex-end; }
.volume-stage .participant-card { width: 220px; overflow: visible; }
.participant-media { aspect-ratio: 16/9; border-radius: 4px 4px 0 0; color: var(--muted); }
.muted-badge { position: absolute; right: 8px; bottom: 6px; padding: 3px; color: var(--text); background: var(--panel); border-radius: 4px; }
/* 命中区增大，外边距抵消新增尺寸，底栏仍按原先的 20px 排版。 */
.volume-control { position: relative; width: 24px; height: 32px; margin: -6px -2px; touch-action: none; user-select: none; }
.volume-control:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.volume-mark { position: absolute; top: 50%; left: 50%; translate: -50% -50%; pointer-events: none; color: var(--text); }
.volume-mark.ticks { width: 48px; height: 12px; display: flex; align-items: center; justify-content: space-between; }
.tick-bank { display: flex; align-items: center; gap: 1px; background: var(--panel); }
.tick-bank.left { flex-direction: row-reverse; }
.tick-bank i { width: 2px; height: 6px; background: var(--text); opacity: clamp(.17, calc(.17 + (var(--level) * 5 - var(--tick) + 1) * .83), 1); }
.volume-mark.ring, .volume-mark.ring svg { display: block; width: 28px; height: 28px; }
.volume-mark circle { fill: none; stroke-width: 1.5; }
.ring-track { stroke: var(--border); }
.ring-value { stroke: var(--accent); }
.volume-mark.line { width: 50px; height: 24px; display: flex; align-items: end; }
.line-track { width: 100%; height: 2px; background: var(--border); }
.line-track i { display: block; height: 100%; background: var(--muted); transform-origin: left; transform: scaleX(var(--level)); }
@media (prefers-reduced-motion: no-preference) {
  .volume-feedback-enter-active, .volume-feedback-leave-active { transition: opacity 120ms var(--motion-ease), scale 120ms var(--motion-ease); }
  .volume-feedback-enter-from, .volume-feedback-leave-to { opacity: 0; scale: .8; }
}
.volume-options { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px 22px; align-items: center; }
.volume-options button[aria-pressed=true] { border-color: var(--accent); }
</style>

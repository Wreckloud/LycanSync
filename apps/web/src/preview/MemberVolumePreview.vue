<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { MicOff, Monitor, Volume2, VolumeX } from '@lucide/vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, SHARE_VOLUME_MAX, normalizeAudioVolume } from '../rtc/audioPreferences';

type Channel = 'voice' | 'share';
const modes = [{ id: 'center', label: 'A · 轨道居中' }, { id: 'thumb', label: 'B · 滑块居中' }] as const;
const mode = ref<'center' | 'thumb'>('center');
const atEdge = ref(false), mutedMic = ref(false), sharing = ref(false);
const channels = computed<Channel[]>(() => sharing.value ? ['share', 'voice'] : ['voice']);
const names = { voice: '成员语音', share: '共享声音' };
const maxima = { voice: AUDIO_VOLUME_MAX, share: SHARE_VOLUME_MAX };
const volume = ref({ voice: .25, share: .25 });
const lastAudible = { ...volume.value };
const active = ref<Channel>();
const popupLeft = ref(0);
const trackWidth = 148, thumbRadius = 7, panelPadding = 8, panelWidth = 214;
const travel = trackWidth - 2 * thumbRadius;
let timer: ReturnType<typeof setTimeout> | undefined;
let iconDrag: { id: number; x: number; initial: number; moved: boolean } | undefined;
let rangeDrag = false, suppressClick = false;
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
function show(channel: Channel, anchor: HTMLElement) {
  clearTimeout(timer);
  if (active.value === channel) return;
  const rect = anchor.getBoundingClientRect();
  const ratio = mode.value === 'center' ? .5 : volume.value[channel] / maxima[channel];
  const preferred = rect.left + rect.width / 2 - panelPadding - thumbRadius - travel * ratio;
  popupLeft.value = Math.max(4, Math.min(preferred, document.documentElement.clientWidth - panelWidth - 4)) - rect.left;
  wheelPixels = 0;
  active.value = channel;
}
function enter(channel: Channel, event: PointerEvent) {
  if (event.pointerType === 'touch' || iconDrag || rangeDrag) return;
  clearTimeout(timer);
  const anchor = event.currentTarget as HTMLElement;
  if (active.value !== channel) timer = setTimeout(() => show(channel, anchor), 250);
}
function leave(event: PointerEvent) {
  if (iconDrag || rangeDrag) return;
  clearTimeout(timer);
  const wrapper = event.currentTarget as HTMLElement;
  if (!wrapper.querySelector(':focus-visible')) timer = setTimeout(close, 250);
}
function begin(channel: Channel, event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  const button = event.currentTarget as HTMLElement;
  show(channel, button.parentElement!);
  suppressClick = false;
  iconDrag = { id: event.pointerId, x: event.clientX, initial: volume.value[channel], moved: false };
  button.setPointerCapture(event.pointerId);
}
function move(channel: Channel, event: PointerEvent) {
  if (!iconDrag || iconDrag.id !== event.pointerId) return;
  const dx = event.clientX - iconDrag.x;
  if (!iconDrag.moved && Math.abs(dx) < 3) return;
  iconDrag.moved = true;
  const available = dx > 0 ? document.documentElement.clientWidth - iconDrag.x - 1 : iconDrag.x;
  const remaining = dx > 0 ? maxima[channel] - iconDrag.initial : iconDrag.initial;
  const distance = Math.max(1, Math.min(available, travel * remaining / maxima[channel]));
  setVolume(channel, iconDrag.initial + dx * remaining / distance);
}
function finish(event: PointerEvent) {
  if (!iconDrag || iconDrag.id !== event.pointerId) return;
  suppressClick = iconDrag.moved || event.type !== 'pointerup';
  iconDrag = undefined;
  const wrapper = (event.currentTarget as HTMLElement).parentElement!;
  if (!wrapper.matches(':hover') && !wrapper.querySelector(':focus-visible')) timer = setTimeout(close, 250);
}
function toggle(channel: Channel, event: MouseEvent) {
  if (!suppressClick || event.detail === 0) setVolume(channel, volume.value[channel] ? 0 : lastAudible[channel]);
  suppressClick = false;
}
function wheel(channel: Channel, event: WheelEvent) {
  if (iconDrag || rangeDrag || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  show(channel, event.currentTarget as HTMLElement);
  const delta = event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * 24;
  if (Math.sign(wheelPixels) !== Math.sign(delta)) wheelPixels = 0;
  wheelPixels += delta;
  if (Math.abs(wheelPixels) >= 24) {
    setVolume(channel, volume.value[channel] - Math.sign(wheelPixels) * AUDIO_VOLUME_STEP);
    wheelPixels = 0;
  }
}
function blur(event: FocusEvent) {
  const wrapper = event.currentTarget as HTMLElement;
  if (!wrapper.contains(event.relatedTarget as Node | null) && !iconDrag && !rangeDrag) close();
}
function endRange(event: PointerEvent) {
  rangeDrag = false;
  const wrapper = (event.currentTarget as HTMLElement).closest('.volume-anchor');
  if (!wrapper?.matches(':hover') && !wrapper?.querySelector(':focus-visible')) close();
}
function beginRange() { rangeDrag = true; }
function escape(event: KeyboardEvent) {
  (event.currentTarget as HTMLElement).querySelector('button')?.focus();
  close();
}
watch([mode, sharing, atEdge], close, { flush: 'sync' });
window.addEventListener('resize', close);
onScopeDispose(() => { clearTimeout(timer); window.removeEventListener('resize', close); });
</script>

<template>
  <section class="volume-lab" aria-labelledby="volume-title">
    <h1 id="volume-title">成员卡片音量</h1>
    <SegmentedControl v-model="mode" :options="modes" label="展开方式" />
    <p>把鼠标停在麦克风上，或直接按住左右拖动。单击静音，再点恢复。</p>
    <div class="volume-stage" :class="{ 'at-edge': atEdge }">
      <article class="participant-card">
        <div class="participant-media">
          <Monitor v-if="sharing" :size="34" aria-label="模拟共享画面" />
          <span v-else class="large-avatar">林</span>
          <MicOff v-if="mutedMic" class="muted-badge" :size="20" aria-label="对方已闭麦" />
        </div>
        <div class="participant-meta">
          <strong class="participant-name">林间</strong>
          <div v-for="channel in channels" :key="channel" class="volume-anchor"
            @pointerenter="enter(channel, $event)" @pointerleave="leave" @focusout="blur"
            @wheel="wheel(channel, $event)" @keydown.esc.prevent="escape">
            <button type="button" class="participant-state participant-state-button" :class="{ 'is-off': volume[channel] === 0 }"
              :aria-label="names[channel] + '，' + Math.round(volume[channel] * 100) + '%'" :aria-pressed="volume[channel] === 0"
              :aria-expanded="active === channel" @focus="show(channel, ($event.currentTarget as HTMLElement).parentElement!)"
              @pointerdown="begin(channel, $event)" @pointermove="move(channel, $event)"
              @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @click="toggle(channel, $event)">
              <template v-if="channel === 'voice'"><MicOff v-if="mutedMic || !volume.voice" :size="14" /><VoiceLevelMic v-else :level="0" :size="14" /></template>
              <template v-else><Volume2 v-if="volume.share" :size="14" /><VolumeX v-else :size="14" /></template>
            </button>
            <div v-if="active === channel" class="volume-panel" :style="{ left: popupLeft + 'px', width: panelWidth + 'px', paddingInline: panelPadding + 'px', '--anchor-x': 'calc(10px - ' + popupLeft + 'px)' }">
              <input type="range" min="0" :max="maxima[channel]" :step="AUDIO_VOLUME_STEP" :value="volume[channel]"
                :style="{ width: trackWidth + 'px' }" :aria-label="names[channel] + '音量'" :aria-valuetext="Math.round(volume[channel] * 100) + '%'"
                @input="setVolume(channel, ($event.target as HTMLInputElement).valueAsNumber)"
                @pointerdown="beginRange" @pointerup="endRange" @pointercancel="endRange" @lostpointercapture="endRange" />
              <output>{{ Math.round(volume[channel] * 100) }}%</output>
            </div>
          </div>
        </div>
      </article>
    </div>
    <div class="volume-options">
      <div class="preview-actions"><span>语音起始音量</span>
        <button v-for="preset in [25, 100, 175]" :key="preset" type="button" :aria-pressed="volume.voice === preset / 100"
          @click="setVolume('voice', preset / 100)">{{ preset }}%</button>
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
.muted-badge { position: absolute; right: 7px; bottom: 6px; padding: 3px; color: var(--text); background: var(--panel); border-radius: 4px; }
.volume-anchor { position: relative; }
.volume-anchor button { touch-action: none; user-select: none; }
.volume-panel { position: absolute; top: 100%; z-index: 2; box-sizing: border-box; height: 32px; display: flex; align-items: center; gap: 6px; border-radius: 6px; background: var(--panel-raised); box-shadow: inset 0 0 0 1px var(--border), 0 3px 9px #0005; }
.volume-panel input { appearance: none; flex: none; margin: 0; background: transparent; height: 24px; touch-action: none; }
.volume-panel input::-webkit-slider-runnable-track { height: 4px; background: var(--border); border-radius: 4px; }
.volume-panel input::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5px; background: var(--accent); border-radius: 50%; }
.volume-panel input::-moz-range-track { height: 4px; background: var(--border); }
.volume-panel input::-moz-range-thumb { width: 14px; height: 14px; border: 0; background: var(--accent); }
.volume-panel output { width: 42px; text-align: end; font-size: 12px; font-variant-numeric: tabular-nums; }
.volume-anchor :focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: no-preference) {
  .volume-panel { animation: reveal-volume 120ms ease-out; }
  @keyframes reveal-volume { from { clip-path: inset(0 calc(100% - var(--anchor-x)) 0 var(--anchor-x)); } to { clip-path: inset(0); } }
}
.volume-options { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px 22px; align-items: center; }
.volume-options button[aria-pressed=true] { border-color: var(--accent); }
</style>

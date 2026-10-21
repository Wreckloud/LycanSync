<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, HeadphoneOff, Headphones, MicOff, MonitorUp, MonitorX, Settings } from '@lucide/vue';
import VoiceLevelMic from './VoiceLevelMic.vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP } from '../rtc/audioPreferences';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';

const props = withDefaults(defineProps<{
  connected: boolean; desktop: boolean;
  microphoneEnabled: boolean; microphoneIntent: boolean; microphoneBusy: boolean; microphoneLevel: number; inputLevelPercent: number;
  listening: boolean; inputGain: number; outputVolume: number;
  sharing: boolean; shareBusy: boolean; choosingSource: boolean; shareLimitReached: boolean;
  quality: ScreenShareQualityId; shareAudio: boolean; audioMode: NativeScreenAudioMode;
  customQuality?: CustomScreenShareQuality;
}>(), { customQuality: () => ({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY }) });
const emit = defineEmits<{
  microphone: []; listening: []; share: []; changeSource: []; shareAudio: [enabled: boolean];
  quality: [quality: ScreenShareQualityId, customQuality?: CustomScreenShareQuality]; inputGain: [volume: number]; outputVolume: [volume: number];
  settings: [opener: HTMLElement];
}>();
type ControlMenu = 'microphone' | 'output' | 'share';
const root = ref<HTMLElement | null>(null);
const menu = ref<ControlMenu | null>(null);
const qualityOpen = ref(false);
const menuMaxHeight = ref(520);
let opener: HTMLButtonElement | null = null;
const levelSegments = Array.from({ length: 16 }, (_, index) => index + 1);

function closeMenu(restoreFocus = false) {
  menu.value = null;
  qualityOpen.value = false;
  if (restoreFocus) opener?.focus();
}

function resizeMenu() {
  if (!menu.value) return;
  const anchor = window.matchMedia('(max-width: 600px)').matches
    ? root.value?.closest('.callbar') : opener?.closest('.call-control-split');
  const titlebarBottom = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0;
  menuMaxHeight.value = Math.max(60, Math.min(520, (anchor?.getBoundingClientRect().top ?? 520) - titlebarBottom - 16));
}

async function toggleMenu(kind: ControlMenu, event: Event) {
  if (menu.value === kind) { closeMenu(true); return; }
  opener = event.currentTarget as HTMLButtonElement;
  qualityOpen.value = false;
  menu.value = kind;
  resizeMenu();
  await nextTick();
  root.value?.querySelector<HTMLElement>('.call-control-menu input:not(:disabled), .call-control-menu button:not(:disabled)')?.focus();
}

function dismiss(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) closeMenu();
}
function dismissAfterFocus(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) closeMenu();
}

function openAudioSettings() {
  const returnFocus = opener;
  closeMenu();
  if (returnFocus) emit('settings', returnFocus);
}

function chooseSource() { closeMenu(true); emit('changeSource'); }
function toggleShare() { closeMenu(true); emit('share'); }
function chooseQuality(quality: ScreenShareQualityId) {
  // 原生表单会先改变勾选；异步操作确认前仍以父层的实际状态为准。
  root.value?.querySelectorAll<HTMLInputElement>('.call-quality-options input').forEach((input) => {
    input.checked = input.value === props.quality;
  });
  emit('quality', quality);
}
function toggleShareAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  input.checked = props.shareAudio;
  emit('shareAudio', enabled);
}
function escape(event: KeyboardEvent) {
  if (!menu.value) return;
  event.stopPropagation();
  if (qualityOpen.value) { qualityOpen.value = false; root.value?.querySelector<HTMLButtonElement>('.call-quality-trigger')?.focus(); }
  else closeMenu(true);
}

watch(() => [props.connected, props.choosingSource], ([connected, choosing]) => { if (!connected || choosing) closeMenu(); });
watch(() => props.sharing, () => { if (menu.value === 'share') closeMenu(); });
watch(() => props.shareBusy, busy => { if (busy && menu.value === 'share') opener?.focus(); });
onMounted(() => {
  document.addEventListener('pointerdown', dismiss);
  window.addEventListener('resize', resizeMenu);
});
onScopeDispose(() => {
  document.removeEventListener('pointerdown', dismiss);
  window.removeEventListener('resize', resizeMenu);
});
</script>

<template>
  <div ref="root" class="call-controls" :style="{ '--call-menu-max-height': menuMaxHeight + 'px' }" @keydown.esc="escape" @focusout="dismissAfterFocus">
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="microphoneEnabled || (microphoneBusy && microphoneIntent) ? '关闭麦克风' : '开启麦克风'"
        :class="{ 'is-off': !microphoneEnabled }" :disabled="!connected || (microphoneBusy && !microphoneIntent)" @click="emit('microphone')">
        <VoiceLevelMic v-if="microphoneEnabled" :size="17" :level="microphoneLevel" /><MicOff v-else :size="17" />
      </button>
      <button type="button" class="call-control-more" aria-label="麦克风选项" :aria-expanded="menu === 'microphone'"
        :disabled="!connected" @click="toggleMenu('microphone', $event)"><ChevronDown :size="13" :class="{ 'is-open': menu === 'microphone' }" /></button>
      <section v-if="menu === 'microphone'" class="call-control-menu" aria-label="麦克风选项">
        <header>麦克风</header>
        <label class="call-control-range"><span>输入音量 <b>{{ Math.round(inputGain * 100) }}%</b></span>
          <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="inputGain" aria-label="麦克风输入音量"
            @input="emit('inputGain', Number(($event.target as HTMLInputElement).value))" /></label>
        <div class="call-input-level"><span>输入等级 <b>{{ inputLevelPercent }}%</b></span>
          <div role="meter" aria-label="麦克风输入等级" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="inputLevelPercent">
            <i v-for="segment in levelSegments" :key="segment" :class="{ 'is-active': segment * 100 / levelSegments.length <= inputLevelPercent }" />
          </div>
        </div>
        <button type="button" class="call-settings-entry" @click="openAudioSettings"><Settings :size="15" />语音设置<ChevronRight :size="14" /></button>
      </section>
    </div>
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="listening ? '停止接收声音' : '开始接收声音'"
        :class="{ 'is-off': !listening }" :disabled="!connected" @click="emit('listening')"><Headphones v-if="listening" :size="17" /><HeadphoneOff v-else :size="17" /></button>
      <button type="button" class="call-control-more" aria-label="收听选项" :aria-expanded="menu === 'output'"
        :disabled="!connected" @click="toggleMenu('output', $event)"><ChevronDown :size="13" :class="{ 'is-open': menu === 'output' }" /></button>
      <section v-if="menu === 'output'" class="call-control-menu" aria-label="收听选项">
        <header>收听</header>
        <label class="call-control-range"><span>输出音量 <b>{{ Math.round(outputVolume * 100) }}%</b></span>
          <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="outputVolume" aria-label="LycanSync 总输出音量"
            @input="emit('outputVolume', Number(($event.target as HTMLInputElement).value))" /></label>
        <button type="button" class="call-settings-entry" @click="openAudioSettings"><Settings :size="15" />语音设置<ChevronRight :size="14" /></button>
      </section>
    </div>
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="choosingSource ? '取消共享选择' : sharing ? '停止屏幕共享' : shareLimitReached ? '屏幕共享已达到 8 路上限' : '开始屏幕共享'"
        :class="{ 'is-active': sharing }" :disabled="!connected || shareLimitReached || (!choosingSource && shareBusy)" @click="toggleShare">
        <MonitorX v-if="sharing || choosingSource" :size="17" /><MonitorUp v-else :size="17" />
      </button>
      <button type="button" class="call-control-more" aria-label="共享选项" :aria-expanded="menu === 'share'"
        :disabled="!connected || choosingSource" @click="toggleMenu('share', $event)"><ChevronDown :size="13" :class="{ 'is-open': menu === 'share' }" /></button>
      <section v-if="menu === 'share'" class="call-control-menu" aria-label="共享选项">
        <header>屏幕共享</header>
        <button type="button" class="call-menu-action" :class="{ 'is-danger': sharing }" :disabled="shareBusy || shareLimitReached" @click="toggleShare">
          <MonitorX v-if="sharing" :size="15" /><MonitorUp v-else :size="15" />{{ sharing ? '停止共享' : '开始共享' }}</button>
        <button v-if="sharing && desktop" type="button" class="call-menu-action" :disabled="shareBusy" @click="chooseSource">更改共享<ChevronRight class="call-menu-chevron" :size="14" /></button>
        <template v-if="desktop">
          <button type="button" class="call-menu-action call-quality-trigger" :aria-expanded="qualityOpen" :disabled="shareBusy" @click="qualityOpen = !qualityOpen">
            共享画质<span>{{ SCREEN_SHARE_QUALITIES.find(preset => preset.id === quality)?.label }}</span><ChevronRight class="call-menu-chevron" :size="14" :class="{ 'is-open': qualityOpen }" /></button>
          <div v-if="qualityOpen" class="call-quality-options" role="group" aria-label="共享画质">
            <label v-for="preset in SCREEN_SHARE_QUALITIES" :key="preset.id">
              <span>{{ preset.label }}<small>{{ screenShareQuality(preset.id, customQuality).description }}</small></span>
              <input type="radio" name="call-share-quality" :value="preset.id" :checked="quality === preset.id" :disabled="shareBusy" @change="chooseQuality(preset.id)" />
            </label>
            <ScreenShareCustomQuality v-if="quality === 'custom'" :model-value="customQuality" :disabled="shareBusy"
              @update:model-value="emit('quality', 'custom', $event)" />
          </div>
          <label v-if="sharing" class="call-share-audio"><span>共享音频</span><input type="checkbox" :checked="shareAudio" :disabled="shareBusy || audioMode === 'unavailable'"
            @change="toggleShareAudio" /></label>
          <small v-if="sharing && audioMode === 'systemMix'" class="call-audio-warning">包含所有系统声音，可能产生回声。</small>
          <small v-else-if="sharing && audioMode === 'unavailable'" class="call-audio-warning">当前系统不支持共享音频。</small>
        </template>
        <button type="button" class="call-settings-entry" @click="openAudioSettings"><Settings :size="15" />语音设置<ChevronRight :size="14" /></button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.call-controls { display: flex; align-items: center; gap: 8px; }
.call-control-split { position: relative; display: flex; flex: 0 0 auto; height: 36px; }
.call-control-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.call-control-more { display: grid; place-items: center; width: 20px; padding: 0; border: 1px solid var(--border); border-left: 0; border-radius: 0 6px 6px 0; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.call-control-more:hover:not(:disabled), .call-control-more[aria-expanded='true'] { color: var(--text); background: var(--panel-soft); }
.call-control-more svg.is-open { transform: rotate(180deg); }
.call-control-menu { position: absolute; z-index: 30; right: 0; bottom: calc(100% + 8px); display: grid; gap: 12px; width: min(260px, calc(100vw - 32px)); max-height: var(--call-menu-max-height); overflow-y: auto; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); color: var(--text); font-size: 13px; line-height: 20px; }
.call-control-menu header { color: var(--muted); font-size: 12px; }
.call-control-range, .call-input-level { display: grid; gap: 6px; }
.call-control-range > span, .call-input-level > span { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.call-control-range input { width: 100%; margin: 0; accent-color: var(--accent); }
.call-control-menu b { color: var(--accent); font-weight: 500; font-variant-numeric: tabular-nums; }
.call-input-level > div { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; height: 10px; }
.call-input-level i { border-radius: 2px; background: var(--panel-soft); }
.call-input-level i.is-active { background: var(--accent); }
.call-menu-action, .call-settings-entry { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--text); font-size: 13px; text-align: left; cursor: pointer; }
.call-menu-action:hover:not(:disabled), .call-settings-entry:hover { background: var(--panel-soft); }
.call-menu-chevron, .call-settings-entry > svg:last-child { margin-left: auto; }
.call-menu-action > span { margin-left: auto; color: var(--muted); font-size: 12px; }
.call-menu-action > span + svg { margin-left: 0; }
.call-menu-action.is-danger { color: var(--danger); }
.call-quality-trigger svg.is-open { transform: rotate(90deg); }
.call-settings-entry { border-top: 1px solid var(--border); border-radius: 0; padding-top: 12px; }
.call-quality-options { display: grid; gap: 4px; padding-left: 8px; }
.call-quality-options label, .call-share-audio { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
.call-quality-options label { padding: 4px 0; }
.call-quality-options label > span { display: grid; gap: 1px; }
.call-quality-options small { color: var(--muted); font-size: 11px; }
.call-share-audio { padding: 0 8px; }
.call-quality-options input, .call-share-audio input { flex-shrink: 0; margin: 0; accent-color: var(--accent); }
.call-audio-warning { color: var(--muted); font-size: 12px; }
@media (max-width: 600px) {
  .call-controls { gap: 6px; }
  .call-control-split { position: static; }
  .call-control-menu { left: 10px; right: 10px; width: auto; max-width: 260px; }
}
</style>

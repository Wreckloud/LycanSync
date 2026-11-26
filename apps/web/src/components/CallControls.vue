<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { ChevronDown, ChevronLeft, ChevronRight, HeadphoneOff, Headphones, MicOff, MonitorUp, MonitorX, Settings } from '@lucide/vue';
import VoiceLevelMic from './VoiceLevelMic.vue';
import RangeValue from './RangeValue.vue';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP } from '../rtc/audioPreferences';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../rtc/screenShareQuality';
import ScreenShareCustomQuality from './ScreenShareCustomQuality.vue';
import ExpandSection from './ExpandSection.vue';
import type { NativeScreenAudioMode } from '../rtc/nativeScreenAudioMode';
import type { VoiceMode } from '../settings/useAudioShortcuts';
import InlineFeedback from './InlineFeedback.vue';
import VoiceModeSwitch from './VoiceModeSwitch.vue';

const props = withDefaults(defineProps<{
  connected: boolean; desktop: boolean;
  microphoneEnabled: boolean; microphoneIntent: boolean; microphoneBusy: boolean; microphoneLevel: number; inputLevelPercent: number;
  listening: boolean; inputGain: number; outputVolume: number;
  memberVolumes?: { identity: string; name: string; volume: number }[];
  sharing: boolean; shareBusy: boolean; choosingSource: boolean; shareLimitReached: boolean;
  quality: ScreenShareQualityId; shareAudio: boolean; audioMode: NativeScreenAudioMode;
  shareAudioRestricted?: boolean;
  recordingActive?: boolean; recordingBusy?: boolean; recordingElapsed?: string;
  replayActive?: boolean; replaySaving?: boolean; replayError?: boolean;
  customQuality?: CustomScreenShareQuality;
  voiceMode?: VoiceMode; pushToTalkBinding?: string; shortcutsReady?: boolean; shortcutsBusy?: boolean; shortcutsSupported?: boolean;
  processingEnabled?: boolean; processingPartial?: boolean; microphoneError?: string;
  gameName?: string; voiceVolumeBalance?: boolean;
}>(), { customQuality: () => ({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY }) });
const emit = defineEmits<{
  microphone: []; listening: []; share: []; prepareShare: []; shareAudio: [enabled: boolean];
  quality: [quality: ScreenShareQualityId, customQuality?: CustomScreenShareQuality]; inputGain: [volume: number]; outputVolume: [volume: number];
  settings: [opener: HTMLElement]; recording: []; recordingSettings: [opener: HTMLElement]; saveReplay: [];
  voiceMode: [mode: VoiceMode, opener: HTMLElement]; processing: [enabled: boolean];
  shareGame: []; shareAndRecord: []; voiceVolumeBalance: [enabled: boolean];
  memberVolume: [identity: string, volume: number];
}>();
type ControlMenu = 'microphone' | 'output' | 'share';
const root = ref<HTMLElement | null>(null);
const menu = ref<ControlMenu | null>(null);
const submenuOpen = ref(false);
const missingTalkBinding = ref(false);
const submenuPlacement = ref<'right' | 'compact'>('compact');
const menuMaxHeight = ref(520);
let opener: HTMLButtonElement | null = null;
const levelSegments = Array.from({ length: 16 }, (_, index) => index + 1);
let shareIntentTimer: ReturnType<typeof setTimeout> | undefined;
function cancelShareIntent() {
  clearTimeout(shareIntentTimer);
  shareIntentTimer = undefined;
}
function prepareShare() {
  cancelShareIntent();
  if (props.desktop && props.connected && !props.sharing && !props.shareBusy && !props.choosingSource && !props.shareLimitReached) emit('prepareShare');
}
function scheduleShareIntent() {
  cancelShareIntent();
  shareIntentTimer = setTimeout(prepareShare, 300);
}

function closeMenu(restoreFocus = false) {
  menu.value = null;
  missingTalkBinding.value = false;
  submenuOpen.value = false;
  if (restoreFocus) opener?.focus();
}

function resizeMenu() {
  if (!menu.value) return;
  const anchor = window.matchMedia('(max-width: 600px)').matches
    ? root.value?.closest('.callbar') : opener?.closest('.call-control-split');
  const titlebarBottom = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0;
  menuMaxHeight.value = Math.max(60, Math.min(520, (anchor?.getBoundingClientRect().top ?? 520) - titlebarBottom - 16));
  const right = opener?.closest('.call-control-split')?.getBoundingClientRect().right ?? 0;
  submenuPlacement.value = window.innerWidth > 600 && right + 268 <= window.innerWidth - 16 ? 'right' : 'compact';
}

async function toggleMenu(kind: ControlMenu, event: Event) {
  if (menu.value === kind) { closeMenu(true); return; }
  opener = event.currentTarget as HTMLButtonElement;
  submenuOpen.value = false;
  menu.value = kind;
  missingTalkBinding.value = false;
  if (kind === 'share') prepareShare();
  resizeMenu();
  await nextTick();
  if (menu.value === kind) opener?.closest('.call-control-split')?.querySelector<HTMLElement>('.call-control-menu input:not(:disabled), .call-control-menu button:not(:disabled)')?.focus();
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

function changeVoiceMode(mode: VoiceMode) {
  if (props.shortcutsBusy || !props.shortcutsReady || !opener) return;
  if (mode === 'pushToTalk' && !props.shortcutsSupported) return;
  missingTalkBinding.value = mode === 'pushToTalk' && !props.pushToTalkBinding;
  if (!missingTalkBinding.value) emit('voiceMode', mode, opener);
}

function openShortcutSettings() {
  const returnFocus = opener;
  closeMenu();
  if (returnFocus) emit('voiceMode', 'pushToTalk', returnFocus);
}

function toggleProcessing(event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  input.checked = !!props.processingEnabled;
  emit('processing', enabled);
}

function toggleShare() { closeMenu(true); emit('share'); }
async function toggleSubmenu() {
  const parent = menu.value;
  const opening = !submenuOpen.value;
  submenuOpen.value = opening;
  await nextTick();
  if (menu.value !== parent || submenuOpen.value !== opening) return;
  const selector = parent === 'share' ? '.call-quality-options input:checked' : '.call-member-volume input';
  opener?.closest('.call-control-split')?.querySelector<HTMLElement>(opening ? selector : '.call-submenu-trigger')?.focus();
}
function chooseQuality(quality: ScreenShareQualityId) {
  if (props.shareBusy) return;
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
  if (submenuOpen.value) void toggleSubmenu();
  else closeMenu(true);
}

watch(() => [props.connected, props.choosingSource], ([connected, choosing]) => { if (!connected || choosing) closeMenu(); });
watch(() => props.sharing, () => { if (menu.value === 'share') closeMenu(); });
watch(() => props.memberVolumes?.length, async count => {
  if (count || menu.value !== 'output' || !submenuOpen.value) return;
  submenuOpen.value = false;
  await nextTick();
  if (menu.value === 'output') opener?.focus();
});
watch(() => props.pushToTalkBinding, binding => { if (binding) missingTalkBinding.value = false; });
watch(() => props.shareBusy, busy => { if (busy && menu.value === 'share') opener?.focus(); });
onMounted(() => {
  document.addEventListener('pointerdown', dismiss);
  window.addEventListener('resize', resizeMenu);
});
onScopeDispose(() => {
  cancelShareIntent();
  document.removeEventListener('pointerdown', dismiss);
  window.removeEventListener('resize', resizeMenu);
});
</script>

<template>
  <div ref="root" class="call-controls" :style="{ '--call-menu-max-height': menuMaxHeight + 'px' }" @keydown.esc="escape" @focusout="dismissAfterFocus">
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="microphoneEnabled || (microphoneBusy && microphoneIntent) ? '关闭麦克风' : '开启麦克风'"
        :class="{ 'is-off': !microphoneEnabled, 'is-microphone-stopping': connected && microphoneBusy && !microphoneIntent }"
        :disabled="!connected || (microphoneBusy && !microphoneIntent)" @click="emit('microphone')">
        <VoiceLevelMic v-if="microphoneEnabled" :size="17" :level="microphoneLevel" /><MicOff v-else :size="17" />
      </button>
      <button type="button" class="call-control-more" aria-label="麦克风选项" :aria-expanded="menu === 'microphone'"
        :disabled="!connected" @click="toggleMenu('microphone', $event)"><ChevronDown :size="13" :class="{ 'is-open': menu === 'microphone' }" /></button>
      <Transition name="surface-panel">
      <section v-if="menu === 'microphone'" class="call-control-menu" aria-label="麦克风选项">
        <header>麦克风</header>
        <div class="call-control-range"><span>输入音量<RangeValue :value="inputGain" label="重置麦克风输入音量" @reset="emit('inputGain', $event)">{{ Math.round(inputGain * 100) }}%</RangeValue></span>
          <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="inputGain" aria-label="麦克风输入音量"
            @input="emit('inputGain', Number(($event.target as HTMLInputElement).value))" /></div>
        <div class="call-input-level"><span>输入等级 <b>{{ inputLevelPercent }}%</b></span>
          <div role="meter" aria-label="麦克风输入等级" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="inputLevelPercent">
            <i v-for="segment in levelSegments" :key="segment" :class="{ 'is-active': segment * 100 / levelSegments.length <= inputLevelPercent }" />
          </div>
        </div>
        <VoiceModeSwitch :model-value="voiceMode ?? 'voice'" :binding="pushToTalkBinding" :disabled="shortcutsBusy || !shortcutsReady"
          :push-to-talk-disabled="!shortcutsSupported" @update:model-value="changeVoiceMode" />
        <ExpandSection :open="missingTalkBinding">
          <button type="button" class="call-shortcut-hint" @click="openShortcutSettings">请先为按键发言设置快捷键<ChevronRight :size="14" /></button>
        </ExpandSection>
        <label class="call-share-audio"><span>智能声音处理</span><input type="checkbox" :checked="processingEnabled"
          :indeterminate="processingPartial" :aria-checked="processingPartial ? 'mixed' : !!processingEnabled" :disabled="microphoneBusy" @change="toggleProcessing" /></label>
        <InlineFeedback :message="microphoneError" />
        <button type="button" class="call-settings-entry" @click="openAudioSettings"><Settings :size="15" />语音设置<ChevronRight :size="14" /></button>
      </section>
      </Transition>
    </div>
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="listening ? '停止接收声音' : '开始接收声音'"
        :class="{ 'is-off': !listening }" :disabled="!connected" @click="emit('listening')"><Headphones v-if="listening" :size="17" /><HeadphoneOff v-else :size="17" /></button>
      <button type="button" class="call-control-more" aria-label="收听选项" :aria-expanded="menu === 'output'"
        :disabled="!connected" @click="toggleMenu('output', $event)"><ChevronDown :size="13" :class="{ 'is-open': menu === 'output' }" /></button>
      <Transition name="surface-panel">
      <div v-if="menu === 'output'" class="call-menu-stack" :class="{ 'is-compact': submenuPlacement === 'compact' }">
        <section v-show="!submenuOpen || submenuPlacement !== 'compact'" class="call-control-menu call-menu-primary" aria-label="收听选项">
          <header>收听</header>
          <div class="call-control-range"><span>输出音量<RangeValue :value="outputVolume" label="重置总输出音量" @reset="emit('outputVolume', $event)">{{ Math.round(outputVolume * 100) }}%</RangeValue></span>
            <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="outputVolume" aria-label="lycanclaw 总输出音量"
              @input="emit('outputVolume', Number(($event.target as HTMLInputElement).value))" /></div>
          <label class="call-share-audio"><span>平衡成员语音音量</span><input type="checkbox" :checked="voiceVolumeBalance"
            @change="emit('voiceVolumeBalance', ($event.target as HTMLInputElement).checked)" /></label>
          <button v-if="memberVolumes?.length" type="button" class="call-menu-action call-submenu-trigger" :aria-expanded="submenuOpen" @click="toggleSubmenu">
            调整成员音量<ChevronRight class="call-menu-chevron" :size="14" /></button>
          <button type="button" class="call-settings-entry" @click="openAudioSettings"><Settings :size="15" />语音设置<ChevronRight :size="14" /></button>
        </section>
        <Transition :name="submenuPlacement === 'right' ? 'surface-side' : 'surface-panel'">
        <section v-if="submenuOpen" class="call-control-menu call-submenu" aria-label="成员音量">
          <header class="call-submenu-heading">
            <button v-if="submenuPlacement === 'compact'" type="button" class="call-menu-action call-submenu-back" aria-label="返回收听选项" @click="toggleSubmenu"><ChevronLeft :size="14" /></button>
            成员音量
          </header>
          <div v-for="member in memberVolumes" :key="member.identity" class="call-control-range call-member-volume">
            <span><span class="call-member-name" :title="member.name">{{ member.name }}</span><RangeValue :value="member.volume" :label="`重置${member.name}接收音量`" @reset="emit('memberVolume', member.identity, $event)">{{ Math.round(member.volume * 100) }}%</RangeValue></span>
            <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="member.volume" :aria-label="`${member.name}接收音量`"
              @input="emit('memberVolume', member.identity, Number(($event.target as HTMLInputElement).value))" />
          </div>
        </section>
        </Transition>
      </div>
      </Transition>
    </div>
    <div class="call-control-split">
      <button type="button" class="icon-button call-control-main" :aria-label="choosingSource ? '取消共享选择' : sharing ? '停止屏幕共享' : shareLimitReached ? '屏幕共享已达到 8 路上限' : '开始屏幕共享'"
        :class="{ 'is-active': sharing }" :disabled="!connected || shareLimitReached || (!choosingSource && shareBusy)" @click="toggleShare"
        @pointerenter="scheduleShareIntent" @pointerleave="cancelShareIntent" @focus="prepareShare" @blur="cancelShareIntent">
        <MonitorX v-if="sharing || choosingSource" :size="17" /><MonitorUp v-else :size="17" />
      </button>
      <button type="button" class="call-control-more" aria-label="共享选项" :aria-expanded="menu === 'share'"
        :disabled="!connected || choosingSource" @click="toggleMenu('share', $event)"
        @pointerenter="scheduleShareIntent" @pointerleave="cancelShareIntent" @focus="prepareShare" @blur="cancelShareIntent"><ChevronDown :size="13" :class="{ 'is-open': menu === 'share' }" /></button>
      <Transition name="surface-panel">
      <div v-if="menu === 'share'" class="call-menu-stack" :class="{ 'is-compact': submenuPlacement === 'compact' }">
        <section v-show="!submenuOpen || submenuPlacement !== 'compact'" class="call-control-menu call-menu-primary" aria-label="共享选项">
          <header>屏幕共享</header>
          <button v-if="sharing" type="button" class="call-menu-action is-danger" :disabled="shareBusy" @click="toggleShare">
            <MonitorX :size="15" />关闭共享</button>
          <button v-else-if="desktop && gameName" type="button" class="call-menu-action" :disabled="shareBusy || shareLimitReached"
            @click="closeMenu(true); emit('shareGame')"><MonitorUp :size="15" />快速共享 {{ gameName }}</button>
          <button v-if="desktop" type="button" class="call-menu-action" :disabled="recordingBusy || shareBusy || shareAudioRestricted || (!sharing && shareLimitReached)"
            @click="closeMenu(true); sharing ? emit('recording') : emit('shareAndRecord')">{{ recordingActive ? `停止录制 · ${recordingElapsed}` : sharing ? '开始录制' : '开始共享并录制' }}</button>
          <button v-if="desktop" type="button" class="call-menu-action call-submenu-trigger" :aria-expanded="submenuOpen" :disabled="shareBusy" @click="toggleSubmenu">
            共享画质<span>{{ SCREEN_SHARE_QUALITIES.find(preset => preset.id === quality)?.label }}</span><ChevronRight class="call-menu-chevron" :size="14" /></button>
          <label v-if="desktop && sharing" class="call-share-audio"><span>共享音频</span><input type="checkbox" :checked="shareAudio" :disabled="shareBusy || shareAudioRestricted || audioMode === 'unavailable'"
            @change="toggleShareAudio" /></label>
          <small v-if="desktop && sharing && shareAudioRestricted" class="call-audio-warning">远控画面不包含电脑声音，语音通话不受影响。</small>
          <small v-else-if="desktop && sharing && audioMode === 'systemMix'" class="call-audio-warning">包含所有系统声音，可能产生回声。</small>
          <small v-else-if="desktop && sharing && audioMode === 'unavailable'" class="call-audio-warning">当前系统不支持共享音频。</small>
          <button v-if="desktop && sharing && replayActive" type="button" class="call-menu-action"
            :disabled="recordingBusy || replaySaving || replayError || shareAudioRestricted"
            @click="closeMenu(true); emit('saveReplay')">保存即时回放</button>
          <button v-if="desktop" type="button" class="call-settings-entry" @click="emit('recordingSettings', opener!); closeMenu()"><Settings :size="15" />共享与录制<ChevronRight class="call-menu-chevron" :size="14" /></button>
        </section>
        <Transition :name="submenuPlacement === 'right' ? 'surface-side' : 'surface-panel'">
        <section v-if="submenuOpen" class="call-control-menu call-submenu" aria-label="共享画质">
          <button v-if="submenuPlacement === 'compact'" type="button" class="call-menu-action call-submenu-back" aria-label="返回共享选项" @click="toggleSubmenu"><ChevronLeft :size="14" /></button>
          <div class="call-quality-options" role="group" aria-label="画质预设">
            <label v-for="preset in SCREEN_SHARE_QUALITIES" :key="preset.id">
              <span>{{ preset.label }}<small>{{ screenShareQuality(preset.id, customQuality).description }}</small></span>
              <input type="radio" name="call-share-quality" :value="preset.id" :checked="quality === preset.id" :disabled="shareBusy"
                @change="chooseQuality(preset.id)" @click="quality === preset.id && chooseQuality(preset.id)" />
            </label>
          </div>
          <ExpandSection :open="quality === 'custom'">
          <ScreenShareCustomQuality :model-value="customQuality" :disabled="shareBusy"
            @update:model-value="emit('quality', 'custom', $event)" />
          </ExpandSection>
        </section>
        </Transition>
      </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.call-controls { display: flex; align-items: center; gap: 8px; }
.call-control-split { position: relative; display: flex; flex: 0 0 auto; height: 36px; }
.call-control-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.call-control-main.is-microphone-stopping:disabled { opacity: 1; cursor: default; }
.call-control-more { display: grid; place-items: center; width: 20px; padding: 0; border: 1px solid var(--border); border-left: 0; border-radius: 0 6px 6px 0; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.call-control-more:hover:not(:disabled), .call-control-more[aria-expanded='true'] { color: var(--text); background: var(--panel-soft); }
.call-control-more svg.is-open { transform: rotate(180deg); }
.call-control-more svg { transition: transform var(--motion-feedback-duration) ease; }
.call-control-menu { position: absolute; z-index: 30; right: 0; bottom: calc(100% + 8px); display: grid; gap: 12px; width: min(260px, calc(100vw - 32px)); max-height: var(--call-menu-max-height); overflow-y: auto; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); color: var(--text); font-size: 13px; line-height: 20px; }
.call-control-menu header { color: var(--muted); font-size: 12px; }
.call-control-range, .call-input-level { display: grid; gap: 6px; }
.call-member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.call-submenu-heading { display: flex; align-items: center; gap: 4px; }
.call-control-range > span, .call-input-level > span { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.call-control-range input { width: 100%; margin: 0; accent-color: var(--accent); }
.call-control-menu b { color: var(--accent); font-weight: 500; font-variant-numeric: tabular-nums; }
.call-input-level > div { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; height: 10px; }
.call-input-level i { border-radius: 2px; background: var(--panel-soft); }
.call-input-level i.is-active { background: var(--accent); }
.call-shortcut-hint { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 4px 0; border: 0; background: transparent; color: var(--danger); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.call-shortcut-hint svg { flex-shrink: 0; }
.call-menu-action, .call-settings-entry { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--text); font-size: 13px; text-align: left; cursor: pointer; }
.call-menu-action:hover:not(:disabled), .call-settings-entry:hover { background: var(--panel-soft); }
.call-menu-chevron, .call-settings-entry > svg:last-child { margin-left: auto; }
.call-menu-action > span { margin-left: auto; color: var(--muted); font-size: 12px; }
.call-menu-action > span + svg { margin-left: 0; }
.call-menu-action.is-danger { color: var(--danger); }
.call-settings-entry { border-top: 1px solid var(--border); border-radius: 0; padding-top: 12px; }
.call-menu-stack { position: absolute; z-index: 30; right: 0; bottom: calc(100% + 8px); }
.call-menu-primary { position: relative; right: auto; bottom: auto; }
.call-submenu { left: calc(100% + 8px); bottom: 0; }
.call-menu-stack.is-compact .call-submenu { position: relative; right: auto; left: auto; bottom: auto; }
.call-menu-stack.is-compact .call-submenu.surface-panel-leave-active { position: absolute; left: 0; bottom: 0; }
.call-submenu-back { width: 32px; justify-content: center; padding: 6px; }
.call-quality-options { display: grid; gap: 4px; }
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
  .call-menu-stack { left: 10px; right: 10px; max-width: 260px; }
  .call-menu-primary, .call-menu-stack.is-compact .call-submenu { left: auto; right: auto; width: 100%; }
}
</style>

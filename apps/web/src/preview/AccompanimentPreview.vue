<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { AppWindow, AudioWaveform, HeadphoneOff, Headphones, MicOff, Monitor, Music, Square, Volume2, VolumeX } from '@lucide/vue';
import DialogTransition from '../components/DialogTransition.vue';
import MemberVolumeButton from '../components/MemberVolumeButton.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';
import { useBackdropDismiss } from '../components/useBackdropDismiss';
import { keepDialogFocus } from '../components/dialogFocus';
import { SHARE_VOLUME_MAX } from '../rtc/audioPreferences';
import qqMusicIcon from './assets/qq-music.png';
import chromeIcon from './assets/chrome.png';

const marks = [{ id: 'note', label: '双音符' }, { id: 'wave', label: '单线波形' }] as const;
const markIcons = { note: Music, wave: AudioWaveform };
const markStyle = ref<typeof marks[number]['id']>('note');
const sharingMark = computed(() => markIcons[markStyle.value]);

const sources = ref([
  { id: 'player', name: 'QQ 音乐', icon: qqMusicIcon, open: true, paused: false },
  { id: 'browser', name: 'Google Chrome', icon: chromeIcon, open: true, paused: false },
  { id: 'other', name: '本地播放器', open: false, paused: true },
]);
type Source = typeof sources.value[number];
const available = computed(() => sources.value.filter(source => source.open));
const sharingId = ref('');
const accompaniment = computed(() => available.value.find(source => source.id === sharingId.value));
const screen = ref<'off' | 'silent' | 'with-audio'>('off');
const windowAudio = ref(false);
const simulateFailure = ref(false);
const dialog = ref<'audio' | 'screen'>();
const dialogPanel = ref<HTMLElement>();
const error = ref('');
const mic = ref(true);
const listening = ref(true);
const mediaVolume = ref(1);
const lastAudible = ref(1);
const voiceVolume = ref(1);
const lastVoice = ref(1);
const cards = [{ local: true, label: '你的视角' }, { local: false, label: '队友的视角' }];

function changeMediaVolume(value: number) {
  mediaVolume.value = value;
  if (value > 0) lastAudible.value = value;
}
function changeVoiceVolume(value: number) {
  voiceVolume.value = value;
  if (value > 0) lastVoice.value = value;
}

async function openDialog(kind: 'audio' | 'screen') {
  error.value = '';
  windowAudio.value = screen.value === 'with-audio';
  dialog.value = kind;
  await nextTick();
  dialogPanel.value?.focus();
}
function closeDialog() { dialog.value = undefined; }
const backdropEvents = useBackdropDismiss(closeDialog);

function startAudio(source: Source) {
  if (!source.open || screen.value !== 'off') return;
  if (simulateFailure.value) { error.value = '模拟分享失败，请取消后重新选择。'; return; }
  sharingId.value = source.id;
  closeDialog();
}
function shareScreen() {
  if (simulateFailure.value) { error.value = '模拟共享失败，当前声音保持原样。'; return; }
  screen.value = windowAudio.value ? 'with-audio' : 'silent';
  if (windowAudio.value) sharingId.value = '';
  closeDialog();
}
function setSourceOpen(source: Source, open: boolean) {
  source.open = open;
  if (!open && sharingId.value === source.id) sharingId.value = '';
}
</script>

<template>
  <section class="preview-content accompaniment-lab" aria-labelledby="accompaniment-title">
    <header class="preview-section-heading">
      <h2 id="accompaniment-title">分享伴奏</h2>
      <p>指向自己的卡片，点「播放伴奏」。两张卡片同步演示同一位成员，仅模拟界面。</p>
    </header>
    <SegmentedControl v-model="markStyle" class="mark-options" :options="marks" label="分享标记样式">
      <template #default="{ option }"><component :is="markIcons[option.id]" :size="16" aria-hidden="true" />{{ option.label }}</template>
    </SegmentedControl>
    <div class="card-pair">
      <section v-for="card in cards" :key="card.label" :aria-label="card.label">
        <h3>{{ card.label }}</h3>
        <article class="participant-card">
          <div class="participant-media">
            <span v-if="screen !== 'off'" class="screen-preview"><Monitor :size="24" />共享画面</span>
            <div v-else class="large-avatar" aria-hidden="true">维</div>
            <div class="media-badges">
              <button v-if="card.local && (accompaniment || screen === 'off')" type="button" class="media-badge own-badge"
                :class="{ 'is-sharing': accompaniment }" :aria-label="accompaniment ? '停止伴奏，' + accompaniment.name : '播放伴奏'"
                @click="accompaniment ? sharingId = '' : openDialog('audio')">
                <template v-if="accompaniment">
                  <span class="source-label"><component :is="sharingMark" :size="16" aria-hidden="true" />{{ accompaniment.name }}</span>
                  <span class="stop-label"><Square :size="12" />停止伴奏</span>
                </template>
                <span v-else><Music :size="16" aria-hidden="true" />播放伴奏</span>
              </button>
              <span v-if="!card.local && accompaniment" class="media-badge remote-badge" role="img" tabindex="0" aria-label="正在分享伴奏">
                <component :is="sharingMark" :size="16" aria-hidden="true" /><span class="remote-label" aria-hidden="true">正在分享伴奏</span>
              </span>
              <span v-if="!card.local && (!listening || !mic)" class="media-badge muted-badge" role="img" :aria-label="!listening ? '已停止收听' : '麦克风已关闭'">
                <HeadphoneOff v-if="!listening" :size="13" /><MicOff v-else :size="13" />
              </span>
            </div>
          </div>
          <div class="participant-meta">
            <span class="participant-name"><strong>维克罗德{{ card.local ? '（你）' : '' }}</strong></span>
            <template v-if="card.local">
              <button type="button" class="participant-state participant-state-button" :class="{ 'is-off': !mic }"
                :aria-label="mic ? '关闭自己的麦克风' : '开启自己的麦克风'" @click="mic = !mic">
                <VoiceLevelMic v-if="mic" :size="14" :level="0" /><MicOff v-else :size="14" />
              </button>
              <button type="button" class="participant-state participant-state-button" :class="{ 'is-off': !listening }"
                :aria-label="listening ? '停止收听' : '恢复收听'" @click="listening = !listening">
                <Headphones v-if="listening" :size="14" /><HeadphoneOff v-else :size="14" />
              </button>
            </template>
            <template v-else>
              <MemberVolumeButton v-if="accompaniment || screen === 'with-audio'" :max="SHARE_VOLUME_MAX" :volume="mediaVolume"
                :label="mediaVolume ? '静音这路共享声音' : '恢复这路共享声音'"
                @toggle="changeMediaVolume(mediaVolume ? 0 : lastAudible)" @change="changeMediaVolume">
                <Volume2 v-if="mediaVolume" :size="14" /><VolumeX v-else :size="14" />
              </MemberVolumeButton>
              <MemberVolumeButton :disabled="!mic || !listening" :volume="voiceVolume" :label="voiceVolume ? '静音成员语音' : '恢复成员语音'"
                @toggle="changeVoiceVolume(voiceVolume ? 0 : lastVoice)" @change="changeVoiceVolume">
                <VoiceLevelMic v-if="mic && listening && voiceVolume" :size="14" :level="0" /><MicOff v-else :size="14" />
              </MemberVolumeButton>
            </template>
          </div>
        </article>
      </section>
    </div>
    <details class="scenario-controls">
      <summary>模拟场景</summary>
      <fieldset>
        <legend>已打开的应用</legend>
        <label v-for="source in sources" :key="source.id"><input type="checkbox" :checked="source.open"
          @change="setSourceOpen(source, ($event.target as HTMLInputElement).checked)" />{{ source.name }}</label>
      </fieldset>
      <label v-if="accompaniment"><input v-model="accompaniment.paused" type="checkbox" />暂停当前播放器</label>
      <label><input v-model="simulateFailure" type="checkbox" />模拟分享失败</label>
      <button v-if="screen !== 'off'" type="button" @click="openDialog('screen')">调整窗口声音</button>
      <button type="button" @click="screen === 'off' ? openDialog('screen') : screen = 'off'">
        {{ screen === 'off' ? '模拟共享画面' : '结束共享画面' }}
      </button>
    </details>
    <DialogTransition>
      <div v-if="dialog" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="closeDialog">
        <section ref="dialogPanel" role="dialog" class="dialog-panel audio-picker" aria-modal="true" aria-labelledby="audio-picker-title"
          tabindex="-1" @keydown="keepDialogFocus">
          <header><h2 id="audio-picker-title">{{ dialog === 'audio' ? '选择音频来源' : screen === 'off' ? '共享模拟窗口' : '调整窗口声音' }}</h2>
            <p v-if="dialog === 'audio'">选择一个已打开的应用，向语音房分享它的声音。</p>
          </header>
          <div v-if="dialog === 'audio'" class="sources">
            <button v-for="source in available" :key="source.id" type="button" @click="startAudio(source)">
              <img v-if="source.icon" class="app-symbol" :src="source.icon" alt="" />
              <AppWindow v-else class="app-symbol" aria-hidden="true" />
              <span><strong>{{ source.name }}</strong><small v-if="source.id === 'browser'">其他标签页的声音也可能被听到</small>
                <small v-else>{{ source.paused ? '已暂停' : '播放中' }}</small></span>
            </button>
            <p v-if="!available.length">打开播放器或浏览器后，它会出现在这里。</p>
          </div>
          <div v-else class="screen-options">
            <label><input v-model="windowAudio" type="checkbox" />共享窗口声音</label>
            <p v-if="accompaniment">{{ windowAudio ? '共享成功后，窗口声音将替换当前伴奏。' : '将继续分享 ' + accompaniment.name + ' 的伴奏。' }}</p>
          </div>
          <p v-if="error" role="alert" class="picker-error">{{ error }}</p>
          <footer class="card-actions">
            <button type="button" @click="closeDialog">取消</button>
            <button v-if="dialog === 'screen'" type="button" class="confirm-button card-actions-end" @click="shareScreen">{{ screen === 'off' ? '开始共享' : '应用' }}</button>
          </footer>
        </section>
      </div>
    </DialogTransition>
  </section>
</template>

<style scoped>
.accompaniment-lab { max-width: 680px; padding-bottom: 40px; }
.mark-options { justify-self: start; }
.card-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 222px)); width: min(100%, 464px); gap: 20px; }
.participant-meta :deep(.volume-button:disabled) { color: var(--muted); }
.card-pair h3 { margin: 0 0 8px; color: var(--muted); font-size: 13px; font-weight: 500; }
.media-badges { position: absolute; right: 7px; bottom: 6px; display: flex; align-items: center; gap: 4px; }
.media-badge { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 22px; padding: 0 5px; border: 0; border-radius: 5px; background: #0b0f14cc; color: var(--text); font: inherit; font-size: 11px; line-height: 16px; }
.own-badge { display: grid; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity var(--motion-feedback-duration) ease; }
.participant-card:hover .own-badge, .participant-card:focus-within .own-badge, .own-badge.is-sharing { opacity: 1; pointer-events: auto; }
.own-badge span { grid-area: 1 / 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.own-badge, .remote-badge { background: #10161deb; font-size: 12px; }
.own-badge { padding-inline: 6px; }
.own-badge svg { color: var(--muted); }
.source-label svg, .remote-badge svg { color: color-mix(in srgb, var(--accent) 48%, var(--text)); }
.own-badge .stop-label, .own-badge:is(:hover,:focus-visible) .source-label { visibility: hidden; }
.own-badge:is(:hover,:focus-visible) .stop-label { visibility: visible; }
.remote-badge, .muted-badge { min-width: 22px; padding-inline: 4px; }
.remote-label { display: none; }
.remote-badge:is(:hover,:focus) .remote-label { display: inline; }
.screen-preview { display: grid; justify-items: center; gap: 5px; color: var(--muted); font-size: 12px; }
.scenario-controls { padding-top: 12px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: 13px; }
.scenario-controls summary { width: fit-content; cursor: pointer; }
.scenario-controls fieldset { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; padding: 0; border: 0; }
.scenario-controls legend { margin-bottom: 4px; }
.scenario-controls label, .screen-options label { display: inline-flex; gap: 5px; align-items: center; }
.scenario-controls > label { margin-right: 12px; }
.sources, .screen-options { display: grid; gap: 8px; margin: 18px 0; }
.sources button { display: flex; align-items: center; justify-content: flex-start; gap: 12px; padding: 8px 10px; background: var(--panel-soft); text-align: left; }
.sources button:is(:hover,:focus-visible) { border-color: var(--accent); }
.sources strong, .sources small { display: block; }
.sources small, .sources p, .screen-options p { margin: 0; color: var(--muted); }
.app-symbol { width: 24px; height: 24px; flex: none; object-fit: contain; color: var(--muted); }
.picker-error { color: var(--danger); }
@media (hover: none), (pointer: coarse) { .own-badge { opacity: 1; pointer-events: auto; } }
@media (max-width: 480px) { .card-pair { grid-template-columns: minmax(0, 222px); } }
@media (prefers-reduced-motion: reduce) { .own-badge { transition: none; } }
</style>

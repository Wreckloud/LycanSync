<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { HeadphoneOff, Headphones, MicOff, Monitor, Volume2, VolumeX } from '@lucide/vue';
import AccompanimentSourceMenu from '../components/AccompanimentSourceMenu.vue';
import AccompanimentBadge from '../components/AccompanimentBadge.vue';
import SpectrumListeningPreview from './SpectrumListeningPreview.vue';
import DialogTransition from '../components/DialogTransition.vue';
import MemberVolumeButton from '../components/MemberVolumeButton.vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';
import { useBackdropDismiss } from '../components/useBackdropDismiss';
import { keepDialogFocus } from '../components/dialogFocus';
import { SHARE_VOLUME_MAX } from '../rtc/audioPreferences';
import qqMusicIcon from './assets/qq-music.png';
import chromeIcon from './assets/chrome.png';
import neteaseIcon from './assets/netease.png';
import spotifyIcon from './assets/spotify.png';
import edgeIcon from './assets/edge.png';
import firefoxIcon from './assets/firefox.png';
import vlcIcon from './assets/vlc.png';
import stardewIcon from './assets/stardew.png';

interface Source {
  id: string; name: string; icon?: string; common?: boolean; open: boolean; paused: boolean;
}
const sources = ref<Source[]>([
  { id: 'player', name: 'QQ 音乐', icon: qqMusicIcon, common: true, open: true, paused: false },
  { id: 'netease', name: '网易云音乐', icon: neteaseIcon, common: true, open: false, paused: true },
  { id: 'spotify', name: 'Spotify', icon: spotifyIcon, common: true, open: false, paused: true },
  { id: 'browser', name: 'Google Chrome', icon: chromeIcon, common: true, open: true, paused: false },
  { id: 'edge', name: 'Microsoft Edge', icon: edgeIcon, common: true, open: false, paused: false },
  { id: 'firefox', name: 'Firefox', icon: firefoxIcon, common: true, open: false, paused: false },
  { id: 'vlc', name: 'VLC', icon: vlcIcon, open: true, paused: true },
  { id: 'stardew', name: '星露谷物语', icon: stardewIcon, open: false, paused: false },
  { id: 'other', name: '本地播放器', open: false, paused: true },
]);
const available = computed(() => sources.value.filter(source => source.open));
const sharingId = ref('');
const accompaniment = computed(() => available.value.find(source => source.id === sharingId.value));
const silent = ref(false);
const showSpectrum = ref(false);
const screen = ref<'off' | 'silent' | 'with-audio'>('off');
const windowAudio = ref(false);
const simulateFailure = ref(false);
const menuAnchor = ref<HTMLElement>();
const screenDialog = ref(false);
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

function closeSourceMenu(restoreFocus: boolean) {
  const anchor = menuAnchor.value;
  menuAnchor.value = undefined;
  if (restoreFocus) anchor?.focus({ preventScroll: true });
}
function toggleSourceMenu(event: MouseEvent) {
  if (menuAnchor.value) { closeSourceMenu(true); return; }
  error.value = '';
  menuAnchor.value = event.currentTarget as HTMLElement;
}
async function openScreenDialog() {
  error.value = '';
  windowAudio.value = screen.value === 'with-audio';
  screenDialog.value = true;
  await nextTick();
  dialogPanel.value?.focus();
}
function closeDialog() { screenDialog.value = false; }
const backdropEvents = useBackdropDismiss(closeDialog);

function startAudio(id: string) {
  const source = available.value.find(entry => entry.id === id);
  if (!source || screen.value !== 'off') return;
  if (simulateFailure.value) { error.value = '模拟分享失败，请关闭菜单后重试。'; return; }
  silent.value = false;
  sharingId.value = source.id;
  closeSourceMenu(true);
}
function stopAudio() { sharingId.value = ''; }
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
    <SpectrumListeningPreview />
    <header class="preview-section-heading">
      <h2 id="accompaniment-title">分享伴奏</h2>
      <p>指向自己的卡片，点头像左下角的「播放伴奏」。两张卡片同步演示同一位成员，仅模拟界面。</p>
    </header>
    <div class="card-pair">
      <section v-for="card in cards" :key="card.label" :aria-label="card.label">
        <h3>{{ card.label }}</h3>
        <article class="participant-card">
          <div class="participant-media">
            <span v-if="screen !== 'off'" class="screen-preview"><Monitor :size="24" />共享画面</span>
            <div v-else class="large-avatar" aria-hidden="true">维</div>
            <Transition name="badge-fade">
              <div v-if="showSpectrum && accompaniment && screen === 'off'" class="spectrum-preview" aria-hidden="true"
                :class="{ 'has-sound': !accompaniment.paused && !silent }">
                <i v-for="(height, i) in [19, 29, 39, 34, 44, 54, 49, 39, 29, 34, 49, 44, 34, 39, 44, 34, 24, 29, 34, 24, 14]" :key="i"
                  :style="{ '--band-height': height + 'px', '--phase': i * -0.17 + 's' }" />
              </div>
            </Transition>
            <AccompanimentBadge v-if="accompaniment || (card.local && screen === 'off')" :local="card.local"
              :sharing="accompaniment?.id" :icon="accompaniment?.icon" :open="card.local && !!menuAnchor"
              @activate="accompaniment ? stopAudio() : toggleSourceMenu($event)" />
            <span v-if="!card.local && (!listening || !mic)" class="media-badge muted-badge" role="img" :aria-label="!listening ? '已停止收听' : '麦克风已关闭'">
              <HeadphoneOff v-if="!listening" :size="13" /><MicOff v-else :size="13" />
            </span>
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
              <MemberVolumeButton :volume="voiceVolume" :label="voiceVolume ? '静音成员语音' : '恢复成员语音'"
                @toggle="changeVoiceVolume(voiceVolume ? 0 : lastVoice)" @change="changeVoiceVolume">
                <VoiceLevelMic v-if="voiceVolume" :size="14" :level="0" /><MicOff v-else :size="14" />
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
          @change="setSourceOpen(source, ($event.target as HTMLInputElement).checked)" /><img v-if="source.icon" class="source-icon" :src="source.icon" alt="" @error="source.icon = undefined" />{{ source.name }}</label>
      </fieldset>
      <label v-if="accompaniment"><input v-model="accompaniment.paused" type="checkbox" />暂停当前播放器</label>
      <label v-if="accompaniment"><input v-model="silent" type="checkbox" />模拟无声片段</label>
      <label><input v-model="showSpectrum" type="checkbox" />预览模拟频谱背景</label>
      <label><input v-model="simulateFailure" type="checkbox" />模拟分享失败</label>
      <button v-if="screen !== 'off'" type="button" @click="openScreenDialog()">调整窗口声音</button>
      <button type="button" @click="screen === 'off' ? openScreenDialog() : screen = 'off'">
        {{ screen === 'off' ? '模拟共享画面' : '结束共享画面' }}
      </button>
    </details>
    <Teleport to="body">
      <Transition name="surface-panel">
        <AccompanimentSourceMenu v-if="menuAnchor" :anchor="menuAnchor" :sources="available" :error="error"
          @choose="startAudio" @close="closeSourceMenu" />
      </Transition>
    </Teleport>
    <DialogTransition>
      <div v-if="screenDialog" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="closeDialog">
        <section ref="dialogPanel" role="dialog" class="dialog-panel" aria-modal="true" aria-labelledby="screen-preview-title"
          tabindex="-1" @keydown="keepDialogFocus">
          <header><h2 id="screen-preview-title">{{ screen === 'off' ? '共享模拟窗口' : '调整窗口声音' }}</h2></header>
          <div class="screen-options">
            <label><input v-model="windowAudio" type="checkbox" />共享窗口声音</label>
            <p v-if="accompaniment">{{ windowAudio ? '共享成功后，窗口声音将替换当前伴奏。' : '将继续分享 ' + accompaniment.name + ' 的伴奏。' }}</p>
          </div>
          <p v-if="error" role="alert" class="picker-error">{{ error }}</p>
          <footer class="card-actions">
            <button type="button" @click="closeDialog">取消</button>
            <button type="button" class="confirm-button card-actions-end" @click="shareScreen">{{ screen === 'off' ? '开始共享' : '应用' }}</button>
          </footer>
        </section>
      </div>
    </DialogTransition>
  </section>
</template>

<style scoped>
.accompaniment-lab { max-width: 680px; padding-bottom: 40px; }
.card-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 222px)); width: min(100%, 464px); gap: 20px; }
.card-pair h3 { margin: 0 0 8px; color: var(--muted); font-size: 13px; font-weight: 500; }
.media-badge { position: absolute; bottom: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 22px; padding: 0 4px; border: 0; border-radius: 5px; background: #0b0f14cc; color: var(--text); font: inherit; font-size: 11px; line-height: 16px; }
.spectrum-preview { position: absolute; inset: 0 5px; display: grid; grid-template-columns: repeat(21, minmax(0, 8px)); align-items: end; justify-content: center; gap: 2px; overflow: hidden; opacity: .3; pointer-events: none; }
.participant-media:has(.spectrum-preview) .large-avatar { z-index: 1; }
.spectrum-preview i { position: relative; height: 4px; transition: height 550ms ease-in 320ms; }
.spectrum-preview.has-sound i { height: var(--band-height); transition: none; }
.spectrum-preview i::before, .spectrum-preview i::after { content: ''; position: absolute; inset-inline: 0; }
.spectrum-preview i::before { bottom: 0; height: 100%; max-height: 4px; background: var(--muted); clip-path: inset(calc(100% - 4px) 0 0); animation: spectrum-pulse 1.8s ease-in-out var(--phase) infinite paused; }
.spectrum-preview.has-sound i::before { max-height: none; }
.spectrum-preview i::after { top: calc(100% - 4px); height: 2px; background: var(--text); animation: spectrum-peak 1.8s ease-in-out var(--phase) infinite paused; }
.spectrum-preview.has-sound i::before, .spectrum-preview.has-sound i::after { animation-play-state: running; }
@keyframes spectrum-pulse { 0%, 85%, 100% { clip-path: inset(calc(100% - 4px) 0 0); } 50% { clip-path: inset(0); } }
@keyframes spectrum-peak { 0%, 100% { top: calc(100% - 4px); } 50%, 68% { top: 0; } }
.badge-fade-enter-active, .badge-fade-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease); }
.badge-fade-enter-from, .badge-fade-leave-to { opacity: 0; }
.muted-badge { right: 7px; min-width: 22px; }
.source-icon { width: 16px; height: 16px; object-fit: contain; flex: none; }
.screen-preview { display: grid; justify-items: center; gap: 5px; color: var(--muted); font-size: 12px; }
.scenario-controls { padding-top: 12px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: 13px; }
.scenario-controls summary { width: fit-content; cursor: pointer; }
.scenario-controls fieldset { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; padding: 0; border: 0; }
.scenario-controls legend { margin-bottom: 4px; }
.scenario-controls label, .screen-options label { display: inline-flex; gap: 5px; align-items: center; }
.scenario-controls > label { margin-right: 12px; }
.screen-options { display: grid; gap: 8px; margin: 18px 0; }
.screen-options p { margin: 0; color: var(--muted); }
.picker-error { color: var(--danger); }
@media (max-width: 480px) { .card-pair { grid-template-columns: minmax(0, 222px); } }
</style>

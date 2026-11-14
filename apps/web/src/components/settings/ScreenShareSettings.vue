<script setup lang="ts">
import { computed, ref, watch, type UnwrapNestedRefs } from 'vue';
import { Track } from 'livekit-client';
import type { useRtcRoom } from '../../rtc/useRtcRoom';
import { SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from '../../rtc/screenShareQuality';
import { readScreenShareAudioPreference, resolveNativeScreenAudioCapability, saveScreenShareAudioPreference, type NativeScreenAudioMode } from '../../rtc/nativeScreenAudioMode';
import { readScreenSharePreferences, saveScreenSharePreferences } from '../../settings/screenSharePreferences';
import SegmentedControl from '../SegmentedControl.vue';
import ScreenShareCustomQuality from '../ScreenShareCustomQuality.vue';
import ExpandSection from '../ExpandSection.vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProjectAttribution from '../ProjectAttribution.vue';

const props = defineProps<{
  active: boolean;
  rtc: Pick<UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>, 'screenShareActive' | 'currentScreenShareAudioMode'
    | 'screenShareQualityBusy' | 'screenShareSourceBusy' | 'busySources' | 'notice' | 'screenShareAudioRestricted'>;
  sharedAudio: boolean;
  quality: ScreenShareQualityId; customQuality: CustomScreenShareQuality;
  changeQuality: (quality: ScreenShareQualityId, customQuality?: CustomScreenShareQuality) => Promise<boolean>;
  changeAudio: (enabled: boolean) => Promise<boolean>;
}>();
const busy = ref(false);
const loadingAudio = ref(false);
const defaultAudioMode = ref<NativeScreenAudioMode>('unavailable');
const defaultShareAudio = ref(false);
const hideCursor = ref(false);
const qualityError = ref('');
const audioError = ref('');
const cursorError = ref('');
const audioMode = computed(() => props.rtc.screenShareActive ? props.rtc.currentScreenShareAudioMode : defaultAudioMode.value);
const shareAudio = computed(() => props.rtc.screenShareActive ? props.sharedAudio : defaultShareAudio.value);
const shareBusy = computed(() => busy.value || props.rtc.screenShareQualityBusy || props.rtc.screenShareSourceBusy
  || props.rtc.busySources.includes(Track.Source.ScreenShare));
const selectedQuality = computed(() => screenShareQuality(props.quality, props.customQuality));

async function selectQuality(quality: ScreenShareQualityId, custom = props.customQuality) {
  if (shareBusy.value) return;
  if (quality === props.quality && custom.resolution === props.customQuality.resolution
    && custom.fps === props.customQuality.fps && custom.bitrateMbps === props.customQuality.bitrateMbps) return;
  busy.value = true; qualityError.value = '';
  try { if (!await props.changeQuality(quality, custom) && !props.rtc.notice) qualityError.value = '画质未能切换，已保留原画质。'; }
  catch { qualityError.value = '画质未能保存，请重试。'; }
  finally { busy.value = false; }
}
async function toggleAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  input.checked = shareAudio.value;
  if (shareBusy.value || audioMode.value === 'unavailable') return;
  busy.value = true; audioError.value = '';
  try {
    if (props.rtc.screenShareActive) {
      if (!await props.changeAudio(enabled) && !props.rtc.notice) audioError.value = '共享声音未能切换，请重试。';
    } else {
      saveScreenShareAudioPreference(audioMode.value, enabled);
      defaultShareAudio.value = enabled;
    }
  } catch { audioError.value = '共享声音设置未能保存，请重试。'; }
  finally { busy.value = false; input.checked = shareAudio.value; }
}
function toggleCursor(event: Event) {
  const input = event.target as HTMLInputElement;
  cursorError.value = '';
  try {
    saveScreenSharePreferences({ hideCursor: input.checked, hideBorder: false });
    hideCursor.value = input.checked;
  } catch { cursorError.value = '光标设置未能保存，请重试。'; }
  input.checked = hideCursor.value;
}
watch(() => [props.active, props.rtc.screenShareActive], async ([active, sharing], _, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  if (!active) return;
  cursorError.value = '';
  try { hideCursor.value = readScreenSharePreferences().hideCursor; }
  catch { cursorError.value = '无法读取光标设置，请重新选择。'; }
  audioError.value = '';
  loadingAudio.value = false;
  if (sharing) return;
  loadingAudio.value = true;
  try {
    const state = await resolveNativeScreenAudioCapability(window.lycanDesktop!.getNativeMediaCapabilities());
    if (cancelled) return;
    defaultAudioMode.value = state.mode;
    if (state.failed) throw new Error('audioCapabilitiesUnavailable');
    defaultShareAudio.value = readScreenShareAudioPreference(state.mode);
  } catch {
    if (!cancelled) { defaultAudioMode.value = 'unavailable'; audioError.value = '无法读取共享声音设置，请重新打开此页面。'; }
  } finally { if (!cancelled) loadingAudio.value = false; }
}, { immediate: true });

</script>

<template>
  <section class="settings-section">
    <section class="settings-block">
      <h2>共享画面</h2>
      <p>调整当前及下次共享的画质。录像画质可单独设置。</p>
      <SegmentedControl :model-value="quality" :options="SCREEN_SHARE_QUALITIES" label="共享画质"
        :disabled="shareBusy" :aria-busy="shareBusy" @update:model-value="selectQuality" />
      <p class="share-quality-description"><strong>{{ selectedQuality.description }}</strong><span>{{ selectedQuality.guidance }}</span></p>
      <ExpandSection :open="quality === 'custom'">
        <ScreenShareCustomQuality :model-value="customQuality" :disabled="shareBusy" @update:model-value="selectQuality('custom', $event)" />
      </ExpandSection>
      <InlineFeedback :message="qualityError" />
      <div class="settings-toggle-group">
        <div class="settings-toggle">
          <span><strong>共享声音</strong><small>{{ rtc.screenShareAudioRestricted ? '远控画面不包含电脑声音，语音通话不受影响。'
            : audioMode === 'systemMix' ? '包含全部电脑声音，可能产生回声。'
              : audioMode === 'process' ? '共享所选应用的声音，与录制声音分开控制。' : loadingAudio || audioError ? '' : '当前系统不支持共享声音。' }}</small></span>
          <input type="checkbox" aria-label="共享声音" :checked="shareAudio" :disabled="shareBusy || loadingAudio || audioMode === 'unavailable' || rtc.screenShareAudioRestricted" @change="toggleAudio" />
        </div>
        <InlineFeedback :message="audioError" :pending="loadingAudio ? '正在读取声音设置…' : ''" />
        <div class="settings-toggle">
          <span><strong>隐藏共享画面中的光标</strong><small>选择共享画面是否显示鼠标指针，下次共享生效。</small></span>
          <input type="checkbox" aria-label="隐藏共享画面中的光标" :checked="hideCursor" @change="toggleCursor" />
        </div>
        <InlineFeedback :message="cursorError" />
      </div>
      <ProjectAttribution>画面与应用声音采集基于 <a href="https://github.com/obsproject/obs-studio" target="_blank" rel="noopener noreferrer">OBS Studio</a>。</ProjectAttribution>
    </section>
  </section>
</template>

<style scoped>
.share-quality-description { display: grid; gap: 2px; min-height: 3em; }
.share-quality-description strong { color: var(--text); font-size: 14px; }
</style>

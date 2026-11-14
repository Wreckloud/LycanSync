<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Track } from 'livekit-client';
import { ChevronRight } from '@lucide/vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProjectAttribution from '../ProjectAttribution.vue';
import RangeValue from '../RangeValue.vue';
import ExpandSection from '../ExpandSection.vue';
import type { useAudioPreferences } from '../../rtc/useAudioPreferences';
import type { useRtcRoom } from '../../rtc/useRtcRoom';
import type { useMicrophoneTest } from '../../rtc/useMicrophoneTest';
import type { useMicrophoneDevices } from '../../rtc/useMicrophoneDevices';
import type { useAudioOutput } from '../../rtc/useAudioOutput';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP } from '../../rtc/audioPreferences';

const props = defineProps<{
  desktop: boolean;
  preferences: ReturnType<typeof useAudioPreferences>;
  rtc: Pick<UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>,
    'status' | 'busySources' | 'setMicrophoneProcessing' | 'setMicrophoneInputGain'>;
  microphoneTest: UnwrapNestedRefs<ReturnType<typeof useMicrophoneTest>>;
  microphoneDevices: UnwrapNestedRefs<ReturnType<typeof useMicrophoneDevices>>;
  audioOutput: ReturnType<typeof useAudioOutput>;
  inputLevelPercent: number;
  active: boolean;
}>();
const processing = computed(() => props.preferences.processing);
const supportedProcessing = computed(() => [processing.value.noiseSuppression,
  processing.value.autoGainControl, processing.value.voiceEnhancement,
  processing.value.echoCancellation]);
const processingEnabled = computed(() => supportedProcessing.value.every(Boolean));
const processingPartial = computed(() => !processingEnabled.value && supportedProcessing.value.some(Boolean));
const inputGain = computed(() => props.preferences.inputGain.value);
const outputVolume = computed(() => props.preferences.outputVolume.value);
const screenShareVolume = computed(() => props.preferences.screenShareVolume.value);
const shareVolumeOpen = ref(false);
const shareVolumeId = useId();
const levelSegments = Array.from({ length: 16 }, (_, index) => index + 1);
const displayedInputLevel = computed(() => props.microphoneTest.state === 'idle'
  ? props.inputLevelPercent : props.microphoneTest.inputLevelPercent);

function refreshDevices() {
  if (!props.active) return;
  void props.microphoneDevices.refresh();
  void props.audioOutput.refresh();
}

watch(() => props.active, (isActive) => {
  if (isActive) refreshDevices();
  else void props.microphoneTest.stop();
});
onMounted(() => {
  refreshDevices();
  window.addEventListener('focus', refreshDevices);
});
onUnmounted(() => window.removeEventListener('focus', refreshDevices));

function toggleTest() {
  if (props.microphoneTest.state === 'idle') void props.microphoneTest.start();
  else void props.microphoneTest.stop();
}

function updateProcessing(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  if (props.preferences.setProcessing({ echoCancellation: enabled, noiseSuppression: enabled,
    autoGainControl: enabled, voiceEnhancement: enabled })) {
    void props.rtc.setMicrophoneProcessing(props.preferences.processing);
  }
}

function updateInputGain(gain: number) {
  if (props.preferences.setInputGain(gain)) {
    void props.rtc.setMicrophoneInputGain(props.preferences.inputGain.value);
  }
}
</script>

<template>
  <div class="settings-section audio-settings">
    <section class="settings-block">
      <h2>输入</h2>
      <label class="settings-range-row"><span>麦克风</span>
        <select aria-label="麦克风设备" :value="preferences.inputDeviceId.value" :disabled="microphoneDevices.changing"
          @focus="microphoneDevices.refresh()"
          @pointerdown="($event.currentTarget as HTMLElement).matches(':focus') && microphoneDevices.refresh()"
          @change="microphoneDevices.select(($event.target as HTMLSelectElement).value)">
          <option value="default">{{ desktop ? '系统默认通讯设备' : '系统默认麦克风' }}</option>
          <option v-if="preferences.inputDeviceId.value !== 'default'
            && !microphoneDevices.devices.some(device => device.id === preferences.inputDeviceId.value)"
            :value="preferences.inputDeviceId.value" disabled>所选设备不可用</option>
          <option v-for="device in microphoneDevices.devices" :key="device.id" :value="device.id">{{ device.label }}</option>
        </select>
      </label>
      <p>选择用于语音通话和麦克风试听的输入设备。</p>
      <InlineFeedback :message="microphoneDevices.notice" />
      <div class="settings-range-row">
        <span><label for="settings-input-gain">麦克风输入音量</label><RangeValue :value="inputGain" :active="active" label="重置麦克风输入音量" @reset="updateInputGain($event)">{{ Math.round(inputGain * 100) }}%</RangeValue></span>
        <input id="settings-input-gain" type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP"
          :value="inputGain" @input="updateInputGain(Number(($event.target as HTMLInputElement).value))" />
      </div>
      <div class="settings-meter">
        <span>输入等级 <strong>{{ displayedInputLevel }}%</strong></span>
        <div role="meter" aria-label="麦克风输入等级" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="displayedInputLevel">
          <i v-for="segment in levelSegments" :key="segment" :class="{ 'is-active': segment * 100 / levelSegments.length <= displayedInputLevel }" />
        </div>
      </div>
      <ProjectAttribution>通话与共享传输由 <a href="https://github.com/livekit/livekit" target="_blank" rel="noopener noreferrer">LiveKit</a> 提供支持。</ProjectAttribution>
    </section>
    <section class="settings-block">
      <h2>麦克风试听</h2>
      <p>听听自己的麦克风效果，建议戴上耳机试听。</p>
      <button type="button" class="settings-button" :disabled="microphoneTest.state === 'stopping'
        || (microphoneTest.state === 'idle' && (rtc.status === 'joining' || rtc.status === 'reconnecting'
          || rtc.busySources.includes(Track.Source.Microphone)))"
        @click="toggleTest">
        {{ microphoneTest.state === 'starting' ? '取消试听' : microphoneTest.state === 'listening' ? '停止麦克风试听'
          : microphoneTest.state === 'stopping' ? '停止麦克风试听' : '开始试听' }}
      </button>
      <InlineFeedback :message="microphoneTest.notice" :pending="microphoneTest.state === 'starting' ? '正在准备麦克风试听…' : microphoneTest.state === 'stopping' ? '正在停止试听…' : ''" />
    </section>
    <section class="settings-block">
      <h2>声音处理</h2>
      <label class="settings-toggle">
        <span><strong>智能声音处理</strong><small>{{ desktop ? '程序使用 RNNoise 降噪，配合回声消除、低频过滤和自动音量调整，让人声更清楚、音量更平稳。' : '使用浏览器的降噪、回声消除和自动音量调整，配合低频过滤，让说话更清楚。' }}</small></span>
        <input type="checkbox" aria-label="智能声音处理" :checked="processingEnabled" :indeterminate="processingPartial"
          :aria-checked="processingPartial ? 'mixed' : processingEnabled" @change="updateProcessing" />
      </label>
      <p v-if="processingPartial">当前沿用之前的单项设置。开启后应用完整的声音处理。</p>
      <ProjectAttribution v-if="desktop">降噪由 <a href="https://github.com/xiph/rnnoise" target="_blank" rel="noopener noreferrer">RNNoise 开源项目</a> 提供支持；回声消除、低频过滤与音量处理基于 <a href="https://github.com/dignifiedquire/sonora" target="_blank" rel="noopener noreferrer">Sonora</a>。</ProjectAttribution>
      <p v-if="!desktop">同时使用浏览器的回声消除。</p>
    </section>
    <section class="settings-block">
      <h2>输出</h2>
      <label class="settings-range-row"><span>输出设备</span>
        <select aria-label="声音输出设备" :value="preferences.outputDeviceId.value" :disabled="audioOutput.changing.value"
          @focus="audioOutput.refresh()"
          @pointerdown="($event.currentTarget as HTMLElement).matches(':focus') && audioOutput.refresh()"
          @change="audioOutput.select(($event.target as HTMLSelectElement).value)">
          <option value="default">系统默认输出设备</option>
          <option v-if="preferences.outputDeviceId.value !== 'default'
            && !audioOutput.devices.value.some(device => device.id === preferences.outputDeviceId.value)"
            :value="preferences.outputDeviceId.value" disabled>所选设备不可用</option>
          <option v-for="device in audioOutput.devices.value" :key="device.id" :value="device.id"
            :disabled="!audioOutput.supported">{{ device.label }}</option>
        </select>
      </label>
      <p>{{ audioOutput.supported ? '选择播放通话、共享画面的声音、提示音和试听的设备。' : '当前浏览器只能使用系统默认输出。' }}</p>
      <InlineFeedback :message="audioOutput.notice.value" />
      <div class="settings-range-row"><span><label for="settings-output-volume">lycanclaw 总输出音量</label><RangeValue :value="outputVolume" :active="active" label="重置总输出音量" @reset="preferences.setOutputVolume($event)">{{ Math.round(outputVolume * 100) }}%</RangeValue></span>
        <input id="settings-output-volume" type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="outputVolume"
          aria-label="lycanclaw 总输出音量" @input="preferences.setOutputVolume(Number(($event.target as HTMLInputElement).value))" /></div>
      <p>调整本应用的整体播放音量。</p>
      <label class="settings-toggle"><span><strong>平衡成员语音音量</strong>
        <small>让不同成员的说话音量更接近，也可继续单独调节。</small></span>
        <input type="checkbox" :checked="preferences.voiceVolumeBalance.value"
          @change="preferences.setVoiceVolumeBalance(($event.target as HTMLInputElement).checked)" /></label>
      <div>
        <button type="button" class="disclosure-trigger" :aria-expanded="shareVolumeOpen" :aria-controls="shareVolumeId"
          @click="shareVolumeOpen = !shareVolumeOpen">
          <ChevronRight :size="12" aria-hidden="true" class="disclosure-arrow" :class="{ 'is-open': shareVolumeOpen }" />
          观看共享画面的音量<span class="disclosure-value">{{ Math.round(screenShareVolume * 100) }}%</span>
        </button>
        <ExpandSection :open="shareVolumeOpen" :id="shareVolumeId">
          <div class="settings-range-row"><span><label for="settings-share-volume">共享画面音量</label><RangeValue :value="screenShareVolume" :active="active" label="重置共享画面音量" @reset="preferences.setScreenShareVolume($event)">{{ Math.round(screenShareVolume * 100) }}%</RangeValue></span>
            <input id="settings-share-volume" type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="screenShareVolume"
              aria-label="共享画面音量" @input="preferences.setScreenShareVolume(Number(($event.target as HTMLInputElement).value))" /></div>
          <p>调整其他成员共享画面中的游戏、视频等声音，仅影响你听到的音量，同时受总输出音量控制。</p>
        </ExpandSection>
      </div>
    </section>
  </div>
</template>

<style scoped>
.audio-settings { max-width: 820px; }
.settings-toggle input:indeterminate { border-color: var(--accent); }
.settings-toggle input:indeterminate::after { transform: translateX(8px); background: var(--accent); }
.settings-meter { display: grid; gap: 7px; margin-top: 18px; color: var(--muted); font-size: 13px; }
.settings-meter > span { display: flex; justify-content: space-between; }
.settings-meter strong { color: var(--accent); }
.settings-meter > div { display: flex; gap: 3px; height: 12px; }
.settings-meter i { flex: 1; border-radius: 2px; background: var(--panel-raised); }
.settings-meter i.is-active { background: var(--accent); }
</style>

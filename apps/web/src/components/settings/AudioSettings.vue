<script setup lang="ts">
import { computed, watch } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Track } from 'livekit-client';
import InlineFeedback from '../InlineFeedback.vue';
import type { useAudioPreferences } from '../../rtc/useAudioPreferences';
import type { useRtcRoom } from '../../rtc/useRtcRoom';
import type { useMicrophoneTest } from '../../rtc/useMicrophoneTest';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, type AudioProcessingSettings } from '../../rtc/audioPreferences';

const props = defineProps<{
  desktop: boolean;
  preferences: ReturnType<typeof useAudioPreferences>;
  rtc: UnwrapNestedRefs<ReturnType<typeof useRtcRoom>>;
  microphoneTest: UnwrapNestedRefs<ReturnType<typeof useMicrophoneTest>>;
  inputLevelPercent: number;
  active: boolean;
}>();
const processing = computed(() => props.preferences.processing);
const inputGain = computed(() => props.preferences.inputGain.value);
const outputVolume = computed(() => props.preferences.outputVolume.value);
const screenShareVolume = computed(() => props.preferences.screenShareVolume.value);
const levelSegments = Array.from({ length: 16 }, (_, index) => index + 1);
const displayedInputLevel = computed(() => props.microphoneTest.state === 'idle'
  ? props.inputLevelPercent : props.microphoneTest.inputLevelPercent);

watch(() => props.active, (isActive) => { if (!isActive) void props.microphoneTest.stop(); });

function toggleTest() {
  if (props.microphoneTest.state === 'idle') void props.microphoneTest.start();
  else void props.microphoneTest.stop();
}

function updateProcessing(setting: keyof AudioProcessingSettings, event: Event) {
  if (props.preferences.setProcessing(setting, (event.target as HTMLInputElement).checked)) {
    void props.rtc.setMicrophoneProcessing(props.preferences.processing);
  }
}

function updateInputGain(event: Event) {
  const gain = Number((event.target as HTMLInputElement).value);
  if (props.preferences.setInputGain(gain)) {
    void props.rtc.setMicrophoneInputGain(props.preferences.inputGain.value);
  }
}
</script>

<template>
  <div class="settings-section audio-settings">
    <p class="settings-intro">更改会立即应用并保存在这台设备。</p>
    <section class="settings-block">
      <h2>输入</h2>
      <p>Windows 桌面使用系统默认通讯输入设备；浏览器使用 Chromium 当前默认设备。</p>
      <div class="settings-range-row">
        <label for="settings-input-gain">麦克风输入音量 <strong>{{ Math.round(inputGain * 100) }}%</strong></label>
        <input id="settings-input-gain" type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP"
          :value="inputGain" @input="updateInputGain" />
      </div>
      <div class="settings-meter">
        <span>输入等级 <strong>{{ displayedInputLevel }}%</strong></span>
        <div role="meter" aria-label="麦克风输入等级" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="displayedInputLevel">
          <i v-for="segment in levelSegments" :key="segment" :class="{ 'is-active': segment * 100 / levelSegments.length <= displayedInputLevel }" />
        </div>
      </div>
    </section>
    <section class="settings-block">
      <h2>声音处理</h2>
      <label class="settings-toggle" :class="{ 'is-disabled': desktop }">
        <span><strong>回声消除</strong><small>{{ desktop ? '桌面原生麦克风暂不支持软件回声消除，建议使用耳机。' : '由 Chromium 麦克风采集器处理。' }}</small></span>
        <input type="checkbox" :checked="desktop ? false : processing.echoCancellation" :disabled="desktop"
          @change="updateProcessing('echoCancellation', $event)" />
      </label>
      <label class="settings-toggle"><span><strong>环境降噪</strong><small>减少持续背景噪声；不能完全消除键盘或鼠标声。</small></span>
        <input type="checkbox" :checked="processing.noiseSuppression" @change="updateProcessing('noiseSuppression', $event)" /></label>
      <label class="settings-toggle"><span><strong>自动增益</strong><small>根据输入电平调整人声响度。</small></span>
        <input type="checkbox" :checked="processing.autoGainControl" @change="updateProcessing('autoGainControl', $event)" /></label>
      <label class="settings-toggle"><span><strong>{{ desktop ? '低频过滤' : '人声增强' }}</strong>
        <small>{{ desktop ? '过滤低频杂音。输入音量在处理后应用。' : '包含低频过滤和轻量压缩；输入音量在压缩前应用。' }}</small></span>
        <input type="checkbox" :checked="processing.voiceEnhancement" @change="updateProcessing('voiceEnhancement', $event)" /></label>
    </section>
    <section class="settings-block">
      <h2>输出</h2>
      <p>成员音量与共享声音音量分开控制，并受 LycanSync 总输出音量影响。</p>
      <label class="settings-toggle"><span><strong>平衡成员语音音量</strong>
        <small>在本机拉近不同成员的人声响度，不处理共享声音。成员音量、总音量和静音仍由你控制。</small></span>
        <input type="checkbox" :checked="preferences.voiceVolumeBalance.value"
          @change="preferences.setVoiceVolumeBalance(($event.target as HTMLInputElement).checked)" /></label>
      <label class="settings-range-row"><span>LycanSync 总输出音量 <strong>{{ Math.round(outputVolume * 100) }}%</strong></span>
        <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="outputVolume"
          aria-label="LycanSync 总输出音量" @input="preferences.setOutputVolume(Number(($event.target as HTMLInputElement).value))" /></label>
      <label class="settings-range-row"><span>全局共享声音音量 <strong>{{ Math.round(screenShareVolume * 100) }}%</strong></span>
        <input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="screenShareVolume"
          aria-label="全局共享声音音量" @input="preferences.setScreenShareVolume(Number(($event.target as HTMLInputElement).value))" /></label>
    </section>
    <section class="settings-block">
      <h2>麦克风试听</h2>
      <p>无需加入语音，试听只在本机播放。建议使用耳机。</p>
      <button type="button" class="settings-button" :disabled="microphoneTest.state === 'stopping'
        || (microphoneTest.state === 'idle' && (rtc.status === 'joining' || rtc.status === 'reconnecting'
          || rtc.busySources.includes(Track.Source.Microphone)))"
        @click="toggleTest">
        {{ microphoneTest.state === 'starting' ? '取消试听' : microphoneTest.state === 'listening' ? '停止麦克风试听'
          : microphoneTest.state === 'stopping' ? '正在停止' : '开始试听' }}
      </button>
      <InlineFeedback :message="microphoneTest.notice" />
    </section>
  </div>
</template>

<style scoped>
.audio-settings { max-width: 860px; }
.settings-meter { display: grid; gap: 7px; margin-top: 18px; color: var(--muted); font-size: 13px; }
.settings-meter > span { display: flex; justify-content: space-between; }
.settings-meter strong { color: var(--accent); }
.settings-meter > div { display: flex; gap: 3px; height: 12px; }
.settings-meter i { flex: 1; border-radius: 2px; background: var(--panel-raised); }
.settings-meter i.is-active { background: var(--accent); }
.settings-range-row { display: grid; gap: 9px; margin-top: 16px; color: var(--text); font-size: 14px; }
.settings-range-row span, .settings-range-row label { display: flex; justify-content: space-between; }
.settings-range-row strong { color: var(--accent); }
.settings-range-row input { width: 100%; margin: 0; accent-color: var(--accent); }
</style>

<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import { CALL_SOUND_EVENTS, type CallSoundEvent, type useCallSoundPreferences } from '../../settings/useCallSoundPreferences';
import type { useCallSounds } from '../../rtc/useCallSounds';

const props = defineProps<{ active: boolean; preferences: ReturnType<typeof useCallSoundPreferences>; sounds: ReturnType<typeof useCallSounds> }>();
const previewError = ref('');
let previewVersion = 0;
function stopPreview() { previewVersion++; props.sounds.stopPreview(); }
async function preview(event: CallSoundEvent) {
  const version = ++previewVersion;
  previewError.value = '';
  if (!await props.sounds.preview(event) && props.active && version === previewVersion) previewError.value = '无法试听，请确认总输出和提示音未静音，且系统允许播放声音。';
}
watch(() => props.active, active => { if (!active) stopPreview(); });
onScopeDispose(stopPreview);
</script>

<template>
  <section class="settings-block call-sound-settings">
    <h2>本机提示音</h2>
    <p>调整你听到的提示音，不影响朋友的语音或你播放给朋友的入场音效。</p>
    <label class="settings-range-row"><span>提示音音量 <strong>{{ Math.round(preferences.volume.value * 100) }}%</strong></span>
      <input type="range" min="0" max="100" step="1" aria-label="提示音音量" :value="Math.round(preferences.volume.value * 100)"
        @change="preferences.setVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
    </label>
    <div v-for="event in CALL_SOUND_EVENTS" :key="event.id" class="call-sound-row">
      <label><input type="checkbox" :checked="preferences.enabled[event.id]"
        @change="preferences.setEnabled(event.id, ($event.target as HTMLInputElement).checked)" />{{ event.label }}</label>
      <button type="button" :aria-label="`试听${event.label}`" @click="preview(event.id)">试听</button>
    </div>
    <label><input type="checkbox" :checked="preferences.customEntrances.value"
      @change="preferences.setCustomEntrances(($event.target as HTMLInputElement).checked)" />播放成员自定义入场音效</label>
    <small>关闭自定义入场音效后使用默认提示音；关闭“成员加入语音”则都不播放。音量跟随提示音设置。</small>
    <InlineFeedback :message="preferences.error.value || previewError" />
  </section>
</template>

<style scoped>
.call-sound-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.call-sound-row label, .call-sound-settings > label:not(.settings-range-row) { display: flex; align-items: center; gap: 8px; }
</style>

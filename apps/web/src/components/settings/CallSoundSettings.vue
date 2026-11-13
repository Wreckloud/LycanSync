<script setup lang="ts">
import { onScopeDispose, ref, useId, watch } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import RangeValue from '../RangeValue.vue';
import { DEFAULT_CALL_SOUND_VOLUME, CALL_SOUND_EVENTS, type CallSoundEvent, type useCallSoundPreferences } from '../../settings/useCallSoundPreferences';
import type { useCallSounds } from '../../rtc/useCallSounds';

const props = defineProps<{ active: boolean; preferences: ReturnType<typeof useCallSoundPreferences>; sounds: ReturnType<typeof useCallSounds> }>();
const previewError = ref('');
const eventIdPrefix = useId();
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
    <p>调整加入语音、麦克风切换等操作的提示音。</p>
    <div class="settings-range-row"><span><label for="settings-call-sound-volume">提示音音量</label><RangeValue :value="preferences.volume.value" :default-value="DEFAULT_CALL_SOUND_VOLUME" label="重置提示音音量" @reset="preferences.setVolume(DEFAULT_CALL_SOUND_VOLUME)">{{ Math.round(preferences.volume.value * 100) }}%</RangeValue></span>
      <input id="settings-call-sound-volume" type="range" min="0" max="100" step="1" aria-label="提示音音量" :value="Math.round(preferences.volume.value * 100)"
        @change="preferences.setVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
    </div>
    <div class="settings-toggle-group">
      <div v-for="event in CALL_SOUND_EVENTS" :key="event.id" class="settings-toggle call-sound-row">
        <label :for="`${eventIdPrefix}-${event.id}`">{{ event.label }}</label>
        <button type="button" :aria-label="`试听${event.label}`" @click="preview(event.id)">试听</button>
        <input :id="`${eventIdPrefix}-${event.id}`" type="checkbox" :checked="preferences.enabled[event.id]"
          @change="preferences.setEnabled(event.id, ($event.target as HTMLInputElement).checked)" />
      </div>
      <label class="settings-toggle">
        <span><strong>播放成员自定义入场音效</strong><small>成员加入语音时播放自定义音效，音量跟随提示音设置。</small></span>
        <input type="checkbox" :checked="preferences.customEntrances.value"
          @change="preferences.setCustomEntrances(($event.target as HTMLInputElement).checked)" />
      </label>
    </div>
    <InlineFeedback :message="preferences.error.value || previewError" />
  </section>
</template>

<style scoped>
.call-sound-row { min-height: 32px; cursor: default; }
.call-sound-row label { flex: 1; min-width: 0; font-weight: 500; cursor: pointer; }
</style>

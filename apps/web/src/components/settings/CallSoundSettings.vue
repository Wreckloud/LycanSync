<script setup lang="ts">
import { onScopeDispose, ref, useId, watch } from 'vue';
import { ChevronRight } from '@lucide/vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProjectAttribution from '../ProjectAttribution.vue';
import RangeValue from '../RangeValue.vue';
import ExpandSection from '../ExpandSection.vue';
import { CALL_SOUND_EVENTS, type CallSoundEvent, type useCallSoundPreferences } from '../../settings/useCallSoundPreferences';
import type { useCallSounds } from '../../rtc/useCallSounds';

const props = defineProps<{ active: boolean; preferences: ReturnType<typeof useCallSoundPreferences>; sounds: ReturnType<typeof useCallSounds> }>();
const previewError = ref('');
const eventIdPrefix = useId();
const moreSoundsOpen = ref(false);
const moreSoundsId = useId();
const commonSounds = CALL_SOUND_EVENTS.filter(event => ['participantJoined', 'participantLeft', 'microphoneOn', 'microphoneOff'].includes(event.id));
const moreSounds = CALL_SOUND_EVENTS.filter(event => !commonSounds.includes(event));
let previewVersion = 0;
function stopPreview() { previewVersion++; props.sounds.stopPreview(); }
async function preview(event: CallSoundEvent) {
  const version = ++previewVersion;
  previewError.value = '';
  if (!await props.sounds.preview(event) && props.active && version === previewVersion) previewError.value = '无法试听，请确认总输出和提示音未静音，且系统允许播放声音。';
}
watch(() => props.active, active => { if (!active) { stopPreview(); moreSoundsOpen.value = false; } });
onScopeDispose(stopPreview);
</script>

<template>
  <section class="settings-block call-sound-settings">
    <h2>本机提示音</h2>
    <p>调整加入语音、麦克风切换和录制等操作的提示音。</p>
    <div class="settings-range-row"><span><label for="settings-call-sound-volume">提示音音量</label><RangeValue :value="preferences.volume.value" :active="active" label="重置提示音音量" @reset="preferences.setVolume($event)">{{ Math.round(preferences.volume.value * 100) }}%</RangeValue></span>
      <input id="settings-call-sound-volume" type="range" min="0" max="100" step="1" aria-label="提示音音量" :value="Math.round(preferences.volume.value * 100)"
        @change="preferences.setVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
    </div>
    <ProjectAttribution>提示音由 <a href="https://github.com/nana-4/materia-sound-theme" title="查看音效存档（GitHub）" target="_blank" rel="noopener noreferrer">Google Material Design</a> 提供，采用 <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> 许可。</ProjectAttribution>
  </section>
  <section class="settings-block call-sound-settings">
    <h2>提示音开关</h2>
    <div class="settings-toggle-group">
      <div v-for="event in commonSounds" :key="event.id" class="settings-toggle call-sound-row">
        <label :for="`${eventIdPrefix}-${event.id}`">{{ event.label }}</label>
        <button type="button" :aria-label="`试听${event.label}`" @click="preview(event.id)">试听</button>
        <input :id="`${eventIdPrefix}-${event.id}`" type="checkbox" :checked="preferences.enabled[event.id]"
          @change="preferences.setEnabled(event.id, ($event.target as HTMLInputElement).checked)" />
      </div>
      <ExpandSection :open="moreSoundsOpen" :id="moreSoundsId">
        <div class="settings-toggle-group">
          <div v-for="event in moreSounds" :key="event.id" class="settings-toggle call-sound-row">
            <label :for="`${eventIdPrefix}-${event.id}`">{{ event.label }}</label>
            <button type="button" :aria-label="`试听${event.label}`" @click="preview(event.id)">试听</button>
            <input :id="`${eventIdPrefix}-${event.id}`" type="checkbox" :checked="preferences.enabled[event.id]"
              @change="preferences.setEnabled(event.id, ($event.target as HTMLInputElement).checked)" />
          </div>
        </div>
      </ExpandSection>
      <button type="button" class="disclosure-trigger" :aria-expanded="moreSoundsOpen" :aria-controls="moreSoundsId" @click="moreSoundsOpen = !moreSoundsOpen">
        <ChevronRight :size="12" aria-hidden="true" class="disclosure-arrow" :class="{ 'is-open': moreSoundsOpen }" />
        {{ moreSoundsOpen ? '收起其他提示音' : `展开其他 ${moreSounds.length} 项提示音` }}
      </button>
    </div>
    <InlineFeedback :message="preferences.error.value || previewError" />
  </section>
</template>

<style scoped>
.call-sound-row { min-height: 32px; cursor: default; }
.call-sound-row label { flex: 1; min-width: 0; font-weight: 500; cursor: pointer; }
</style>

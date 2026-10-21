<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SCREEN_SHARE_RESOLUTIONS, SCREEN_SHARE_FRAME_RATES, SCREEN_SHARE_BITRATE_MIN_MBPS, SCREEN_SHARE_BITRATE_MAX_MBPS,
  SCREEN_SHARE_BITRATE_STEP_MBPS, screenShareQuality, validateCustomScreenShareQuality, type CustomScreenShareQuality } from '../rtc/screenShareQuality';
import InlineFeedback from './InlineFeedback.vue';

const props = defineProps<{ modelValue: CustomScreenShareQuality; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [quality: CustomScreenShareQuality] }>();
const recommendedMbps = computed(() => screenShareQuality('custom', {
  resolution: props.modelValue.resolution, fps: props.modelValue.fps,
}).bitrate / 1_000_000);
const bitrateDraft = ref(String(props.modelValue.bitrateMbps ?? recommendedMbps.value));
const bitrateError = ref('');

function update(field: 'resolution' | 'fps', event: Event) {
  const select = event.target as HTMLSelectElement;
  const value = Number(select.value);
  select.value = String(props.modelValue[field]);
  if (!props.disabled) emit('update:modelValue', { ...props.modelValue, [field]: value });
}

function applyBitrate() {
  if (props.disabled) return;
  let quality: CustomScreenShareQuality;
  try { quality = validateCustomScreenShareQuality({ ...props.modelValue, bitrateMbps: Number(bitrateDraft.value) }); }
  catch {
    bitrateError.value = `请输入 ${SCREEN_SHARE_BITRATE_MIN_MBPS}–${SCREEN_SHARE_BITRATE_MAX_MBPS} Mbps，步长 ${SCREEN_SHARE_BITRATE_STEP_MBPS}。`;
    return;
  }
  bitrateError.value = '';
  emit('update:modelValue', quality);
}

function resetBitrate() {
  if (props.disabled) return;
  bitrateDraft.value = String(recommendedMbps.value);
  bitrateError.value = '';
  if (props.modelValue.bitrateMbps !== undefined) {
    emit('update:modelValue', { resolution: props.modelValue.resolution, fps: props.modelValue.fps });
  }
}

watch(() => [props.modelValue.resolution, props.modelValue.fps, props.modelValue.bitrateMbps], () => {
  bitrateDraft.value = String(props.modelValue.bitrateMbps ?? recommendedMbps.value);
  bitrateError.value = '';
});
</script>

<template>
  <div class="custom-share-quality">
    <div class="custom-share-selects">
      <label>分辨率上限<select :value="modelValue.resolution" :disabled="disabled" @change="update('resolution', $event)">
        <option v-for="resolution in SCREEN_SHARE_RESOLUTIONS" :key="resolution" :value="resolution">{{ resolution === 1440 ? '1440p（2K）' : `${resolution}p` }}</option>
      </select></label>
      <label>目标帧率<select :value="modelValue.fps" :disabled="disabled" @change="update('fps', $event)">
        <option v-for="fps in SCREEN_SHARE_FRAME_RATES" :key="fps" :value="fps">{{ fps }} FPS</option>
      </select></label>
    </div>
    <details class="custom-share-bitrate">
      <summary>码率设置<span>{{ modelValue.bitrateMbps === undefined ? '推荐' : `手动 · ${modelValue.bitrateMbps} Mbps` }}</span></summary>
      <div class="custom-share-bitrate-controls">
        <label>主画面码率上限<span class="custom-share-bitrate-input">
          <input v-model="bitrateDraft" type="number" :min="SCREEN_SHARE_BITRATE_MIN_MBPS" :max="SCREEN_SHARE_BITRATE_MAX_MBPS"
            :step="SCREEN_SHARE_BITRATE_STEP_MBPS" :disabled="disabled" @keydown.enter.prevent.stop="applyBitrate" />Mbps
        </span></label>
        <button type="button" class="settings-button" :disabled="disabled || Number(bitrateDraft) === modelValue.bitrateMbps" @click="applyBitrate">应用</button>
        <button type="button" class="settings-button" :disabled="disabled || (modelValue.bitrateMbps === undefined && Number(bitrateDraft) === recommendedMbps)"
          @click="resetBitrate">恢复推荐</button>
      </div>
      <InlineFeedback :message="bitrateError" :status="`推荐 ${recommendedMbps} Mbps；这是上限，不是固定流量。缩略层与声音另计。`" />
    </details>
    <label class="custom-share-auto"><input type="checkbox" disabled />根据网络状况自动调整<small>暂未开放</small></label>
  </div>
</template>

<style scoped>
.custom-share-quality { display: grid; gap: 8px; font-size: 12px; }
.custom-share-selects { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.custom-share-selects label { display: grid; flex: 1; gap: 4px; min-width: 100px; color: var(--muted); }
.custom-share-selects select { width: 100%; min-height: 32px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--background); color: var(--text); font: inherit; }
.custom-share-bitrate { min-width: 0; }
.custom-share-bitrate summary { cursor: pointer; color: var(--muted); line-height: 24px; }
.custom-share-bitrate summary span { float: right; color: var(--text); }
.custom-share-bitrate-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
.custom-share-bitrate-controls label { display: grid; flex: 1; gap: 4px; min-width: 100px; color: var(--muted); }
.custom-share-bitrate-input { display: flex; align-items: center; gap: 6px; }
.custom-share-bitrate-input input { width: 100%; min-width: 0; min-height: 32px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--background); color: var(--text); font: inherit; }
.custom-share-bitrate-controls button { min-height: 32px; padding: 4px 8px; font-size: inherit; }
.custom-share-auto { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.custom-share-auto input { margin: 0; }
.custom-share-auto small { margin-left: auto; white-space: nowrap; }
</style>

<script setup lang="ts">
import type { VoiceMode } from '../settings/useAudioShortcuts';

defineProps<{ modelValue: VoiceMode; binding?: string; disabled?: boolean; pushToTalkDisabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [mode: VoiceMode] }>();
</script>

<template>
  <div class="voice-mode-switch" role="group" aria-label="发言模式" :class="{ 'is-push-to-talk': modelValue === 'pushToTalk' }">
    <span class="voice-mode-slider" aria-hidden="true" />
    <button type="button" :aria-pressed="modelValue === 'voice'" :disabled="disabled"
      @click="emit('update:modelValue', 'voice')">自由发言</button>
    <button type="button" :aria-pressed="modelValue === 'pushToTalk'" :disabled="disabled || pushToTalkDisabled"
      :title="binding || '未设置'"
      @click="emit('update:modelValue', 'pushToTalk')">按键说话<small>{{ binding || '(未设置)' }}</small></button>
  </div>
</template>

<style scoped>
.voice-mode-switch { position: relative; isolation: isolate; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 3px; border-radius: 6px; background: var(--background); }
.voice-mode-slider { position: absolute; z-index: -1; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 10px) / 2); border-radius: 4px; background: var(--panel-soft); transition: transform var(--motion-expand-duration) var(--motion-ease); }
.is-push-to-talk .voice-mode-slider { transform: translateX(calc(100% + 4px)); }
.voice-mode-switch button { display: flex; justify-content: center; align-items: center; gap: 4px; min-width: 0; min-height: 32px; padding: 4px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font: inherit; white-space: nowrap; cursor: pointer; }
.voice-mode-switch button[aria-pressed='true'] { color: var(--text); }
.voice-mode-switch button:not(:disabled):hover { background: transparent; color: var(--text); }
.voice-mode-switch small { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.voice-mode-switch button:disabled { opacity: .45; cursor: not-allowed; }
</style>

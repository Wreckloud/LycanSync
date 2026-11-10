<script setup lang="ts">
import { computed } from 'vue';
import type { VoiceMode } from '../settings/useAudioShortcuts';
import SegmentedControl from './SegmentedControl.vue';

const props = defineProps<{ modelValue: VoiceMode; binding?: string; disabled?: boolean; pushToTalkDisabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [mode: VoiceMode] }>();
const options = computed(() => [
  { id: 'voice' as const, label: '自由发言' },
  { id: 'pushToTalk' as const, label: '按键说话', disabled: props.pushToTalkDisabled, title: props.binding || '未设置' },
]);
</script>

<template>
  <SegmentedControl class="voice-mode-switch" :model-value="modelValue" :options="options" label="发言模式"
    :disabled="disabled" @update:model-value="emit('update:modelValue', $event)">
    <template #default="{ option }">{{ option.label }}<small v-if="option.id === 'pushToTalk'">{{ binding || '(未设置)' }}</small></template>
  </SegmentedControl>
</template>

<style scoped>
.voice-mode-switch small { overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
</style>

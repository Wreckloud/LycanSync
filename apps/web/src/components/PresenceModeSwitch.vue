<script setup lang="ts">
import SegmentedControl from './SegmentedControl.vue';
import type { PresenceMode } from '../presence/usePresencePreference';

const props = defineProps<{ mode?: PresenceMode; ready?: boolean; syncing?: boolean; error?: string; active: boolean }>();
const emit = defineEmits<{ select: [mode: PresenceMode] }>();
const options = [{ id: 'online', label: '在线' }, { id: 'invisible', label: '隐身' }] as const;

function select(mode: PresenceMode) {
  if (props.ready && props.active && (mode !== props.mode || props.error)) emit('select', mode);
}
</script>

<template>
  <SegmentedControl class="presence-mode-switch" :model-value="mode" :options="options" label="在线状态"
    :aria-busy="syncing || !ready" :disabled="!ready || !active" @update:model-value="select">
    <template #default="{ option }"><span class="presence-option-dot" :class="option.id" aria-hidden="true" />{{ option.label }}</template>
  </SegmentedControl>
</template>

<style scoped>
.presence-mode-switch { flex-shrink: 0; width: 152px; }
</style>

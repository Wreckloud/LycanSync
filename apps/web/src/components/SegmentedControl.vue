<script setup lang="ts" generic="T extends string">
import { computed, ref } from 'vue';

const props = defineProps<{
  modelValue?: T; options: readonly { id: T; label: string; disabled?: boolean; title?: string }[];
  label: string; disabled?: boolean; tabs?: boolean; idPrefix?: string; controls?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();
const root = ref<HTMLElement | null>(null);
const selected = computed(() => props.options.findIndex(option => option.id === props.modelValue));

function navigate(event: KeyboardEvent, index: number) {
  if (props.disabled) return;
  const enabled = props.options.map((option, position) => option.disabled ? -1 : position).filter(position => position >= 0);
  if (!enabled.length) return;
  const current = enabled.indexOf(index);
  let next: number;
  if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length]!;
  else if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length]!;
  else if (event.key === 'Home') next = enabled[0]!;
  else if (event.key === 'End') next = enabled[enabled.length - 1]!;
  else return;
  event.preventDefault();
  event.stopPropagation();
  root.value?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  emit('update:modelValue', props.options[next]!.id);
}
</script>

<template>
  <div ref="root" class="segmented-control" :role="tabs ? 'tablist' : 'group'" :aria-label="label"
    :style="{ '--segment-count': options.length, '--segment-index': selected }">
    <span v-if="selected >= 0" class="segmented-slider" aria-hidden="true" />
    <button v-for="(option, index) in options" :key="option.id" type="button"
      :id="idPrefix ? `${idPrefix}-${option.id}` : undefined" :role="tabs ? 'tab' : undefined"
      :aria-selected="tabs ? modelValue === option.id : undefined" :aria-pressed="tabs ? undefined : modelValue === option.id"
      :aria-controls="controls" :tabindex="tabs && selected >= 0 && selected !== index ? -1 : undefined"
      :disabled="disabled || option.disabled" :title="option.title"
      @click="emit('update:modelValue', option.id)" @keydown="navigate($event, index)">
      <slot :option="option">{{ option.label }}</slot>
    </button>
  </div>
</template>

<style scoped>
.segmented-control { position: relative; isolation: isolate; display: grid; grid-template-columns: repeat(var(--segment-count), minmax(0, 1fr)); gap: 4px; min-width: 0; padding: 3px; border-radius: 6px; background: var(--background); }
.segmented-slider { position: absolute; z-index: -1; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px - (var(--segment-count) - 1) * 4px) / var(--segment-count)); border-radius: 4px; background: var(--panel-soft); transform: translateX(calc(var(--segment-index) * (100% + 4px))); transition: transform var(--motion-expand-duration) var(--motion-ease); pointer-events: none; }
.segmented-control > button { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; min-height: 32px; padding: 4px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font-size: 13px; white-space: nowrap; }
.segmented-control > button[aria-pressed='true'], .segmented-control > button[aria-selected='true'], .segmented-control > button:hover:not(:disabled) { background: transparent; color: var(--text); }
.segmented-control > button:disabled { opacity: .45; }
</style>

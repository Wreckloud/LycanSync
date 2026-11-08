<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Check, ChevronDown } from '@lucide/vue';
import type { PresenceMode } from '../../presence/usePresencePreference';

const props = defineProps<{ mode?: PresenceMode; ready?: boolean; syncing?: boolean; error?: string; active: boolean }>();
const emit = defineEmits<{ select: [mode: PresenceMode] }>();
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const highlighted = ref<PresenceMode | null>(null);
const modes = computed(() => props.mode === 'invisible' ? ['invisible', 'online'] as const : ['online', 'invisible'] as const);
const labels = { online: '在线', invisible: '隐身' };
const descriptions = {
  online: '向朋友显示在线或闲置，动态和上次在线时间按展示设置公开。',
  invisible: '向朋友显示离线，不更新动态和上次在线时间；仍可聊天、语音和共享。',
};
let pointerId: number | null = null;
let pointerMoved = false;
let pointerStartY = 0;

function close() {
  open.value = false;
  highlighted.value = null;
  pointerId = null;
}

function select(mode: PresenceMode) {
  close();
  trigger.value?.focus({ preventScroll: true });
  if (props.ready && props.active && (mode !== props.mode || props.error)) emit('select', mode);
}

function begin(event: PointerEvent) {
  if (event.button !== 0 || !props.ready || !props.active) return;
  event.preventDefault();
  if (open.value) { close(); return; }
  open.value = true;
  highlighted.value = props.mode ?? null;
  pointerId = event.pointerId;
  pointerMoved = false;
  pointerStartY = event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function move(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  if (Math.abs(event.clientY - pointerStartY) > 4) pointerMoved = true;
  highlighted.value = null;
  for (const option of menu.value?.querySelectorAll<HTMLElement>('[data-presence-mode]') ?? []) {
    const rect = option.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      highlighted.value = option.dataset.presenceMode as PresenceMode;
    }
  }
}

function finish(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  move(event);
  pointerId = null;
  if (pointerMoved) {
    if (highlighted.value) select(highlighted.value);
    else close();
  }
}

async function openKeyboard() {
  if (!props.ready || !props.active) return;
  open.value = true;
  await nextTick();
  menu.value?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
}

function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault(); event.stopPropagation(); close();
    trigger.value?.focus({ preventScroll: true });
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const options = [...menu.value!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const index = options.indexOf(event.target as HTMLElement);
    options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  }
}

watch(() => [props.active, props.ready], ([active, ready]) => { if (!active || !ready) close(); });
watch(open, (visible, _, onCleanup) => {
  const element = menu.value;
  if (!visible || !element) return;
  const outside = (event: Event) => { if (!element.contains(event.target as Node)) close(); };
  element.ownerDocument.addEventListener('pointerdown', outside);
  element.ownerDocument.addEventListener('focusin', outside);
  element.ownerDocument.defaultView?.addEventListener('blur', close);
  onCleanup(() => {
    element.ownerDocument.removeEventListener('pointerdown', outside);
    element.ownerDocument.removeEventListener('focusin', outside);
    element.ownerDocument.defaultView?.removeEventListener('blur', close);
  });
}, { flush: 'post' });
</script>

<template>
  <div ref="menu" class="settings-presence" :aria-busy="syncing || !ready" @keydown="navigate">
    <button ref="trigger" type="button" class="settings-presence-trigger" aria-label="切换在线状态" aria-haspopup="menu"
      :aria-expanded="open" :disabled="!ready || !active" aria-describedby="activity-visibility-feedback"
      @pointerdown="begin" @pointermove="move" @pointerup="finish" @pointercancel="close"
      @click="$event.detail === 0 && openKeyboard()" @keydown.down.prevent.stop="openKeyboard">
      <span class="presence-option-dot" :class="mode" aria-hidden="true" />{{ mode ? labels[mode] : '读取中' }}<ChevronDown :size="13" />
    </button>
    <div v-if="open" class="settings-presence-menu" role="menu" aria-label="在线状态">
      <button v-for="option in modes" :key="option" type="button" role="menuitemradio" :data-presence-mode="option"
        :aria-label="labels[option]" :aria-checked="mode === option" :aria-describedby="`settings-presence-${option}`"
        :class="{ 'is-highlighted': highlighted === option }" @click="select(option)">
        <span class="settings-presence-title"><span class="presence-option-dot" :class="option" aria-hidden="true" />{{ labels[option] }}</span>
        <Check v-if="mode === option" :size="13" aria-hidden="true" />
        <small :id="`settings-presence-${option}`">{{ descriptions[option] }}</small>
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings-presence { position: relative; flex-shrink: 0; }
.settings-presence .settings-presence-trigger { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 88px; height: 32px; min-height: 32px; padding: 7px 8px; border: 0; background: transparent; line-height: 18px; touch-action: none; }
.settings-presence-menu { position: absolute; z-index: 2; top: 0; right: 0; width: min(280px, calc(100vw - 48px)); border-radius: 5px; background: var(--panel-raised); box-shadow: 0 4px 16px #0006; }
.settings-presence-menu button { display: grid; grid-template-columns: minmax(0, 1fr) 13px; align-items: center; gap: 4px 6px; width: 100%; padding: 7px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--text); text-align: left; }
.settings-presence-menu button:hover, .settings-presence-menu button.is-highlighted { background: var(--panel-soft); }
.settings-presence-title { display: flex; align-items: center; justify-self: end; gap: 6px; line-height: 18px; }
.settings-presence-menu small { grid-column: 1 / -1; font-size: 12px; line-height: 18px; color: var(--muted); }
</style>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';

type TooltipState = { text: string; left: number; top: number; placement: 'top' | 'bottom' | 'right' };

const tooltip = ref<TooltipState | null>(null);

function triggerFrom(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const trigger = target.closest('[data-tooltip]');
  return trigger instanceof HTMLElement ? trigger : null;
}

function show(trigger: HTMLElement) {
  const text = trigger.dataset.tooltip?.trim();
  if (!text || window.matchMedia('(max-width: 600px)').matches) return;
  const bounds = trigger.getBoundingClientRect();
  if (trigger.closest('.group-rail')) {
    tooltip.value = {
      text,
      left: bounds.right + 9,
      top: bounds.top + bounds.height / 2,
      placement: 'right',
    };
    return;
  }
  const margin = Math.min(110, window.innerWidth / 2);
  const left = Math.min(Math.max(bounds.left + bounds.width / 2, margin), window.innerWidth - margin);
  const placement = bounds.top > 62 ? 'top' : 'bottom';
  tooltip.value = {
    text,
    left,
    top: placement === 'top' ? bounds.top - 7 : bounds.bottom + 7,
    placement,
  };
}

function hide() {
  tooltip.value = null;
}

function onMouseOver(event: MouseEvent) {
  const trigger = triggerFrom(event.target);
  if (trigger) show(trigger);
}

function onMouseOut(event: MouseEvent) {
  const trigger = triggerFrom(event.target);
  if (trigger && !trigger.contains(event.relatedTarget as Node | null)) hide();
}

function onFocusIn(event: FocusEvent) {
  const trigger = triggerFrom(event.target);
  if (trigger) show(trigger);
}

function onFocusOut() {
  hide();
}

onMounted(() => {
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout', onMouseOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, true);
});

onScopeDispose(() => {
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('mouseout', onMouseOut);
  document.removeEventListener('focusin', onFocusIn);
  document.removeEventListener('focusout', onFocusOut);
  window.removeEventListener('resize', hide);
  window.removeEventListener('scroll', hide, true);
});
</script>

<template>
  <Teleport to="body">
    <span v-if="tooltip" role="tooltip" class="global-tooltip" :class="`is-${tooltip.placement}`"
      :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }">{{ tooltip.text }}</span>
  </Teleport>
</template>

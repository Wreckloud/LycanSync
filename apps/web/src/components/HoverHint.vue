<script setup lang="ts">
import { onScopeDispose, ref, useId, watch } from 'vue';
import { autoUpdate, computePosition, offset, shift } from '@floating-ui/dom';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ text: string; detail?: string; disabled?: boolean; boundary: string }>();
const anchor = ref<HTMLElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const open = ref(false);
const id = useId();
const position = ref({ left: '0px', top: '0px', visibility: 'hidden' as 'hidden' | 'visible' });
let timer: ReturnType<typeof setTimeout> | undefined;

function close() {
  clearTimeout(timer);
  timer = undefined;
  open.value = false;
}
function show(event: PointerEvent | FocusEvent) {
  if (props.disabled || ('pointerType' in event && event.pointerType === 'touch')) return;
  if (event.type === 'focusin' && !(event.target as HTMLElement).matches(':focus-visible')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    position.value.visibility = 'hidden';
    open.value = true;
  }, 300);
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
watch(() => props.disabled, disabled => { if (disabled) close(); });
watch([open, surface], ([visible, element], _, onCleanup) => {
  const trigger = anchor.value;
  if (!visible || !element || !trigger) return;
  let active = true;
  let request = 0;
  const document = trigger.ownerDocument;
  const stop = autoUpdate(trigger, element, () => {
    if (!trigger.getClientRects().length) { close(); return; }
    const revision = ++request;
    void computePosition(trigger, element, {
      strategy: 'fixed', placement: 'right', middleware: [offset(() => {
        const boundary = trigger.closest(props.boundary);
        return 10 + (boundary ? boundary.getBoundingClientRect().right - trigger.getBoundingClientRect().right : 0);
      }), shift({ padding: 8, crossAxis: true })],
    }).then(({ x, y }) => {
      if (active && revision === request) position.value = { left: `${x}px`, top: `${y}px`, visibility: 'visible' };
    }).catch(error => { if (active) { console.warn('[hover-hint] positioning failed', error); close(); } });
  });
  document.addEventListener('keydown', escape);
  document.addEventListener('pointerdown', close);
  onCleanup(() => {
    active = false;
    stop();
    document.removeEventListener('keydown', escape);
    document.removeEventListener('pointerdown', close);
  });
}, { flush: 'post' });
onScopeDispose(close);
</script>

<template>
  <span ref="anchor" v-bind="$attrs" class="hover-hint-anchor" @pointerenter="show" @pointerleave="close" @focusin="show" @focusout="close" @click="close" @keydown.esc="close">
    <slot :description-id="open ? id : undefined" />
  </span>
  <Teleport v-if="anchor" :to="anchor.ownerDocument.body">
    <Transition name="hover-hint">
      <span v-if="open" :id="id" ref="surface" role="tooltip" class="hover-hint" :style="position">
        {{ text }}<span v-if="detail" class="hover-hint-detail"> · {{ detail }}</span>
      </span>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hover-hint-anchor { display: inline-flex; flex: 0 0 auto; }
.hover-hint { position: fixed; z-index: 30; width: max-content; max-width: min(260px, calc(100vw - 24px)); padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; pointer-events: none; }
.hover-hint-detail { color: var(--muted); white-space: nowrap; }
.hover-hint-enter-active, .hover-hint-leave-active { transition: opacity var(--motion-surface-duration) var(--motion-ease), transform var(--motion-surface-duration) var(--motion-ease); }
.hover-hint-enter-from, .hover-hint-leave-to { opacity: 0; transform: translateX(-4px); }
@media (prefers-reduced-motion: reduce) { .hover-hint-enter-active, .hover-hint-leave-active { transition: none; } }
</style>

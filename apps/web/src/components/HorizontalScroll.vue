<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, onUpdated, ref, watch } from 'vue';
import { motionDurationMs } from '../styles/motion';

const props = defineProps<{ label: string; centerKey?: string }>();
const viewport = ref<HTMLElement | null>(null);
const previous = ref(false);
const next = ref(false);
let observer: ResizeObserver | undefined;
let frame: number | undefined;
let owner: Window | undefined;
let drag: { pointer: number; x: number; left: number; moved: boolean } | undefined;
let suppressClick = false;
let scrollPreference: MediaQueryList | undefined;
let content: Element | null = null;
let scrollFrame: number | undefined;
let scrollTarget: number | undefined;

function cancelScroll() {
  if (scrollFrame !== undefined) owner?.cancelAnimationFrame(scrollFrame);
  scrollFrame = undefined;
  scrollTarget = undefined;
}

function scrollTo(left: number) {
  const element = viewport.value;
  if (!element || !owner) return;
  cancelScroll();
  const target = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, left));
  const from = element.scrollLeft;
  const duration = scrollPreference?.matches ? 0
    : motionDurationMs(owner.getComputedStyle(element).getPropertyValue('--motion-surface-duration'));
  if (!duration || Math.abs(target - from) < 1) { element.scrollLeft = target; return; }
  scrollTarget = target;
  const started = owner.performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / duration);
    element.scrollLeft = from + (target - from) * (1 - (1 - progress) ** 3);
    if (progress < 1) scrollFrame = owner!.requestAnimationFrame(step);
    else { scrollFrame = undefined; scrollTarget = undefined; }
  };
  scrollFrame = owner.requestAnimationFrame(step);
}

watch(() => props.centerKey, async (key) => {
  cancelScroll();
  if (!key) return;
  await nextTick();
  const element = viewport.value;
  if (props.centerKey !== key || !element || !element.clientWidth || element.scrollWidth <= element.clientWidth) return;
  const selected = [...element.querySelectorAll<HTMLElement>('[data-scroll-key]')].find(item => item.dataset.scrollKey === key);
  if (!selected) return;
  const card = selected.getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  scrollTo(element.scrollLeft + card.left + card.width / 2 - bounds.left - element.clientLeft - element.clientWidth / 2);
}, { immediate: true });

function observeContent() {
  const current = viewport.value?.firstElementChild ?? null;
  if (current !== content) {
    if (content) observer?.unobserve(content);
    if (current) observer?.observe(current);
    content = current;
  }
  update();
}

function update() {
  const element = viewport.value;
  if (!element) return;
  previous.value = element.scrollLeft > 1;
  next.value = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

function scroll(direction: number) {
  const element = viewport.value;
  if (!element) return;
  scrollTo((scrollTarget ?? element.scrollLeft) + direction * element.clientWidth * 0.75);
}

function stopAnimatedScroll() {
  const element = viewport.value;
  if (scrollPreference?.matches && element) cancelScroll();
}

function wheel(event: WheelEvent) {
  const element = viewport.value;
  if (!element || event.ctrlKey) return;
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) { cancelScroll(); return; }
  const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
  if (scrollTarget === undefined && (delta < 0 ? !previous.value : !next.value)) return;
  event.preventDefault();
  scrollTo((scrollTarget ?? element.scrollLeft) + delta);
}

function startDrag(event: PointerEvent) {
  suppressClick = false;
  if (event.pointerType !== 'mouse' || event.button !== 0 || !viewport.value
      || !(previous.value || next.value)
      || (event.target as Element).closest('input, select, textarea, [role="slider"], .participant-volume-control')) return;
  cancelScroll();
  drag = { pointer: event.pointerId, x: event.clientX, left: viewport.value.scrollLeft, moved: false };
}

function moveDrag(event: PointerEvent) {
  const element = viewport.value;
  if (!drag || drag.pointer !== event.pointerId || !element) return;
  if (!drag.moved && Math.abs(event.clientX - drag.x) < 6) return;
  drag.moved = true;
  suppressClick = true;
  element.setPointerCapture(event.pointerId);
  element.scrollLeft = drag.left - event.clientX + drag.x;
  event.preventDefault();
}

function endDrag(event: PointerEvent) {
  if (drag?.pointer !== event.pointerId) return;
  if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId);
  drag = undefined;
}

function click(event: MouseEvent) {
  if (!suppressClick) return;
  suppressClick = false;
  event.preventDefault();
  event.stopPropagation();
}

onMounted(() => {
  const element = viewport.value!;
  owner = element.ownerDocument.defaultView!;
  scrollPreference = owner.matchMedia('(prefers-reduced-motion: reduce)');
  scrollPreference.addEventListener('change', stopAnimatedScroll);
  observer = new element.ownerDocument.defaultView!.ResizeObserver(() => {
    if (frame !== undefined) return;
    frame = owner!.requestAnimationFrame(() => { frame = undefined; update(); });
  });
  observer.observe(element);
  observeContent();
});
onUpdated(observeContent);
onScopeDispose(() => {
  scrollPreference?.removeEventListener('change', stopAnimatedScroll);
  cancelScroll();
  observer?.disconnect();
  if (frame !== undefined) owner?.cancelAnimationFrame(frame);
  drag = undefined;
});
</script>

<template>
  <div class="horizontal-scroll">
    <div ref="viewport" class="horizontal-viewport" :class="{ 'can-scroll-left': previous, 'can-scroll-right': next }"
      role="region" :aria-label="label" tabindex="0"
      @scroll="update" @wheel="wheel" @pointerdown="startDrag" @pointermove="moveDrag"
      @pointerup="endDrag" @pointercancel="endDrag" @click.capture="click"
      @keydown.left.self.prevent="scroll(-1)" @keydown.right.self.prevent="scroll(1)">
      <slot />
    </div>
  </div>
</template>

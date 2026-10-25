<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

defineProps<{ label: string }>();
const viewport = ref<HTMLElement | null>(null);
const previous = ref(false);
const next = ref(false);
let observer: ResizeObserver | undefined;
let frame: number | undefined;
let owner: Window | undefined;
let drag: { pointer: number; x: number; left: number; moved: boolean } | undefined;
let suppressClick = false;

function update() {
  const element = viewport.value;
  if (!element) return;
  previous.value = element.scrollLeft > 1;
  next.value = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

function scroll(direction: number) {
  const element = viewport.value;
  if (element) element.scrollBy({ left: direction * element.clientWidth * 0.75, behavior: 'smooth' });
}

function wheel(event: WheelEvent) {
  const element = viewport.value;
  if (!element || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
  if (delta < 0 ? !previous.value : !next.value) return;
  event.preventDefault();
  element.scrollLeft += delta;
}

function startDrag(event: PointerEvent) {
  suppressClick = false;
  if (event.pointerType !== 'mouse' || event.button !== 0 || !viewport.value
      || !(previous.value || next.value)
      || (event.target as Element).closest('input, select, textarea, [role="slider"], .participant-volume-control')) return;
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
  observer = new element.ownerDocument.defaultView!.ResizeObserver(() => {
    if (frame !== undefined) return;
    frame = owner!.requestAnimationFrame(() => { frame = undefined; update(); });
  });
  observer.observe(element);
  if (element.firstElementChild) observer.observe(element.firstElementChild);
  update();
});
onScopeDispose(() => {
  observer?.disconnect();
  if (frame !== undefined) owner?.cancelAnimationFrame(frame);
  drag = undefined;
});
</script>

<template>
  <div class="horizontal-scroll">
    <button v-if="previous || next" type="button" class="scroll-arrow" :aria-label="label + '向左滚动'"
      :disabled="!previous" @click="scroll(-1)"><ChevronLeft :size="16" /></button>
    <div ref="viewport" class="horizontal-viewport" role="region" :aria-label="label" tabindex="0"
      @scroll="update" @wheel="wheel" @pointerdown="startDrag" @pointermove="moveDrag"
      @pointerup="endDrag" @pointercancel="endDrag" @click.capture="click"
      @keydown.left.self.prevent="scroll(-1)" @keydown.right.self.prevent="scroll(1)">
      <slot />
    </div>
    <button v-if="previous || next" type="button" class="scroll-arrow" :aria-label="label + '向右滚动'"
      :disabled="!next" @click="scroll(1)"><ChevronRight :size="16" /></button>
  </div>
</template>

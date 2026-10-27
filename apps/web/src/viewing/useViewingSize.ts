import { onMounted, onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';

interface ViewingSizeOptions {
  detached(): boolean;
  expanded(): boolean;
  showMembers(): boolean;
  preferredHeight(): number | null;
  setHeight(height: number): void;
}

export function useViewingSize(panel: Ref<HTMLElement | null>, options: ViewingSizeOptions) {
  const width = ref(600);
  const height = ref(300);
  const maximumHeight = ref(420);
  const resizing = ref(false);
  let drag: { pointer: number; y: number; height: number } | undefined;
  let observer: ResizeObserver | undefined;
  let stopObservation: (() => void) | undefined;

  function changeHeight(value: number) {
    height.value = Math.max(140, Math.min(maximumHeight.value, value));
    options.setHeight(height.value);
  }

  function beginResize(event: PointerEvent) {
    drag = { pointer: event.pointerId, y: event.clientY, height: height.value };
    resizing.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveResize(event: PointerEvent) {
    if (drag?.pointer === event.pointerId) changeHeight(drag.height + event.clientY - drag.y);
  }

  function endResize(event: PointerEvent) {
    if (drag?.pointer !== event.pointerId) return;
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    drag = undefined;
    resizing.value = false;
  }

  onMounted(() => {
    const element = panel.value!;
    const viewport = element.querySelector<HTMLElement>('.viewing-stage .horizontal-viewport')!;
    const owner = element.ownerDocument.defaultView!;
    let frame: number | undefined;
    function resize() {
      // 按最终布局计算目标高度，不把过渡中的每一帧重新当成用户配置。
      width.value = viewport.clientWidth;
      const containerHeight = options.detached() ? owner.innerHeight
        : element.closest('.group-main')?.clientHeight ?? owner.innerHeight;
      maximumHeight.value = Math.max(140, containerHeight - (options.showMembers() ? 480 : 300));
      const preferredHeight = options.preferredHeight();
      if (options.expanded()) height.value = Math.max(120, element.clientHeight);
      else if (options.detached()) height.value = Math.max(120, containerHeight - (options.showMembers() ? 210 : 0));
      else if (preferredHeight !== null) height.value = Math.max(120, Math.min(maximumHeight.value, preferredHeight));
      else height.value = Math.max(120, Math.min(480, containerHeight * 0.6 - (options.showMembers() ? 160 : 0)));
    }
    observer = new owner.ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = owner.requestAnimationFrame(() => { frame = undefined; resize(); });
    });
    const stopMembers = watch(() => [options.showMembers(), options.expanded()], resize, { flush: 'post' });
    stopObservation = () => { stopMembers(); if (frame !== undefined) owner.cancelAnimationFrame(frame); };
    observer.observe(element);
    observer.observe(viewport);
    observer.observe(element.ownerDocument.documentElement);
    resize();
  });
  onScopeDispose(() => { observer?.disconnect(); stopObservation?.(); });

  return { width, height, maximumHeight, resizing, changeHeight, beginResize, moveResize, endResize };
}

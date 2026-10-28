import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
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
  const minimumHeight = computed(() => Math.min(140, maximumHeight.value));
  const resizing = ref(false);
  let drag: { pointer: number; y: number; height: number } | undefined;
  let observer: ResizeObserver | undefined;
  let stopObservation: (() => void) | undefined;

  function changeHeight(value: number) {
    height.value = Math.max(minimumHeight.value, Math.min(maximumHeight.value, value));
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
    const container = element.closest<HTMLElement>('.group-main');
    const overlay = element.closest<HTMLElement>('.voice-panel');
    const composer = container?.querySelector<HTMLElement>('.composer');
    const callbar = container?.querySelector<HTMLElement>('.callbar');
    const personal = container?.querySelector<HTMLElement>('.personal-card');
    const members = container?.querySelector<HTMLElement>('.members-directory');
    const memberHeader = members?.querySelector<HTMLElement>('.members-header');
    const memberList = members?.querySelector<HTMLElement>('.members-list');
    let observedMembers: HTMLElement | null = null;
    let frame: number | undefined;
    function resize() {
      // 读取成员内容的自然高度，不把折叠动画的中间高度写成用户偏好。
      width.value = viewport.clientWidth;
      const memberPanel = options.showMembers() ? element.querySelector<HTMLElement>('.viewing-members-panel') : null;
      if (memberPanel !== observedMembers) {
        if (observedMembers) observer?.unobserve(observedMembers);
        if (memberPanel) observer?.observe(memberPanel);
        observedMembers = memberPanel;
      }
      const top = element.getBoundingClientRect().top;
      let availableHeight = Math.max(0, owner.innerHeight - top);
      if (options.expanded()) availableHeight = element.clientHeight;
      else if (!options.detached() && container) {
        availableHeight = Math.max(0, container.getBoundingClientRect().bottom - top);
        if (overlay) {
          const limit = owner.getComputedStyle(overlay).maxHeight;
          const numeric = Number.parseFloat(limit);
          if (Number.isFinite(numeric)) availableHeight = Math.min(availableHeight,
            limit.endsWith('%') ? container.clientHeight * numeric / 100 : numeric);
        }
        for (const operation of [composer, callbar]) {
          if (operation?.getClientRects().length) {
            availableHeight = Math.min(availableHeight, operation.getBoundingClientRect().top - top);
          }
        }
        if (personal?.getClientRects().length) {
          const firstMember = memberList?.querySelector<HTMLElement>('.group-member-row');
          const listStyle = memberList ? owner.getComputedStyle(memberList) : null;
          const memberSpace = (memberHeader?.offsetHeight ?? 0) + (firstMember?.offsetHeight ?? 0)
            + (Number.parseFloat(listStyle?.paddingTop ?? '0') || 0) + (Number.parseFloat(listStyle?.paddingBottom ?? '0') || 0);
          availableHeight = Math.min(availableHeight, personal.getBoundingClientRect().top - top - memberSpace);
        }
      }
      const memberHeight = memberPanel?.parentElement?.scrollHeight ?? memberPanel?.offsetHeight ?? 0;
      maximumHeight.value = Math.max(0, Math.floor(availableHeight - memberHeight));
      const preferredHeight = options.preferredHeight();
      const requestedHeight = options.expanded() || options.detached() ? maximumHeight.value : preferredHeight ?? 480;
      height.value = Math.max(minimumHeight.value, Math.min(maximumHeight.value, requestedHeight));
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
    for (const boundary of [container, composer, callbar, personal, memberHeader, memberList]) {
      if (boundary) observer.observe(boundary);
    }
    resize();
  });
  onScopeDispose(() => { observer?.disconnect(); stopObservation?.(); });

  return { width, height, minimumHeight, maximumHeight, resizing, changeHeight, beginResize, moveResize, endResize };
}

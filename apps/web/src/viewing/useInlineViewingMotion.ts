import { nextTick, onScopeDispose, watch } from 'vue';
import type { Ref } from 'vue';

// 覆盖层与右栏共用实际展开高度，聊天尺寸和消息滚动位置保持稳定。
export function useInlineViewingMotion(target: Ref<HTMLElement | null>, expanded: () => boolean) {
  let animation: Animation | undefined;
  let generation = 0;
  let preference: MediaQueryList | undefined;
  let observer: ResizeObserver | undefined;
  let conversation: HTMLElement | null = null;
  let activeElement: HTMLElement | null = null;
  let finishLeave: (() => void) | undefined;

  function updateDirectory() {
    if (!activeElement || !conversation) return;
    conversation.style.setProperty('--voice-overlay-height',
      `${Math.max(0, activeElement.getBoundingClientRect().bottom - conversation.getBoundingClientRect().top)}px`);
  }
  function clearDirectory() {
    observer?.disconnect();
    observer = undefined;
    conversation?.style.removeProperty('--voice-overlay-height');
    conversation = null;
    activeElement = null;
  }
  function cancel() {
    animation?.cancel();
    animation = undefined;
    const finish = finishLeave;
    finishLeave = undefined;
    finish?.();
  }
  function reduceMotion() {
    if (!preference?.matches) return;
    cancel();
    updateDirectory();
  }
  function observe(element: HTMLElement) {
    clearDirectory();
    activeElement = element;
    const owner = element.ownerDocument.defaultView!;
    conversation = element.closest('.group-main')?.querySelector<HTMLElement>('.group-conversation') ?? null;
    observer = new owner.ResizeObserver(() => { if (activeElement === element) updateDirectory(); });
    observer.observe(element);
    if (!preference) {
      preference = owner.matchMedia('(prefers-reduced-motion: reduce)');
      preference.addEventListener('change', reduceMotion);
    }
  }
  function animateHeight(element: HTMLElement, from: number, to: number, finish?: () => void) {
    const owner = element.ownerDocument.defaultView!;
    const style = owner.getComputedStyle(element);
    const duration = Number.parseFloat(style.getPropertyValue('--motion-layout-duration'));
    if (preference?.matches || Math.abs(from - to) < 1 || typeof element.animate !== 'function'
      || !Number.isFinite(duration) || duration <= 0) {
      updateDirectory();
      finish?.();
      return;
    }
    const active = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration, easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = active;
    finishLeave = finish;
    updateDirectory();
    // 取消是快速切换的正常收尾；旧动画不能清理新覆盖层。
    active.finished.then(() => {
      if (animation !== active) return;
      animation = undefined;
      finishLeave = undefined;
      if (finish) finish();
      else updateDirectory();
    }, () => {});
  }

  watch([target, expanded], async ([element], [previous]) => {
    if (!element) { if (!finishLeave) clearDirectory(); return; }
    const from = element === previous ? element.getBoundingClientRect().height : 0;
    cancel();
    const current = ++generation;
    await nextTick();
    if (current !== generation || element !== target.value || !element.isConnected) return;
    observe(element);
    animateHeight(element, from, element.getBoundingClientRect().height);
  }, { flush: 'pre' });

  function leave(element: Element, done: () => void) {
    const surface = element as HTMLElement;
    const from = surface.getBoundingClientRect().height;
    generation++;
    cancel();
    surface.inert = true;
    observe(surface);
    animateHeight(surface, from, 0, () => { clearDirectory(); done(); });
  }

  onScopeDispose(() => {
    generation++;
    cancel();
    clearDirectory();
    preference?.removeEventListener('change', reduceMotion);
  });
  return { leave };
}

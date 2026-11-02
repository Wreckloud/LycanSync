import { nextTick, onScopeDispose, watch } from 'vue';
import type { Ref } from 'vue';
import { motionDurationMs } from '../styles/motion';

// 覆盖层与右栏共用实际展开高度，聊天尺寸和消息滚动位置保持稳定。
export function useInlineViewingMotion(target: Ref<HTMLElement | null>, expanded: () => boolean) {
  let animation: Animation | undefined;
  let generation = 0;
  let preference: MediaQueryList | undefined;
  let observer: ResizeObserver | undefined;
  let conversation: HTMLElement | null = null;
  let activeElement: HTMLElement | null = null;
  let finishLeave: (() => void) | undefined;
  let frame: number | undefined;
  let entering = false;
  let lastHeight = 0;

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
    entering = false;
    lastHeight = 0;
  }
  function stopFrame() {
    if (frame !== undefined) activeElement?.ownerDocument.defaultView?.cancelAnimationFrame(frame);
    frame = undefined;
  }
  function cancel() {
    stopFrame();
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
  function measure(element: HTMLElement) {
    if (activeElement !== element) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0 && !finishLeave) lastHeight = height;
    // Teleport 在空容器挂载后才填入成员；首次有效尺寸到达时再展开。
    if (entering && height > 0) {
      entering = false;
      animateSurface(element, 0, height);
    }
    updateDirectory();
  }
  function observe(element: HTMLElement, reveal = false) {
    clearDirectory();
    activeElement = element;
    entering = reveal;
    const owner = element.ownerDocument.defaultView!;
    conversation = element.closest('.group-main')?.querySelector<HTMLElement>('.group-conversation') ?? null;
    observer = new owner.ResizeObserver(() => measure(element));
    observer.observe(element);
    if (!preference) {
      preference = owner.matchMedia('(prefers-reduced-motion: reduce)');
      preference.addEventListener('change', reduceMotion);
    }
  }
  function animateSurface(element: HTMLElement, from: number, to: number, finish?: () => void, offset?: number) {
    const owner = element.ownerDocument.defaultView!;
    const style = owner.getComputedStyle(element);
    const duration = motionDurationMs(style.getPropertyValue('--motion-layout-duration'));
    const unchanged = offset === undefined ? Math.abs(from - to) < 1 : !Number.isFinite(offset) || Math.abs(offset) < 1;
    if (preference?.matches || unchanged || typeof element.animate !== 'function'
      || !Number.isFinite(duration) || duration <= 0) {
      updateDirectory();
      finish?.();
      return;
    }
    const active = element.animate(offset === undefined
      ? [{ height: `${from}px` }, { height: `${to}px` }]
      : [{ top: `${offset}px` }, { top: '0px' }], {
      duration, easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = active;
    finishLeave = finish;
    updateDirectory();
    const followPosition = () => {
      if (animation !== active) return;
      updateDirectory();
      frame = owner.requestAnimationFrame(followPosition);
    };
    if (typeof owner.requestAnimationFrame === 'function') frame = owner.requestAnimationFrame(followPosition);
    // 取消是快速切换的正常收尾；旧动画不能清理新覆盖层。
    active.finished.then(() => {
      if (animation !== active) return;
      stopFrame();
      animation = undefined;
      finishLeave = undefined;
      if (finish) finish();
      else updateDirectory();
    }, () => {});
  }

  watch([target, expanded], async ([element], [previous]) => {
    if (!element) { if (!finishLeave) clearDirectory(); return; }
    const bounds = element.getBoundingClientRect();
    cancel();
    const current = ++generation;
    await nextTick();
    if (current !== generation || element !== target.value || !element.isConnected) return;
    observe(element, element !== previous);
    const next = element.getBoundingClientRect();
    // 内部观看和成员条各自改变实际高度；外层只衔接顶边，避免两套高度动画相互追赶。
    if (element === previous) animateSurface(element, bounds.height, next.height, undefined, bounds.top - next.top);
    measure(element);
  }, { flush: 'pre' });

  function leave(element: Element, done: () => void) {
    const surface = element as HTMLElement;
    // 退场前 Teleport 的成员可能已被清理，仍用上一份可见尺寸收起背景。
    const height = surface.getBoundingClientRect().height;
    const from = height > 0 ? height : activeElement === surface ? lastHeight : 0;
    generation++;
    cancel();
    surface.inert = true;
    observe(surface);
    animateSurface(surface, from, 0, () => { clearDirectory(); done(); });
  }

  onScopeDispose(() => {
    generation++;
    cancel();
    clearDirectory();
    preference?.removeEventListener('change', reduceMotion);
  });
  return { leave };
}

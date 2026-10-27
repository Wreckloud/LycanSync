import { nextTick, onScopeDispose, watch } from 'vue';
import type { Ref } from 'vue';

// 只过渡覆盖层高度，不挤动聊天；退出观看时媒体组件仍立即销毁。
export function useInlineViewingMotion(target: Ref<HTMLElement | null>, expanded: () => boolean) {
  let animation: Animation | undefined;
  let generation = 0;
  let preference: MediaQueryList | undefined;
  let observer: ResizeObserver | undefined;
  let conversation: HTMLElement | null = null;
  function cancel() { animation?.cancel(); animation = undefined; }
  function reduceMotion() { if (preference?.matches) cancel(); }

  watch([target, expanded], async ([element]) => {
    const from = element?.getBoundingClientRect().height ?? 0;
    cancel();
    observer?.disconnect();
    conversation?.style.removeProperty('--voice-overlay-height');
    conversation = null;
    const current = ++generation;
    if (!element || !element.getClientRects().length) return;
    await nextTick();
    if (current !== generation || element !== target.value || !element.isConnected) return;
    const owner = element.ownerDocument.defaultView!;
    conversation = element.closest('.group-main')?.querySelector<HTMLElement>('.group-conversation') ?? null;
    // 右栏成员让出被覆盖的顶部，聊天保持原尺寸和滚动位置。
    const directory = conversation;
    const updateDirectory = () => {
      if (current !== generation || element !== target.value) return;
      directory?.style.setProperty('--voice-overlay-height',
        `${Math.max(0, element.getBoundingClientRect().bottom - directory.getBoundingClientRect().top)}px`);
    };
    observer = new owner.ResizeObserver(updateDirectory);
    observer.observe(element);
    updateDirectory();
    if (!preference) {
      preference = owner.matchMedia('(prefers-reduced-motion: reduce)');
      preference.addEventListener('change', reduceMotion);
    }
    const to = element.getBoundingClientRect().height;
    if (preference.matches || Math.abs(from - to) < 1 || typeof element.animate !== 'function') return;
    const style = owner.getComputedStyle(element);
    const duration = Number.parseFloat(style.getPropertyValue('--motion-layout-duration'));
    if (!Number.isFinite(duration) || duration <= 0) return;
    const active = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration, easing: style.getPropertyValue('--motion-ease').trim(),
    });
    animation = active;
    // 正常取消会拒绝 finished，不将快速切换当成业务故障。
    active.finished.then(() => { if (animation === active) animation = undefined; }, () => {});
  }, { flush: 'pre' });

  onScopeDispose(() => {
    generation++;
    cancel();
    preference?.removeEventListener('change', reduceMotion);
    observer?.disconnect();
    conversation?.style.removeProperty('--voice-overlay-height');
  });
}

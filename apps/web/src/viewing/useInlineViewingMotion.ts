import { nextTick, onScopeDispose, watch } from 'vue';
import type { Ref } from 'vue';

// 只过渡语音区留下的空间；退出观看时媒体组件仍立即销毁。
export function useInlineViewingMotion(target: Ref<HTMLElement | null>, expanded: () => boolean) {
  let animation: Animation | undefined;
  let generation = 0;
  let preference: MediaQueryList | undefined;
  function cancel() { animation?.cancel(); animation = undefined; }
  function reduceMotion() { if (preference?.matches) cancel(); }

  watch([target, expanded], async ([element]) => {
    const from = element?.getBoundingClientRect().height ?? 0;
    cancel();
    const current = ++generation;
    if (!element || !element.getClientRects().length) return;
    await nextTick();
    if (current !== generation || element !== target.value || !element.isConnected) return;
    const owner = element.ownerDocument.defaultView!;
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
  });
}

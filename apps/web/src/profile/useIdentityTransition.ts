import { nextTick, onScopeDispose, watch } from 'vue';

type IdentityPhase = 'profile' | 'account' | 'loading' | 'main' | 'leaving' | null;
type IdentityState = { id: string | null; phase: IdentityPhase };
type IdentityPart = { copy: HTMLElement; bounds: DOMRect };

// 只衔接身份的绘制；登录资格、页面挂载和媒体清理始终由原流程决定。
export function useIdentityTransition(state: () => IdentityState, layoutReady: () => Promise<unknown>) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let layer: HTMLElement | undefined;
  let animations: Animation[] = [];
  let hidden: { element: HTMLElement; visibility: string }[] = [];
  let generation = 0;
  let frame: number | undefined;
  let releaseFrame: (() => void) | undefined;

  function clear() {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    releaseFrame?.();
    releaseFrame = undefined;
    for (const animation of animations) animation.cancel();
    animations = [];
    for (const { element, visibility } of hidden) element.style.visibility = visibility;
    hidden = [];
    layer?.remove();
    layer = undefined;
  }

  function parts(phase: IdentityPhase) {
    const identity = phase ? document.querySelector<HTMLElement>(`[data-identity="${phase}"]`) : null;
    return identity ? ['avatar', 'name'].map(part => identity.querySelector<HTMLElement>(`[data-identity-${part}]`))
      .filter((element): element is HTMLElement => Boolean(element)) : [];
  }

  function snapshot(elements: HTMLElement[]): IdentityPart[] {
    return elements.map(element => {
      const bounds = element.getBoundingClientRect();
      const copy = element.cloneNode(true) as HTMLElement;
      const style = window.getComputedStyle(element);
      const scale = element.offsetHeight > 0 ? bounds.height / element.offsetHeight : 1;
      copy.removeAttribute('id');
      copy.removeAttribute('data-identity-avatar');
      copy.removeAttribute('data-identity-name');
      // 克隆只保留视觉内容，不复制交互或裁剪层；字体按原尺寸绘制再整体缩放。
      Object.assign(copy.style, { position: 'absolute', left: `${bounds.left}px`, top: `${bounds.top}px`,
        width: `${bounds.width}px`, height: `${bounds.height}px`, margin: '0', padding: '0',
        font: style.font, color: style.color, background: style.background, borderRadius: style.borderRadius,
        display: style.display, alignItems: style.alignItems, justifyContent: style.justifyContent,
        objectFit: style.objectFit, visibility: 'visible', transform: 'none', transformOrigin: '0 0',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
      copy.style.fontSize = `${Number.parseFloat(style.fontSize) * scale}px`;
      if (style.lineHeight !== 'normal') copy.style.lineHeight = `${Number.parseFloat(style.lineHeight) * scale}px`;
      return { copy, bounds };
    });
  }

  function hide(elements: HTMLElement[]) {
    for (const element of elements) {
      if (hidden.some(part => part.element === element)) continue;
      hidden.push({ element, visibility: element.style.visibility });
      element.style.visibility = 'hidden';
    }
  }

  function nextFrame() {
    return new Promise<void>(resolve => {
      releaseFrame = resolve;
      frame = window.requestAnimationFrame(() => { frame = undefined; releaseFrame = undefined; resolve(); });
    });
  }

  watch(state, async (next, previous) => {
    if (next.id === previous.id && next.phase === previous.phase) return;
    const current = ++generation;
    if (!next.id || !next.phase || next.id !== previous.id || preference.matches) { clear(); return; }
    const viewport = { width: window.innerWidth, height: window.innerHeight, left: window.screenX, top: window.screenY };
    const source = layer ? [...layer.children] as HTMLElement[] : parts(previous.phase);
    const from = snapshot(source);
    clear();
    if (from.length !== 2
      || from.some(part => part.bounds.width <= 0 || part.bounds.height <= 0)) return;
    layer = document.createElement('div');
    layer.className = 'identity-flight';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    layer.append(...from.map(part => part.copy));
    document.body.append(layer);
    hide(parts(previous.phase));
    await nextTick();
    if (current !== generation) return;
    // 退出收尾期间暂留身份，资源释放完毕后才衔接收紧的账号窗口。
    if (next.phase === 'leaving') return;
    hide(parts(next.phase));
    await nextFrame();
    if (current !== generation) return;
    await layoutReady();
    if (current !== generation) return;
    await nextFrame();
    if (current !== generation) return;
    const target = parts(next.phase);
    const to = target.map(element => element.getBoundingClientRect());
    if (target.length !== 2 || to.some(bounds => bounds.width <= 0 || bounds.height <= 0)) { clear(); return; }
    hide(target);
    const style = window.getComputedStyle(target[0]!);
    const durationText = style.getPropertyValue('--motion-identity-duration').trim();
    const duration = durationText.endsWith('ms') ? Number.parseFloat(durationText)
      : durationText.endsWith('s') ? Number.parseFloat(durationText) * 1000 : 0;
    if (!Number.isFinite(duration) || duration <= 0 || typeof target[0]!.animate !== 'function') { clear(); return; }
    animations = from.map(({ copy, bounds }, index) => {
      const end = to[index]!;
      let left = bounds.left;
      let top = bounds.top;
      // 入口窗口会收紧／恢复尺寸；按屏幕位置接续，窗口外的起点收回到可见边缘。
      if (viewport.width !== window.innerWidth || viewport.height !== window.innerHeight) {
        left = Math.max(0, Math.min(left + viewport.left - window.screenX, window.innerWidth - bounds.width));
        top = Math.max(0, Math.min(top + viewport.top - window.screenY, window.innerHeight - bounds.height));
        copy.style.left = `${left}px`;
        copy.style.top = `${top}px`;
      }
      const targetStyle = window.getComputedStyle(target[index]!);
      const scaleY = index === 0 ? end.height / bounds.height
        : Number.parseFloat(targetStyle.fontSize) / Number.parseFloat(copy.style.fontSize);
      const scaleX = index === 0 ? end.width / bounds.width : scaleY;
      return copy.animate([{ transform: 'none', width: `${bounds.width}px` }, {
        transform: `translate(${end.left - left}px, ${end.top - top}px) scale(${scaleX}, ${scaleY})`,
        width: `${end.width / scaleX}px`,
        ...(index === 1 && targetStyle.lineHeight !== 'normal' ? { lineHeight: `${Number.parseFloat(targetStyle.lineHeight) / scaleY}px` } : {}),
      }], { duration, easing: style.getPropertyValue('--motion-ease').trim(), fill: 'forwards' });
    });
    // 被新流转取消是正常情况，旧完成回调不能移除新的身份层。
    await Promise.all(animations.map(animation => animation.finished)).catch(() => undefined);
    if (current === generation) clear();
  }, { flush: 'pre' });

  function cancel() { generation++; clear(); }
  function reduceMotion() { if (preference.matches) cancel(); }
  preference.addEventListener('change', reduceMotion);
  window.addEventListener('pagehide', cancel);
  onScopeDispose(() => {
    cancel();
    preference.removeEventListener('change', reduceMotion);
    window.removeEventListener('pagehide', cancel);
  });
}

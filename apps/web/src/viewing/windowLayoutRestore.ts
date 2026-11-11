// 窗口恢复只校正布局；用户主动展开仍使用原有过渡，不重建视频或资料卡。
export function observeWindowLayoutRestore(owner: Window) {
  const page = owner.document;
  const root = page.documentElement;
  let frame: number | undefined;
  const scopes = '.voice-panel, .call-viewing-panel, .profile-popover';

  function finishAnimations() {
    const animations = new Set([...page.querySelectorAll(scopes)]
      .flatMap(element => element.getAnimations({ subtree: true })));
    for (const animation of animations) {
      if (animation.playState !== 'finished' && animation.playState !== 'idle'
        && Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
  }
  function suspend() {
    if (frame !== undefined) owner.cancelAnimationFrame(frame);
    frame = undefined;
    finishAnimations();
    root.classList.add('is-restoring-layout');
  }
  function restore() {
    suspend();
    if (page.visibilityState === 'hidden') return;
    // 等 Vue 更新及 ResizeObserver 校正尺寸后再恢复动画，避免隐藏期间的零尺寸成为起点。
    frame = owner.requestAnimationFrame(() => {
      frame = owner.requestAnimationFrame(() => {
        finishAnimations();
        void root.offsetHeight;
        root.classList.remove('is-restoring-layout');
        frame = undefined;
      });
    });
  }
  const visibility = () => page.visibilityState === 'hidden' ? suspend() : restore();
  owner.addEventListener('blur', suspend);
  owner.addEventListener('focus', restore);
  page.addEventListener('visibilitychange', visibility);
  return { suspend, restore, stop() {
    if (frame !== undefined) owner.cancelAnimationFrame(frame);
    owner.removeEventListener('blur', suspend);
    owner.removeEventListener('focus', restore);
    page.removeEventListener('visibilitychange', visibility);
    root.classList.remove('is-restoring-layout');
  } };
}

import { expect, it, vi } from 'vitest';
import { observeWindowLayoutRestore } from './windowLayoutRestore';

function fixture() {
  const classes = new Set<string>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const finite = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: 210 }) }, finish: vi.fn() };
  const infinite = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) }, finish: vi.fn() };
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible', documentElement: { offsetHeight: 800,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
    querySelectorAll: () => [{ getAnimations: () => [finite, infinite] }, { getAnimations: () => [finite] }],
  });
  const owner = Object.assign(new EventTarget(), { document: page,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const controller = observeWindowLayoutRestore(owner as unknown as Window);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  return { classes, frames, finite, infinite, owner, page, controller, frame };
}

it('恢复窗口跨过布局校正后开放动画，不重复结束同一动画，也不结束无限动画', () => {
  const f = fixture();
  f.owner.dispatchEvent(new Event('blur'));
  expect(f.classes.has('is-restoring-layout')).toBe(true);
  expect(f.finite.finish).toHaveBeenCalledOnce();
  expect(f.infinite.finish).not.toHaveBeenCalled();
  f.owner.dispatchEvent(new Event('focus'));
  f.frame();
  expect(f.classes.has('is-restoring-layout')).toBe(true);
  f.frame();
  expect(f.classes.size).toBe(0);
  f.controller.stop();
});

it('原生窗口再次隐藏取消尚未完成的恢复，销毁清理帧和全部监听', () => {
  const f = fixture();
  f.controller.restore();
  f.frame();
  f.controller.suspend();
  f.frame();
  expect(f.classes.has('is-restoring-layout')).toBe(true);
  expect(f.frames.size).toBe(0);
  f.controller.restore();
  f.controller.stop();
  f.owner.dispatchEvent(new Event('blur'));
  f.page.dispatchEvent(new Event('visibilitychange'));
  expect(f.frames.size).toBe(0);
  expect(f.classes.size).toBe(0);
});

it('文档隐藏期间不释放保护，恢复可见后才校正', () => {
  const f = fixture();
  f.page.visibilityState = 'hidden';
  f.page.dispatchEvent(new Event('visibilitychange'));
  f.owner.dispatchEvent(new Event('focus'));
  expect(f.frames.size).toBe(0);
  expect(f.classes.has('is-restoring-layout')).toBe(true);
  f.page.visibilityState = 'visible';
  f.page.dispatchEvent(new Event('visibilitychange'));
  f.frame(); f.frame();
  expect(f.classes.size).toBe(0);
  f.controller.stop();
});

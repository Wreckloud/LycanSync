import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { expect, it, vi } from 'vitest';
import { useInlineViewingMotion } from './useInlineViewingMotion';

function fixture() {
  let height = 132;
  let top = 80;
  const animations: { cancel: ReturnType<typeof vi.fn>; finish(): void }[] = [];
  const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const conversation = { style: { setProperty: vi.fn(), removeProperty: vi.fn() }, getBoundingClientRect: () => ({ top: 80 }) };
  const observers: { update(): void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const animate = vi.fn(() => {
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const animation = { cancel: vi.fn(() => reject(new Error('cancelled'))), finished, finish };
    animations.push(animation);
    return animation;
  });
  const element = {
    isConnected: true, getClientRects: () => [{}], getBoundingClientRect: () => ({ height, top, bottom: top + height }), animate,
    closest: () => ({ querySelector: () => conversation }),
    ownerDocument: { defaultView: {
      ResizeObserver: class {
        disconnect = vi.fn();
        constructor(update: () => void) { observers.push({ update, disconnect: this.disconnect }); }
        observe() {}
      },
      matchMedia: () => preference,
      getComputedStyle: () => ({ getPropertyValue: (name: string) =>
        name === '--motion-layout-duration' ? '210ms' : 'cubic-bezier(.2, 0, 0, 1)' }),
    } },
  };
  const target = shallowRef<HTMLElement | null>(element as unknown as HTMLElement);
  const expanded = ref(false);
  const scope = effectScope();
  const motion = scope.run(() => useInlineViewingMotion(target, () => expanded.value))!;

  async function change(open: boolean, from: number, to: number) {
    height = from;
    top = open ? 80 : 0;
    expanded.value = open;
    await nextTick();
    height = to;
    top = open ? 0 : 80;
    await nextTick();
  }
  return { scope, target, expanded, element, animate, animations, preference, change, conversation, observers, motion, setHeight(value: number) { height = value; } };
}

it('观看切换只衔接覆盖层顶边，内部高度独立变化，不缩放视频元素', async () => {
  const f = fixture();
  await f.change(true, 132, 430);
  expect(f.animate).toHaveBeenCalledExactlyOnceWith([{ top: '80px' }, { top: '0px' }], {
    duration: 210, easing: 'cubic-bezier(.2, 0, 0, 1)',
  });
  f.animations[0]!.finish();
  await nextTick();
  f.scope.stop();
  expect(f.animations[0]!.cancel).not.toHaveBeenCalled();
});

it('快速反向操作取消旧过渡，从当前可见高度衔接，不排队等待', async () => {
  const f = fixture();
  await f.change(true, 132, 430);
  await f.change(false, 260, 132);
  expect(f.animations[0]!.cancel).toHaveBeenCalledOnce();
  expect(f.animate.mock.calls).toHaveLength(2);
  expect(f.animate.mock.calls.at(-1)).toEqual([[{ top: '-80px' }, { top: '0px' }], {
    duration: 210, easing: 'cubic-bezier(.2, 0, 0, 1)',
  }]);
  f.scope.stop();
  expect(f.animations[1]!.cancel).toHaveBeenCalledOnce();
});

it('减少动态效果跳过过渡，运行中开启立即取消，并清理偏好监听', async () => {
  const f = fixture();
  f.preference.matches = true;
  await f.change(true, 132, 430);
  expect(f.animate).not.toHaveBeenCalled();
  f.preference.matches = false;
  await f.change(false, 430, 132);
  f.preference.matches = true;
  const listener = f.preference.addEventListener.mock.calls[0]![1] as () => void;
  listener();
  expect(f.animations[0]!.cancel).toHaveBeenCalledOnce();
  f.scope.stop();
  expect(f.preference.removeEventListener).toHaveBeenCalledWith('change', listener);
});

it('等待布局期间销毁或切换目标，迟到任务不能启动动画', async () => {
  const f = fixture();
  f.expanded.value = true;
  await nextTick();
  f.scope.stop();
  await nextTick();
  expect(f.animate).not.toHaveBeenCalled();
});

it('只给右栏让出覆盖高度，移除覆盖层后清除占位，迟到观察不恢复旧尺寸', async () => {
  const f = fixture();
  await f.change(true, 132, 430);
  expect(f.conversation.style.setProperty).toHaveBeenLastCalledWith('--voice-overlay-height', '350px');
  f.target.value = null;
  await nextTick();
  expect(f.observers[0]!.disconnect).toHaveBeenCalledOnce();
  expect(f.conversation.style.removeProperty).toHaveBeenLastCalledWith('--voice-overlay-height');
  f.conversation.style.setProperty.mockClear();
  f.observers[0]!.update();
  expect(f.conversation.style.setProperty).not.toHaveBeenCalled();
  f.scope.stop();
});

it('等待 Teleport 填入成员后从零展开，内容先清理仍能按可见高度收起', async () => {
  const f = fixture();
  f.target.value = null;
  await nextTick();
  f.setHeight(0);
  f.target.value = f.element as unknown as HTMLElement;
  await nextTick();
  await nextTick();
  expect(f.animate).not.toHaveBeenCalled();
  f.setHeight(132);
  f.observers.at(-1)!.update();
  expect(f.animate.mock.calls.at(-1)).toEqual([[{ height: '0px' }, { height: '132px' }], {
    duration: 210, easing: 'cubic-bezier(.2, 0, 0, 1)',
  }]);
  f.animations[0]!.finish();
  await nextTick();
  f.setHeight(0);
  const removed = vi.fn();
  f.motion.leave(f.element as unknown as Element, removed);
  expect(f.animate).toHaveBeenLastCalledWith([{ height: '132px' }, { height: '0px' }], {
    duration: 210, easing: 'cubic-bezier(.2, 0, 0, 1)',
  });
  f.target.value = null;
  await nextTick();
  expect(removed).not.toHaveBeenCalled();
  f.setHeight(66);
  f.observers.at(-1)!.update();
  expect(f.conversation.style.setProperty).toHaveBeenLastCalledWith('--voice-overlay-height', '66px');
  f.animations.at(-1)!.finish();
  await nextTick();
  expect(removed).toHaveBeenCalledOnce();
  expect(f.conversation.style.removeProperty).toHaveBeenLastCalledWith('--voice-overlay-height');
  f.scope.stop();
});

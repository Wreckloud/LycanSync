import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { expect, it, vi } from 'vitest';
import { useInlineViewingMotion } from './useInlineViewingMotion';

function fixture() {
  let height = 132;
  const animations: { cancel: ReturnType<typeof vi.fn>; finish(): void }[] = [];
  const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const animate = vi.fn(() => {
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const animation = { cancel: vi.fn(() => reject(new Error('cancelled'))), finished, finish };
    animations.push(animation);
    return animation;
  });
  const element = {
    isConnected: true, getClientRects: () => [{}], getBoundingClientRect: () => ({ height }), animate,
    ownerDocument: { defaultView: {
      matchMedia: () => preference,
      getComputedStyle: () => ({ getPropertyValue: (name: string) =>
        name === '--motion-layout-duration' ? '210ms' : 'cubic-bezier(.2, 0, 0, 1)' }),
    } },
  };
  const target = shallowRef(element as unknown as HTMLElement);
  const expanded = ref(false);
  const scope = effectScope();
  scope.run(() => useInlineViewingMotion(target, () => expanded.value));

  async function change(open: boolean, from: number, to: number) {
    height = from;
    expanded.value = open;
    await nextTick();
    height = to;
    await nextTick();
  }
  return { scope, target, expanded, element, animate, animations, preference, change };
}

it('只过渡语音区高度，不变更媒体或缩放视频元素，完成后不留下固定高度', async () => {
  const f = fixture();
  await f.change(true, 132, 430);
  expect(f.animate).toHaveBeenCalledExactlyOnceWith([{ height: '132px' }, { height: '430px' }], {
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
  expect(f.animate.mock.calls.at(-1)).toEqual([[{ height: '260px' }, { height: '132px' }], {
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

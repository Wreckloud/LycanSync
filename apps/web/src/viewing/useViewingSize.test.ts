import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';
import { useViewingSize } from './useViewingSize';

const { mounted } = vi.hoisted(() => ({ mounted: [] as (() => void)[] }));
vi.mock('vue', async importOriginal => ({
  ...await importOriginal<typeof import('vue')>(),
  onMounted: (callback: () => void) => { mounted.push(callback); },
}));
beforeEach(() => { mounted.length = 0; });

function fixture() {
  let containerHeight = 600;
  let composerTop: number | undefined;
  let memberHeight = 200;
  let observe!: () => void;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const detached = ref(false), expanded = ref(false), showMembers = ref(true);
  const preferred = ref<number | null>(null);
  const setHeight = vi.fn((value: number) => { preferred.value = value; });
  const boundary = (top: () => number) => ({ getClientRects: () => [{}], getBoundingClientRect: () => ({ top: top() }) });
  const composer = boundary(() => composerTop ?? containerHeight - 130);
  const callbar = boundary(() => containerHeight - 70);
  const personal = boundary(() => containerHeight - 60);
  const memberHeader = { offsetHeight: 44 };
  const memberList = { querySelector: () => ({ offsetHeight: 40 }) };
  const members = { querySelector: (selector: string) => selector === '.members-header' ? memberHeader : memberList };
  const overlay = {};
  const viewport = { clientWidth: 800 };
  const memberPanel = { get offsetHeight() { return memberHeight - 12; },
    parentElement: { get scrollHeight() { return memberHeight; } } };
  const container = { get clientHeight() { return containerHeight; },
    getBoundingClientRect: () => ({ bottom: containerHeight }),
    querySelector: (selector: string) => ({ '.composer': composer, '.callbar': callbar,
      '.personal-card': personal, '.members-directory': members })[selector] };
  const observed = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  const element = { get clientHeight() { return containerHeight; },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: (selector: string) => selector.includes('horizontal-viewport') ? viewport : memberPanel,
    closest: (selector: string) => selector === '.group-main' ? container : overlay,
    ownerDocument: { documentElement: {}, defaultView: {
      get innerHeight() { return containerHeight; },
      getComputedStyle: (target: unknown) => target === overlay ? { maxHeight: '70%' }
        : { paddingTop: '12px', paddingBottom: '12px' },
      ResizeObserver: class {
        constructor(callback: () => void) { observe = callback; }
        observe = observed.observe;
        unobserve = observed.unobserve;
        disconnect = observed.disconnect;
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame: (id: number) => { frames.delete(id); },
    } },
  };
  const scope = effectScope();
  const size = scope.run(() => useViewingSize(shallowRef(element as unknown as HTMLElement), {
    detached: () => detached.value, expanded: () => expanded.value, showMembers: () => showMembers.value,
    preferredHeight: () => preferred.value, setHeight,
  }))!;
  mounted.forEach(callback => callback());
  function measure() {
    observe();
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  }
  return { scope, size, detached, expanded, showMembers, preferred, setHeight, observed, frames, measure, queue: () => observe(),
    setWindowHeight(value: number) { containerHeight = value; },
    setComposerTop(value: number) { composerTop = value; },
    setMemberHeight(value: number) { memberHeight = value; } };
}

it('按实际成员高度与布局边界计算，默认值与首次拖动使用同一上限', () => {
  const f = fixture();
  try {
    expect(f.size.maximumHeight.value).toBe(220);
    expect(f.size.height.value).toBe(220);
    f.size.changeHeight(f.size.height.value + 1);
    expect(f.size.height.value).toBe(220);
    f.size.changeHeight(200);
    expect(f.setHeight).toHaveBeenLastCalledWith(200);
  } finally { f.scope.stop(); }
});

it('缩窗只限制显示，恢复空间后使用原拖动偏好，极矮区域的最小值不超过上限', () => {
  const f = fixture();
  try {
    f.preferred.value = 350;
    f.measure();
    expect(f.size.height.value).toBe(220);
    f.setWindowHeight(1000); f.measure();
    expect(f.size.height.value).toBe(350);
    f.setWindowHeight(500); f.measure();
    expect(f.size.maximumHeight.value).toBe(132);
    expect(f.size.minimumHeight.value).toBe(132);
    expect(f.size.height.value).toBe(132);
    expect(f.preferred.value).toBe(350);
    expect(f.setHeight).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('输入区变高会收窄可用空间，成员折叠使用最终自然高度，不累计动画中间尺寸', async () => {
  const f = fixture();
  try {
    f.setComposerTop(350); f.measure();
    expect(f.size.maximumHeight.value).toBe(150);
    f.showMembers.value = false;
    await nextTick();
    expect(f.size.maximumHeight.value).toBe(350);
    f.setMemberHeight(180); f.measure();
    expect(f.size.height.value).toBe(350);
    expect(f.observed.unobserve).toHaveBeenCalledOnce();
    expect(f.setHeight).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('弹出观看区及主动占满窗口按各自区域计算，销毁取消观察与迟到帧', async () => {
  const f = fixture();
  f.detached.value = true; f.measure();
  expect(f.size.height.value).toBe(400);
  f.expanded.value = true; f.showMembers.value = false;
  await nextTick();
  expect(f.size.height.value).toBe(600);
  f.queue();
  expect(f.frames.size).toBe(1);
  f.scope.stop();
  expect(f.observed.disconnect).toHaveBeenCalledOnce();
  expect(f.frames.size).toBe(0);
});

import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatScroll } from './useChatScroll';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); });

function setup() {
  const scope = effectScope(); scopes.push(scope);
  const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let resize!: () => void;
  const disconnect = vi.fn();
  const metrics = { height: 600, padding: 0, overlayBottom: 100 };
  const owner = { matchMedia: () => preference, getComputedStyle: () => ({ paddingTop: String(metrics.padding) }),
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; } };
  vi.stubGlobal('window', owner); vi.stubGlobal('document', { visibilityState: 'visible' });
  const list = { scrollTop: 100, scrollHeight: 3000, get clientHeight() { return metrics.height; },
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + metrics.height }),
    closest: () => ({ getBoundingClientRect: () => ({ top: 100 }) }),
    parentElement: { closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ bottom: metrics.overlayBottom }) }) }) },
    ownerDocument: { defaultView: owner }, style: { setProperty: vi.fn() }, querySelectorAll: () => [] as unknown[],
    scrollTo: vi.fn() };
  const loadOlder = vi.fn();
  const scroll = scope.run(() => useChatScroll(loadOlder))!;
  scroll.list.value = list as unknown as HTMLElement;
  scroll.atBottom.value = false;
  return { scope, scroll, list, metrics, preference, disconnect, loadOlder, resize: () => resize() };
}

it('语音栏和输入框改变可用高度时，正在阅读的消息随输入框一起移动', () => {
  const f = setup();
  f.scroll.start();
  f.metrics.height = 520; f.resize();
  expect(f.list.scrollTop).toBe(180);
  f.metrics.padding = 200; f.list.scrollHeight += 200; f.resize();
  expect(f.list.scrollTop).toBe(380);
  f.metrics.height = 600; f.resize();
  expect(f.list.scrollTop).toBe(300);
  expect(f.loadOlder).not.toHaveBeenCalled();
});

it('历史插入以语音覆盖下方真正可见的消息为锚点', () => {
  const f = setup();
  f.metrics.overlayBottom = 400;
  let coveredTop = 150, visibleTop = 450;
  f.list.querySelectorAll = () => [
    { getBoundingClientRect: () => ({ top: coveredTop, bottom: coveredTop + 80 }) },
    { getBoundingClientRect: () => ({ top: visibleTop, bottom: visibleTop + 80 }) },
  ];
  const restore = f.scroll.preserveHistoryPosition();
  coveredTop += 140; visibleTop += 80;
  restore();
  expect(f.list.scrollTop).toBe(180);
});

it('销毁释放尺寸观察和动态偏好监听，排队中的滚动不能再操作旧列表', async () => {
  const f = setup();
  f.scroll.start();
  const scrolling = f.scroll.scrollToBottom('smooth', true);
  const restore = f.scroll.preserveHistoryPosition();
  f.scope.stop();
  await scrolling;
  f.metrics.height = 300; f.resize(); restore();
  expect(f.list.scrollTop).toBe(100);
  expect(f.list.scrollTo).not.toHaveBeenCalled();
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.preference.removeEventListener).toHaveBeenCalledWith('change', f.scroll.stopAnimatedScroll);
});

import { afterEach, expect, it, vi } from 'vitest';
import { observeLocalScreenPreview } from './localScreenPreview';

afterEach(() => vi.unstubAllGlobals());

function preview() {
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const element = Object.assign(new EventTarget(), {
    paused: true,
    getClientRects: () => [Object.freeze({})],
    play: vi.fn((): Promise<void> => {
      element.paused = false;
      element.dispatchEvent(new Event('play'));
      return Promise.resolve();
    }),
    pause: vi.fn(() => { element.paused = true; }),
    srcObject: Object.freeze({}),
  });
  let intersection: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('document', page);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const error = vi.fn();
  const stop = observeLocalScreenPreview(element as unknown as HTMLVideoElement, error);
  function visible(value: boolean) {
    intersection([{ target: element, isIntersecting: value } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  }
  function background(value: boolean) {
    page.visibilityState = value ? 'hidden' : 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
  }
  return { element, page, stop, visible, background, disconnect, error };
}

it('隐藏和恢复本地预览只暂停和播放原元素，保留采集流', () => {
  const state = preview();
  const stream = state.element.srcObject;
  expect(state.element.play).toHaveBeenCalledTimes(1);
  state.visible(false);
  expect(state.element.pause).toHaveBeenCalledTimes(1);
  state.visible(false);
  expect(state.element.pause).toHaveBeenCalledTimes(1);
  state.visible(true);
  expect(state.element.play).toHaveBeenCalledTimes(2);
  expect(state.element.srcObject).toBe(stream);
  state.stop();
});

it('最小化时暂停，恢复后仍不可见的预览不播放，失焦不暂停', () => {
  const state = preview();
  state.page.dispatchEvent(new Event('blur'));
  expect(state.element.pause).not.toHaveBeenCalled();
  state.background(true);
  state.visible(false);
  state.background(false);
  expect(state.element.play).toHaveBeenCalledTimes(1);
  state.visible(true);
  expect(state.element.play).toHaveBeenCalledTimes(2);
  state.stop();
});

it('SDK 恢复播放仍隐藏的预览时重新暂停，返回可见后正常播放', async () => {
  const state = preview();
  const stream = state.element.srcObject;
  state.visible(false);
  state.background(true);
  state.background(false);
  await state.element.play();
  expect(state.element.paused).toBe(true);
  state.visible(false);
  await state.element.play();
  expect(state.element.paused).toBe(true);
  expect(state.element.srcObject).toBe(stream);
  expect(state.error).not.toHaveBeenCalled();
  state.visible(true);
  expect(state.element.paused).toBe(false);
  state.background(true);
  await state.element.play();
  expect(state.element.paused).toBe(true);
  state.stop();
});

it('解绑后不再拦截旧元素的外部播放', async () => {
  const state = preview();
  state.visible(false);
  state.stop();
  const pauses = state.element.pause.mock.calls.length;
  await state.element.play();
  expect(state.element.paused).toBe(false);
  expect(state.element.pause).toHaveBeenCalledTimes(pauses);
});

it('解绑后清理监听，迟到的可见性通知不重新播放旧元素', () => {
  const state = preview();
  state.stop();
  expect(state.disconnect).toHaveBeenCalledOnce();
  state.visible(false);
  state.visible(true);
  state.background(true);
  state.background(false);
  expect(state.element.play).toHaveBeenCalledTimes(1);
  expect(state.element.pause).toHaveBeenCalledTimes(1);
});

it('当前播放失败明确报告，旧播放请求失败不污染恢复后的预览', async () => {
  const state = preview();
  let rejectOld: (error: Error) => void;
  vi.mocked(state.element.play).mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
  state.visible(false);
  state.visible(true);
  state.visible(false);
  state.visible(true);
  rejectOld!(new Error('旧播放被中断'));
  await Promise.resolve();
  expect(state.error).not.toHaveBeenCalled();
  vi.mocked(state.element.play).mockRejectedValueOnce(new Error('当前播放失败'));
  state.visible(false);
  state.visible(true);
  await Promise.resolve();
  expect(state.error).toHaveBeenCalledOnce();
  state.stop();
});

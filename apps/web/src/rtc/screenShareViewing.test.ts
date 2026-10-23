import { expect, it } from 'vitest';
import { RemoteTrackPublication, Room, Track, TrackEvent, VideoQuality } from 'livekit-client';
import { observeScreenShareView, syncScreenShareViewing } from './screenShareViewing';

function viewing() {
  const callbacks = new Map<Element, IntersectionObserverCallback>();
  const observerWindow = Object.assign(new EventTarget(), { IntersectionObserver: class {
    constructor(private callback: IntersectionObserverCallback) {}
    private element?: Element;
    observe(element: Element) { this.element = element; callbacks.set(element, this.callback); }
    disconnect() { if (this.element) callbacks.delete(this.element); }
  } });
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible', defaultView: observerWindow });
  const publication = new RemoteTrackPublication(Track.Kind.Video, {
    sid: 'screen', name: 'screen', type: 1, source: 3, simulcast: true,
  } as never, true);
  const updates: unknown[] = [];
  publication.on(TrackEvent.UpdateSettings, (settings) => updates.push(settings));
  const element = () => ({ ownerDocument: page, getClientRects: () => [{}] }) as unknown as HTMLVideoElement;
  function visible(element: HTMLVideoElement, visible: boolean) {
    callbacks.get(element)?.([{ target: element, isIntersecting: visible } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  }
  function background(hidden: boolean) {
    page.visibilityState = hidden ? 'hidden' : 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
  }
  return { page, observerWindow, publication, updates, element, visible, background, callbacks };
}

it('不同窗口合并需求，主窗口隐藏不暂停辅助窗，关窗与迟到回调不影响其他位置', () => {
  const main = viewing(), auxiliary = viewing();
  const small = main.element(), large = auxiliary.element();
  const low = observeScreenShareView(main.publication, small, VideoQuality.LOW);
  const high = observeScreenShareView(main.publication, large, VideoQuality.HIGH);
  const late = auxiliary.callbacks.get(large)!;
  main.background(true);
  expect(main.publication.isEnabled).toBe(true);
  expect(main.publication.videoQuality).toBe(VideoQuality.HIGH);
  auxiliary.background(true);
  expect(main.publication.isEnabled).toBe(false);
  main.background(false);
  expect(main.publication.videoQuality).toBe(VideoQuality.LOW);
  auxiliary.background(false);
  auxiliary.observerWindow.dispatchEvent(new Event('pagehide'));
  expect(main.publication.isEnabled).toBe(true);
  expect(main.publication.videoQuality).toBe(VideoQuality.LOW);
  const count = main.updates.length;
  late([{ target: large, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  high.setQuality(VideoQuality.HIGH); high.stop();
  expect(main.updates).toHaveLength(count);
  low.stop();
  expect(main.publication.isEnabled).toBe(false);
});

it('同一轨道的小预览和独立观看合并为最高可见需求，隐藏不取消订阅', () => {
  const state = viewing();
  const small = state.element(), viewer = state.element();
  const smallView = observeScreenShareView(state.publication, small, VideoQuality.LOW);
  const viewerView = observeScreenShareView(state.publication, viewer, VideoQuality.HIGH);
  expect(state.publication.videoQuality).toBe(VideoQuality.HIGH);
  state.visible(viewer, false);
  expect(state.publication.videoQuality).toBe(VideoQuality.LOW);
  expect(state.publication.isEnabled).toBe(true);
  state.visible(small, false);
  expect(state.publication.isEnabled).toBe(false);
  expect(state.publication.isDesired).toBe(true);
  state.visible(viewer, true);
  expect(state.publication.videoQuality).toBe(VideoQuality.HIGH);
  expect(state.publication.isEnabled).toBe(true);
  viewerView.stop(); smallView.stop();
});

it('设置或最小化暂停全部位置，失焦不暂停，恢复保持原需求', () => {
  const state = viewing();
  const view = observeScreenShareView(state.publication, state.element(), VideoQuality.HIGH);
  state.page.dispatchEvent(new Event('blur'));
  expect(state.publication.isEnabled).toBe(true);
  state.background(true);
  expect(state.publication.isEnabled).toBe(false);
  state.background(false);
  expect(state.publication.isEnabled).toBe(true);
  expect(state.publication.videoQuality).toBe(VideoQuality.HIGH);
  view.setQuality(VideoQuality.LOW);
  expect(state.publication.videoQuality).toBe(VideoQuality.LOW);
  view.stop();
  const count = state.updates.length;
  state.background(true); state.background(false);
  view.setQuality(VideoQuality.HIGH);
  expect(state.updates).toHaveLength(count);
});

it('未展示的新轨道暂停，旧发布对象清理不会影响新发布对象', () => {
  const state = viewing();
  syncScreenShareViewing(state.publication);
  expect(state.publication.isEnabled).toBe(false);
  const oldView = observeScreenShareView(state.publication, state.element(), VideoQuality.LOW);
  const next = viewing();
  const newView = observeScreenShareView(next.publication, next.element(), VideoQuality.HIGH);
  oldView.stop();
  expect(next.publication.isEnabled).toBe(true);
  expect(next.publication.videoQuality).toBe(VideoQuality.HIGH);
  newView.stop();
});

it('SDK 恢复连接会重发暂停及层选择，不恢复默认高清需求', () => {
  const state = viewing();
  const view = observeScreenShareView(state.publication, state.element(), VideoQuality.LOW);
  const room = { remoteParticipants: new Map([['remote', {
    videoTrackPublications: new Map([['screen', state.publication]]),
  }]]) };
  // 使用 SDK 实际的恢复实现，验证 publication 中保留的设置会被重发。
  const resume = (Room.prototype as unknown as { updateSubscriptions(): void }).updateSubscriptions;
  state.updates.length = 0;
  Object.defineProperty(state.publication, 'isSubscribed', { get: () => true });
  resume.call(room);
  expect(state.updates.at(-1)).toMatchObject({ disabled: false, quality: VideoQuality.LOW });
  state.background(true);
  state.updates.length = 0;
  resume.call(room);
  expect(state.updates.at(-1)).toMatchObject({ disabled: true });
  view.stop();
});

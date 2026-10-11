import { afterEach, expect, it, vi } from 'vitest';
import { RemoteTrackPublication, Room, Track, TrackEvent, VideoQuality } from 'livekit-client';
import { observeScreenShareView, syncScreenShareViewing } from './screenShareViewing';

afterEach(() => vi.unstubAllGlobals());

function viewing() {
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const callbacks = new Map<Element, IntersectionObserverCallback>();
  vi.stubGlobal('document', page);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    private element?: Element;
    observe(element: Element) { this.element = element; callbacks.set(element, this.callback); }
    disconnect() { if (this.element) callbacks.delete(this.element); }
  });
  const publication = new RemoteTrackPublication(Track.Kind.Video, {
    sid: 'screen', name: 'screen', type: 1, source: 3, simulcast: true,
  } as never, true);
  const updates: unknown[] = [];
  publication.on(TrackEvent.UpdateSettings, (settings) => updates.push(settings));
  const element = () => ({ getClientRects: () => [{}] }) as unknown as HTMLVideoElement;
  function visible(element: HTMLVideoElement, visible: boolean) {
    callbacks.get(element)?.([{ target: element, isIntersecting: visible } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  }
  function background(hidden: boolean) {
    page.visibilityState = hidden ? 'hidden' : 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
  }
  return { page, publication, updates, element, visible, background, callbacks };
}

it('同一轨道的小窗和舞台合并为最高可见需求，隐藏不取消订阅', () => {
  const state = viewing();
  const small = state.element(), stage = state.element();
  const smallView = observeScreenShareView(state.publication, small, VideoQuality.LOW);
  const stageView = observeScreenShareView(state.publication, stage, VideoQuality.HIGH);
  expect(state.publication.videoQuality).toBe(VideoQuality.HIGH);
  state.visible(stage, false);
  expect(state.publication.videoQuality).toBe(VideoQuality.LOW);
  expect(state.publication.isEnabled).toBe(true);
  state.visible(small, false);
  expect(state.publication.isEnabled).toBe(false);
  expect(state.publication.isDesired).toBe(true);
  state.visible(stage, true);
  expect(state.publication.videoQuality).toBe(VideoQuality.HIGH);
  expect(state.publication.isEnabled).toBe(true);
  stageView.stop(); smallView.stop();
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

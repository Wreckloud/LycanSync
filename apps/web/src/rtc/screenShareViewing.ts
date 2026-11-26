import { VideoQuality, type RemoteTrackPublication } from 'livekit-client';

interface ViewDemand { element: HTMLVideoElement; reason: 'visible' | 'inactive' | 'window-hidden' | 'offscreen' | null; quality: VideoQuality }
interface ViewingState { demands: Set<ViewDemand>; revision: number }
const viewingDemands = new WeakMap<RemoteTrackPublication, ViewingState>();
const qualityNames = { [VideoQuality.LOW]: 'low', [VideoQuality.MEDIUM]: 'medium', [VideoQuality.HIGH]: 'high' } as const;

function visibleQuality(visible: ViewDemand[]) {
  return visible.reduce<VideoQuality | null>((highest, demand) =>
    highest === null || demand.quality > highest ? demand.quality : highest, null);
}

function updateViewing(publication: RemoteTrackPublication, state: ViewingState) {
  state.revision++;
  const visible = [...state.demands].filter((demand) => demand.reason === 'visible');
  const quality = visibleQuality(visible);
  if (quality !== null) publication.setVideoQuality(quality);
  // 保留订阅及轨道；SDK 重连时会重发此设置，dynacast 按全房间需求暂停发送层。
  publication.setEnabled(visible.length > 0);
}

export function syncScreenShareViewing(publication: RemoteTrackPublication) {
  let state = viewingDemands.get(publication);
  if (!state) { state = { demands: new Set(), revision: 0 }; viewingDemands.set(publication, state); }
  updateViewing(publication, state);
}

/** 读取已有观看需求，不创建订阅；计数不包含窗口标题、账号或来源标识。 */
export function readScreenShareViewing(publication: object) {
  const state = viewingDemands.get(publication as RemoteTrackPublication);
  if (!state) return null;
  const demands = [...state.demands];
  const visible = demands.filter(demand => demand.reason === 'visible');
  const quality = visibleQuality(visible);
  return { revision: state.revision, registeredViews: demands.length, visibleViews: visible.length,
    inactiveViews: demands.filter(demand => demand.reason === 'inactive').length,
    hiddenWindowViews: demands.filter(demand => demand.reason === 'window-hidden').length,
    offscreenViews: demands.filter(demand => demand.reason === 'offscreen').length,
    requestedQuality: quality === null ? null : qualityNames[quality] };
}

export function isScreenShareViewVisible(publication: object, element: HTMLVideoElement) {
  const state = viewingDemands.get(publication as RemoteTrackPublication);
  if (!state) return null;
  return [...state.demands].some(demand => demand.element === element && demand.reason === 'visible');
}

export function observeScreenShareView(publication: RemoteTrackPublication, element: HTMLVideoElement,
  quality: VideoQuality, initiallyActive = true) {
  const page = element.ownerDocument;
  const viewWindow = page.defaultView;
  if (!viewWindow) throw new Error('screenShareViewWindowUnavailable');
  let disposed = false;
  let active = initiallyActive;
  let intersecting = element.getClientRects().length > 0;
  const demand: ViewDemand = { element, reason: null, quality };
  let state = viewingDemands.get(publication);
  if (!state) { state = { demands: new Set(), revision: 0 }; viewingDemands.set(publication, state); }
  const currentState = state;
  currentState.demands.add(demand);
  function updateVisibility() {
    if (disposed) return;
    const reason = !active ? 'inactive' : page.visibilityState === 'hidden' ? 'window-hidden' : !intersecting ? 'offscreen' : 'visible';
    if (demand.reason === reason) return;
    demand.reason = reason;
    updateViewing(publication, currentState);
  }
  // 每个观看位置使用所属窗口，主窗口隐藏不能暂停仍可见的独立窗。
  const observer = new viewWindow.IntersectionObserver((entries) => {
    // 此观察器只跟踪一个元素，同批通知以最后一次位置变化为准。
    const entry = entries.at(-1);
    if (disposed || entry?.target !== element) return;
    intersecting = entry.isIntersecting;
    updateVisibility();
  });
  observer.observe(element);
  page.addEventListener('visibilitychange', updateVisibility);
  viewWindow.addEventListener('pagehide', stop);
  updateVisibility();
  function stop() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    page.removeEventListener('visibilitychange', updateVisibility);
    viewWindow!.removeEventListener('pagehide', stop);
    currentState.demands.delete(demand);
    // 空需求仍保留暂停原因与变化序号；发布对象释放时由 WeakMap 一并回收。
    // 布局交接在同一次 Vue 更新中先解绑再挂载；等本轮结束，避免无意义地暂停再恢复远端。
    if (!currentState.demands.size) queueMicrotask(() => {
      if (!currentState.demands.size) updateViewing(publication, currentState);
    });
    else updateViewing(publication, currentState);
  }
  return {
    setActive(enabled: boolean) {
      if (disposed || active === enabled) return;
      active = enabled;
      updateVisibility();
    },
    setQuality(next: VideoQuality) {
      if (disposed || demand.quality === next) return;
      demand.quality = next;
      updateViewing(publication, currentState);
    },
    stop,
  };
}

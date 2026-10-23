import { VideoQuality, type RemoteTrackPublication } from 'livekit-client';

interface ViewDemand { visible: boolean; quality: VideoQuality }
const viewingDemands = new WeakMap<RemoteTrackPublication, Set<ViewDemand>>();

function updateViewing(publication: RemoteTrackPublication, demands: Set<ViewDemand>) {
  const visible = [...demands].filter((demand) => demand.visible);
  if (visible.length) {
    publication.setVideoQuality(visible.some((demand) => demand.quality === VideoQuality.HIGH)
      ? VideoQuality.HIGH : VideoQuality.LOW);
  }
  // 保留订阅及轨道；SDK 重连时会重发此设置，dynacast 按全房间需求暂停发送层。
  publication.setEnabled(visible.length > 0);
}

export function syncScreenShareViewing(publication: RemoteTrackPublication) {
  updateViewing(publication, viewingDemands.get(publication) ?? new Set());
}

export function observeScreenShareView(publication: RemoteTrackPublication, element: HTMLVideoElement,
  quality: VideoQuality) {
  const page = element.ownerDocument;
  const viewWindow = page.defaultView;
  if (!viewWindow) throw new Error('screenShareViewWindowUnavailable');
  let disposed = false;
  let intersecting = element.getClientRects().length > 0;
  const demand: ViewDemand = { visible: false, quality };
  let demands = viewingDemands.get(publication);
  if (!demands) { demands = new Set(); viewingDemands.set(publication, demands); }
  const currentDemands = demands;
  currentDemands.add(demand);
  function updateVisibility() {
    if (disposed) return;
    demand.visible = intersecting && page.visibilityState !== 'hidden';
    updateViewing(publication, currentDemands);
  }
  // 每个观看位置使用所属窗口，主窗口隐藏不能暂停仍可见的独立窗。
  const observer = new viewWindow.IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === element);
    if (!entry || disposed) return;
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
    currentDemands.delete(demand);
    updateViewing(publication, currentDemands);
    if (!currentDemands.size) viewingDemands.delete(publication);
  }
  return {
    setQuality(next: VideoQuality) {
      if (disposed || demand.quality === next) return;
      demand.quality = next;
      updateVisibility();
    },
    stop,
  };
}

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
  let disposed = false;
  let intersecting = element.getClientRects().length > 0;
  const demand: ViewDemand = { visible: false, quality };
  let demands = viewingDemands.get(publication);
  if (!demands) { demands = new Set(); viewingDemands.set(publication, demands); }
  const currentDemands = demands;
  currentDemands.add(demand);
  function updateVisibility() {
    if (disposed) return;
    demand.visible = intersecting && document.visibilityState !== 'hidden';
    updateViewing(publication, currentDemands);
  }
  const observer = new IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === element);
    if (!entry || disposed) return;
    intersecting = entry.isIntersecting;
    updateVisibility();
  });
  observer.observe(element);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
  return {
    setQuality(next: VideoQuality) {
      if (disposed || demand.quality === next) return;
      demand.quality = next;
      updateVisibility();
    },
    stop() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
      currentDemands.delete(demand);
      updateViewing(publication, currentDemands);
      if (!currentDemands.size) viewingDemands.delete(publication);
    },
  };
}

// 本地预览只控制播放元素；采集轨道和对外发布由房间媒体流程持有。
export function observeLocalScreenPreview(element: HTMLVideoElement, onPlaybackError: () => void): () => void {
  let disposed = false;
  let intersecting = element.getClientRects().length > 0;
  let playing: boolean | undefined;
  let playbackRequest = 0;

  function updatePlayback() {
    if (disposed) return;
    const visible = intersecting && document.visibilityState !== 'hidden';
    if (playing === visible) return;
    playing = visible;
    const request = ++playbackRequest;
    if (!visible) {
      element.pause();
      return;
    }
    // 保留 srcObject，恢复时直接播放当前采集画面，不重开设备或发布轨道。
    void element.play().catch(() => {
      if (!disposed && playing && request === playbackRequest) onPlaybackError();
    });
  }

  function preventHiddenPlayback() {
    // SDK 恢复窗口时会重新播放所有绑定元素，不能只依赖缓存的可见状态。
    if (!disposed && (!intersecting || document.visibilityState === 'hidden')) element.pause();
  }

  const observer = new IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === element);
    if (!entry || disposed) return;
    intersecting = entry.isIntersecting;
    updatePlayback();
  });
  observer.observe(element);
  document.addEventListener('visibilitychange', updatePlayback);
  element.addEventListener('play', preventHiddenPlayback);
  updatePlayback();

  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener('visibilitychange', updatePlayback);
    element.removeEventListener('play', preventHiddenPlayback);
    element.pause();
  };
}

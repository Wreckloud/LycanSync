export type ViewerWindowState = { visible: boolean; focused: boolean; pinned: boolean };

export async function initializeViewerPage(view: Window) {
  const root = view.document.getElementById('viewer-root');
  const id = view.location.hash.slice(1);
  if (!root || !view.opener || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    if (root) root.textContent = '观看窗口来源无效，请回到应用重新打开。';
    return;
  }
  let disposed = false;
  let receivedState = false;
  const bridge = view.lycanViewerWindow;
  const disarm = () => view.dispatchEvent(new Event('lycan-viewer-disarm'));
  const update = (state: ViewerWindowState) => {
    if (disposed) return;
    // 同进程页面信号不够精确，原生窗口独立控制自己的观看根节点。
    root.hidden = !state.visible;
    if (!state.visible || !state.focused) disarm();
    view.dispatchEvent(new CustomEvent('lycan-viewer-state', { detail: state }));
  };
  const stopState = bridge?.onState((state) => { receivedState = true; update(state); });
  const stopDisarm = bridge?.onDisarm(disarm);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopState?.();
    stopDisarm?.();
  }
  view.addEventListener('pagehide', dispose, { once: true });
  try {
    if (bridge) {
      const initial = await bridge.ready();
      if (!receivedState) update(initial);
    }
    if (!disposed) view.opener.postMessage({ type: 'lycan-viewer-ready', id }, view.location.origin);
  } catch {
    if (!disposed) {
      dispose();
      root.textContent = '观看窗口初始化失败，请关闭后重新打开。';
    }
  }
}

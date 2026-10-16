const ENTRY_WIDTHS = { startup: 420, account: 440, invitation: 480, profile: 680 };

function centeredBounds(area, width, height) {
  width = Math.min(width, area.width - 32);
  height = Math.min(height, area.height - 32);
  return { x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2), width, height };
}

function initialWindowBounds(area) {
  return centeredBounds(area, ENTRY_WIDTHS.startup, 260);
}

// 同一窗口承载入口页与主界面，切换尺寸不重建页面或通话资源。
function createWindowLayout(window, screen) {
  let mode = 'startup';
  let mainBounds;
  let mainMaximized = false;

  function apply(nextMode, height) {
    if (nextMode !== 'main' && !Object.hasOwn(ENTRY_WIDTHS, nextMode)) throw new Error('窗口模式无效');
    if (!Number.isFinite(height) || height < 0 || height > 4096) throw new Error('窗口高度无效');
    if (window.isDestroyed()) return;
    if (nextMode === 'main' && mode === 'main') return;
    const current = window.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    if (nextMode === 'main') {
      const bounds = mainBounds ?? centeredBounds(area, 1280, 820);
      const width = Math.min(bounds.width, area.width - 32);
      const fittedHeight = Math.min(bounds.height, area.height - 32);
      window.setResizable(true);
      window.setMaximizable(true);
      window.setMinimumSize(Math.min(920, area.width - 32), Math.min(640, area.height - 32));
      window.setBounds({ width, height: fittedHeight,
        x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - fittedHeight)) });
      if (mainMaximized) window.maximize();
    } else {
      if (mode === 'main') {
        mainBounds = window.getNormalBounds();
        mainMaximized = window.isMaximized();
        if (mainMaximized) window.unmaximize();
      }
      window.setMinimumSize(0, 0);
      window.setResizable(false);
      window.setMaximizable(false);
      const bounds = centeredBounds(area, ENTRY_WIDTHS[nextMode], Math.max(160, Math.ceil(height)));
      // 展开“更多”仅调整高度，保留用户拖动后的位置，并确保底部仍可操作。
      if (nextMode === mode) {
        bounds.x = Math.max(area.x, Math.min(current.x, area.x + area.width - bounds.width));
        bounds.y = Math.max(area.y, Math.min(current.y, area.y + area.height - bounds.height));
      }
      if (Object.keys(bounds).some((key) => bounds[key] !== current[key])) window.setBounds(bounds);
    }
    mode = nextMode;
  }

  return { apply };
}

module.exports = { initialWindowBounds, createWindowLayout };

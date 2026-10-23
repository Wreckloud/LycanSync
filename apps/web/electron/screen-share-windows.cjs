const { resolve } = require('node:path');

const VIEWER_PAGE = 'lycan://app/viewer.html';
const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READY_TIMEOUT_MS = 8000;

function viewerId(url, frameName) {
  if (typeof url !== 'string' || !url.startsWith(`${VIEWER_PAGE}#`)) return undefined;
  const id = url.slice(VIEWER_PAGE.length + 1);
  return VIEWER_ID.test(id) && frameName === `lycan-viewer-${id}` ? id : undefined;
}

function windowVisible(window) {
  return !window.isDestroyed() && window.isVisible() && !window.isMinimized();
}

function createScreenShareWindows() {
  const viewers = new Map();
  let mainWindow;
  let detachMain;

  function sendMain(channel, value) {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, value);
    }
  }

  function state(entry) {
    const window = entry.window;
    return { visible: windowVisible(window), focused: window.isFocused(), pinned: window.isAlwaysOnTop() };
  }

  function publishState(entry) {
    if (entry.ready && !entry.window.isDestroyed()) entry.window.webContents.send('viewer:state', state(entry));
  }

  function forget(entry, failed) {
    if (viewers.get(entry.id) !== entry) return;
    // 先撤销登记，销毁和迟到的就绪通知都不能再接回旧窗口。
    viewers.delete(entry.id);
    clearTimeout(entry.timer);
    sendMain('viewer:closed', { id: entry.id, failed });
  }

  function destroy(entry, failed = false) {
    forget(entry, failed);
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
  }

  function closeAll() {
    for (const entry of [...viewers.values()]) destroy(entry);
  }

  function trustedEntry(event) {
    const entry = [...viewers.values()].find((candidate) => candidate.window?.webContents === event.sender);
    if (!entry || entry.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame
        || event.senderFrame.url !== `${VIEWER_PAGE}#${entry.id}`) throw new Error('观看窗口请求来源无效。');
    return entry;
  }

  function attach(window) {
    closeAll();
    detachMain?.();
    mainWindow = window;
    const contents = window.webContents;
    const visibility = () => sendMain('window:visibility', windowVisible(window));
    const onClosed = () => { closeAll(); detachMain?.(); mainWindow = undefined; };
    const onCreated = (child, details) => {
      const id = viewerId(details.url, details.frameName);
      const entry = viewers.get(id);
      if (!entry || entry.window) { child.destroy(); return; }
      entry.window = child;
      child.setMenu(null);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', (event, url) => {
        if (entry.ready || url !== `${VIEWER_PAGE}#${id}`) event.preventDefault();
      });
      child.webContents.on('will-redirect', (event) => event.preventDefault());
      child.webContents.on('will-attach-webview', (event) => event.preventDefault());
      child.webContents.on('render-process-gone', () => destroy(entry, true));
      child.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame) destroy(entry, true);
      });
      child.on('closed', () => forget(entry, false));
      for (const name of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur', 'always-on-top-changed']) {
        child.on(name, () => publishState(entry));
      }
      // 移动／缩放也要释放按键；恢复焦点只恢复显示，输入须由用户重新点击激活。
      for (const name of ['blur', 'hide', 'minimize', 'will-move', 'will-resize']) {
        child.on(name, () => { if (entry.ready && !child.isDestroyed()) child.webContents.send('viewer:disarm'); });
      }
    };
    contents.setWindowOpenHandler(({ url, frameName, disposition, postBody }) => {
      const id = viewerId(url, frameName);
      if (!id || viewers.has(id) || window.isDestroyed() || postBody || disposition === 'background-tab') return { action: 'deny' };
      const entry = { id, window: undefined, ready: false };
      entry.timer = setTimeout(() => destroy(entry, true), READY_TIMEOUT_MS);
      entry.timer.unref?.();
      viewers.set(id, entry);
      return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
        width: 960, height: 600, minWidth: 320, minHeight: 240,
        frame: true, show: false, backgroundColor: '#10151a', title: 'LycanSync · 观看共享',
        autoHideMenuBar: true, alwaysOnTop: false, resizable: true, maximizable: true, minimizable: true,
        // 与主窗口保持同进程安全设置，复用轨道；观看页只直接安装自己的固定窗口桥。
        webPreferences: { preload: resolve(__dirname, 'viewer-preload.cjs'), sandbox: true,
          contextIsolation: true, nodeIntegration: false, webSecurity: true },
      } };
    });
    contents.on('did-create-window', onCreated);
    contents.on('did-finish-load', visibility);
    for (const name of ['show', 'hide', 'minimize', 'restore']) window.on(name, visibility);
    window.once('closed', onClosed);
    detachMain = () => {
      contents.removeListener('did-create-window', onCreated);
      contents.removeListener('did-finish-load', visibility);
      for (const name of ['show', 'hide', 'minimize', 'restore']) window.removeListener(name, visibility);
      window.removeListener('closed', onClosed);
      detachMain = undefined;
    };
  }

  return {
    attach, closeAll,
    mainVisible: () => Boolean(mainWindow && windowVisible(mainWindow)),
    focus(id) {
      const entry = viewers.get(id);
      if (!entry?.window || entry.window.isDestroyed()) throw new Error('观看窗口已失效。');
      if (!entry.ready) return;
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
    },
    ready(event) {
      const entry = trustedEntry(event);
      if (!entry.ready) {
        entry.ready = true;
        clearTimeout(entry.timer);
        entry.window.show();
      }
      return state(entry);
    },
    pin(event, enabled) {
      const entry = trustedEntry(event);
      if (!entry.ready || typeof enabled !== 'boolean') throw new Error('置顶设置无效。');
      entry.window.setAlwaysOnTop(enabled);
      const current = state(entry);
      if (current.pinned !== enabled) throw new Error('系统未能确认窗口置顶。');
      return current;
    },
    fullscreen(event, enabled) {
      const entry = trustedEntry(event);
      if (!entry.ready || (enabled !== undefined && typeof enabled !== 'boolean')) throw new Error('全屏操作无效。');
      entry.window.webContents.send('viewer:disarm');
      entry.window.setFullScreen(enabled ?? !entry.window.isFullScreen());
    },
  };
}

module.exports = { createScreenShareWindows };

const { readFileSync } = require('node:fs');
const { mkdir, writeFile, rename } = require('node:fs/promises');
const { dirname } = require('node:path');

// 托盘只管理窗口可见性；真正退出仍由主窗口执行现有媒体收尾。
function createDesktopTray({ Tray, Menu, iconPath, settingsPath, getWindow, onQuit, platform = process.platform }) {
  let tray;
  let closeToTray = true;
  let quitting = false;
  let saving = false;
  let notified = false;
  let error = '';

  function settings() {
    const supported = Boolean(tray && !tray.isDestroyed());
    return { supported, enabled: supported && closeToTray, error };
  }

  function show() {
    const window = getWindow();
    if (quitting || !window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    if (!window.isFocused()) window.focus();
  }

  function prepareToQuit() { quitting = true; }

  function quit() {
    if (quitting) return;
    prepareToQuit();
    onQuit();
  }

  return {
    settings, show, quit, prepareToQuit,
    initialize() {
      if (platform !== 'win32' || tray || quitting) return;
      try {
        const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
        if (!saved || typeof saved.closeToTray !== 'boolean') throw new Error('invalidTraySettings');
        closeToTray = saved.closeToTray;
      } catch (failure) {
        if (failure.code !== 'ENOENT') {
          closeToTray = false;
          error = '无法读取托盘设置，请重新保存。';
          console.error('无法读取托盘设置');
        }
      }
      try {
        tray = new Tray(iconPath);
        tray.setToolTip('lycanclaw');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '显示主界面', click: show },
          { label: '退出', click: quit },
        ]));
        tray.on('click', show);
        tray.on('balloon-click', show);
      } catch {
        tray?.destroy();
        tray = undefined;
        error = '托盘启动失败，本次关闭窗口将退出应用。';
        console.error('无法创建托盘，关闭窗口将退出应用');
      }
    },
    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('托盘设置无效');
      if (!settings().supported || quitting) throw new Error('当前无法使用托盘');
      if (saving) throw new Error('正在保存托盘设置');
      saving = true;
      try {
        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(`${settingsPath}.tmp`, `${JSON.stringify({ closeToTray: enabled }, null, 2)}\n`, 'utf8');
        await rename(`${settingsPath}.tmp`, settingsPath);
        closeToTray = enabled;
        error = '';
        return settings();
      } catch {
        throw new Error('无法保存托盘设置，请重试。');
      } finally { saving = false; }
    },
    handleClose(event) {
      const window = getWindow();
      if (quitting || !settings().enabled || !window || window.isDestroyed()) return false;
      event.preventDefault();
      window.hide();
      if (!notified) {
        notified = true;
        try {
          tray.displayBalloon({ title: 'lycanclaw 仍在后台运行',
            content: '通话、共享和录制会继续。点击托盘图标显示主界面，右键选择“退出”结束应用。',
            iconType: 'info', noSound: true, respectQuietTime: true });
        } catch { console.error('无法显示托盘提示'); }
      }
      return true;
    },
    dispose() {
      prepareToQuit();
      tray?.destroy();
      tray = undefined;
    },
  };
}

module.exports = { createDesktopTray };

function updateFeedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('打包时必须指定有效的 HTTPS 更新目录。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('更新目录必须使用 HTTPS，不能包含凭据、查询参数或片段。');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

// 启动和手动确认共用下载、校验与安装，只允许一个在途更新任务。
function createStartupUpdate({ enabled, version, createUpdater, onChange, beforeInstall, onInstallFailure,
  updaterCachePath, checkTimeoutMs = 10_000, onTiming = () => {} }) {
  let state = { phase: 'idle', version, supported: enabled, message: enabled ? '等待检查更新' : '开发模式不检查更新' };
  let startupPromise;
  let resolveStartup;
  let updater;
  let cancellationToken;
  let checkTimer;
  let finished = false;
  let manualCheckPromise;
  let installPromise;
  let generation = 0;

  function publish(changes) {
    state = { ...state, ...changes };
    onChange({ ...state });
  }

  function complete(message, error = false) {
    if (finished) return;
    finished = true;
    clearTimeout(checkTimer);
    cancellationToken?.cancel();
    updater?.removeListener('download-progress', progress);
    publish({ phase: 'ready', message, error, percent: undefined });
    resolveStartup?.({ ...state });
  }

  function fail(error) {
    if (finished) return;
    const installing = ['preparing', 'installing'].includes(state.phase);
    if (installing) onInstallFailure();
    // 不向页面透传安装路径、远端响应正文或 SDK 堆栈。
    console.error('客户端启动更新失败', state.phase, error?.code ?? error?.name ?? 'Error');
    const message = installing ? '无法启动更新安装，请稍后手动安装新版。'
      : state.phase === 'downloading' ? '新版下载或校验失败，仍可使用当前版本。下次打开时重试。'
      : '无法检查更新，仍可使用当前版本。请检查网络和服务器证书，下次打开时重试。';
    complete(message, true);
  }

  function progress(download) {
    if (finished || state.phase !== 'downloading') return;
    const percent = Math.max(0, Math.min(100, Math.floor(download.percent)));
    if (Number.isFinite(percent) && percent !== state.percent) publish({ percent });
  }

  function getUpdater() {
    if (updater) return updater;
    updater = createUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    // electron-updater 默认把安装包放在 %LOCALAPPDATA%，这里改到调用方给出的运行目录。
    if (updaterCachePath && updater.app) {
      const cachePath = updaterCachePath;
      Object.defineProperty(updater.app, 'baseCachePath', { configurable: true, enumerable: true, get: () => cachePath });
    }
    // 启动结束后仍接住 SDK 的 error 事件；手动检查通过自身 Promise 报错。
    updater.on('error', error => { if (state.phase === 'installing') fail(error); });
    return updater;
  }

  async function checkAndInstall(current) {
    const active = () => !finished && current === generation;
    try {
      getUpdater();
      updater.on('download-progress', progress);
      publish({ phase: 'checking', error: false, percent: undefined, message: '正在检查更新…' });
      const checkingAt = performance.now();
      checkTimer = setTimeout(() => complete('更新检查超时，仍可使用当前版本。下次打开时重试。', true), checkTimeoutMs);
      const result = await updater.checkForUpdates();
      if (!active()) return;
      clearTimeout(checkTimer);
      await onTiming('updateCheck', Math.round(performance.now() - checkingAt));
      if (!active()) return;
      if (!result) throw new Error('更新检查没有返回结果');
      if (!result.isUpdateAvailable) {
        complete('当前已是最新版本');
        return;
      }
      cancellationToken = result.cancellationToken;
      publish({ phase: 'downloading', nextVersion: result.updateInfo.version, percent: 0, message: '正在下载新版…' });
      const downloadingAt = performance.now();
      // SDK 负责缓存复用、SHA-512 与可用的签名校验；校验成功才会结束 downloadUpdate。
      const files = await updater.downloadUpdate(cancellationToken);
      if (!active()) return;
      await onTiming('updateDownloadAndVerify', Math.round(performance.now() - downloadingAt));
      if (!active()) return;
      if (!files?.length) throw new Error('更新安装包不可用');
      publish({ phase: 'preparing', percent: undefined, message: '正在保存录制并准备安装…' });
      const preparingAt = performance.now();
      await beforeInstall(state.intent);
      if (!active()) { onInstallFailure(); return; }
      await onTiming('updatePrepare', Math.round(performance.now() - preparingAt));
      if (!active()) return;
      publish({ phase: 'installing', message: '即将开始安装，完成后自动打开应用…' });
      updater.autoRunAppAfterInstall = true;
      updater.quitAndInstall(false, true);
    } catch (error) { if (active()) fail(error); }
  }

  async function checkVersion() {
    let timeout;
    publish({ phase: 'checking', message: '正在检查更新…', error: false, nextVersion: undefined, percent: undefined });
    try {
      const result = await Promise.race([
        getUpdater().checkForUpdates(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('更新检查超时')), checkTimeoutMs); }),
      ]);
      if (!result) throw new Error('更新检查没有返回结果');
      const nextVersion = result.isUpdateAvailable ? result.updateInfo.version : undefined;
      publish({ phase: 'ready', nextVersion, message: nextVersion
        ? `发现新版 ${nextVersion}，可重启应用更新。` : '当前已是最新版本' });
    } catch (error) {
      console.error('客户端手动检查更新失败', error?.code ?? error?.name ?? 'Error');
      publish({ phase: 'ready', error: true, message: '无法检查更新，请检查网络和服务器证书后重试。' });
    } finally { clearTimeout(timeout); }
    return { ...state };
  }

  return {
    getState: () => ({ ...state }),
    start: () => {
      if (!startupPromise) {
        startupPromise = new Promise((resolve) => { resolveStartup = resolve; });
        if (finished) resolveStartup({ ...state });
        else if (!enabled) complete(state.message);
        else {
          publish({ intent: 'startup' });
          void checkAndInstall(++generation);
        }
      }
      return startupPromise;
    },
    cancel: () => complete('本次更新已跳过，下次打开时检查。'),
    install: () => {
      if (installPromise) return installPromise;
      if (!enabled || !finished || manualCheckPromise || state.error || !state.nextVersion) {
        return Promise.reject(new Error('请先检查并确认有可用的新版本'));
      }
      finished = false;
      cancellationToken = undefined;
      installPromise = new Promise(resolve => { resolveStartup = resolve; }).finally(() => { installPromise = undefined; });
      publish({ intent: 'manual' });
      void checkAndInstall(++generation);
      return installPromise;
    },
    checkOnly: () => {
      if (!enabled) return Promise.resolve({ ...state });
      if (!finished || installPromise) return Promise.reject(new Error('更新尚未结束，请稍后检查。'));
      // 同一次点击任务共用结果；超时后的 SDK 迟到结果不会进入安装链路。
      if (!manualCheckPromise) manualCheckPromise = checkVersion().finally(() => { manualCheckPromise = undefined; });
      return manualCheckPromise;
    },
  };
}

function parseInstallTiming(text, version) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  const installedVersion = text.match(/^version=([^\r\n]+)\r?$/m)?.[1];
  const duration = text.match(/^durationMs=(\d{1,9})\r?$/m)?.[1];
  if (installedVersion !== version || !duration || Number(duration) > 30 * 60_000) return null;
  return { stage: 'updateInstall', durationMs: Number(duration) };
}

module.exports = { updateFeedUrl, createStartupUpdate, parseInstallTiming };

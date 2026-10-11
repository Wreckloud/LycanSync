function updateFeedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('打包时必须指定有效的 HTTPS 更新目录。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('更新目录必须使用 HTTPS，不能包含凭据、查询参数或片段。');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

// 每个主进程只检查一次；进入业务界面后，迟到的检查或下载不能再触发安装。
function createStartupUpdate({ enabled, version, createUpdater, onChange, beforeInstall, onInstallFailure,
  checkTimeoutMs = 10_000 }) {
  let state = { phase: 'idle', version, supported: enabled, message: enabled ? '等待检查更新' : '开发模式不检查更新' };
  let startupPromise;
  let resolveStartup;
  let updater;
  let cancellationToken;
  let checkTimer;
  let finished = false;

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
    const installing = state.phase === 'installing';
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

  async function checkAndInstall() {
    try {
      updater = createUpdater();
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      updater.disableWebInstaller = true;
      updater.logger = null;
      // 保留 error 监听来接住取消后的 SDK 迟到错误，不再改动已结束的启动状态。
      updater.on('error', fail);
      updater.on('download-progress', progress);
      publish({ phase: 'checking', message: '正在检查更新…' });
      checkTimer = setTimeout(() => complete('更新检查超时，仍可使用当前版本。下次打开时重试。', true), checkTimeoutMs);
      const result = await updater.checkForUpdates();
      clearTimeout(checkTimer);
      if (finished) return;
      if (!result) throw new Error('更新检查没有返回结果');
      if (!result.isUpdateAvailable) {
        complete('当前已是最新版本');
        return;
      }
      cancellationToken = result.cancellationToken;
      publish({ phase: 'downloading', nextVersion: result.updateInfo.version, percent: 0, message: '正在下载新版…' });
      // SDK 负责缓存复用、SHA-512 与可用的签名校验；校验成功才会结束 downloadUpdate。
      const files = await updater.downloadUpdate(cancellationToken);
      if (finished) return;
      if (!files?.length) throw new Error('更新安装包不可用');
      publish({ phase: 'installing', percent: 100, message: '正在安装，即将重新打开…' });
      await beforeInstall();
      if (finished) { onInstallFailure(); return; }
      updater.quitAndInstall(true, true);
    } catch (error) { fail(error); }
  }

  return {
    getState: () => ({ ...state }),
    start: () => {
      if (!startupPromise) {
        startupPromise = new Promise((resolve) => { resolveStartup = resolve; });
        if (finished) resolveStartup({ ...state });
        else if (!enabled) complete(state.message);
        else void checkAndInstall();
      }
      return startupPromise;
    },
    cancel: () => complete('本次更新已跳过，下次打开时检查。'),
  };
}

module.exports = { updateFeedUrl, createStartupUpdate };

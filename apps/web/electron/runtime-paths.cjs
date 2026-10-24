const { copyFileSync, cpSync, existsSync, mkdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const defaultIo = { copyFileSync, cpSync, existsSync, mkdirSync, unlinkSync, writeFileSync };
// 只迁入程序自己的文件。Chromium 缓存留在旧目录，避免把用户目录里的缓存再复制一份。
const OWNED_FILES = [
  'session.bin', 'server-config.json', 'pending-access.bin',
  'screen-share-error.log', 'screen-share-error.log.previous',
];

function sameDirectory(left, right) {
  const from = resolve(left);
  const to = resolve(right);
  return process.platform === 'win32' ? from.toLowerCase() === to.toLowerCase() : from === to;
}

function runtimeLayout({ packaged, execPath, projectDirectory, explicitUserDataDir, appName, legacyRoot }) {
  const explicit = explicitUserDataDir == null ? undefined : resolve(explicitUserDataDir);
  const userData = explicit ?? (packaged ? join(dirname(execPath), 'data') : join(projectDirectory, 'data', 'desktop'));
  return {
    userData,
    sessionData: userData,
    crashDumps: join(userData, 'crashDumps'),
    logs: join(userData, 'logs'),
    updaterCachePath: join(userData, 'updater'),
    legacyUserData: explicit || legacyRoot == null ? undefined : join(legacyRoot, appName),
  };
}

function ensureWritableDirectory(directory, io = defaultIo) {
  const probe = join(directory, '.write-probe');
  try {
    io.mkdirSync(directory, { recursive: true });
    try {
      io.writeFileSync(probe, '');
    } finally {
      try { io.unlinkSync(probe); } catch { /* 探针未留下时无需清理。 */ }
    }
  } catch (error) {
    if (String(error.message).startsWith('无法在运行目录保存数据')) throw error;
    throw new Error(`无法在运行目录保存数据（${error.code ?? '写入失败'}）：${directory}`, { cause: error });
  }
}

function migrateOwnedData(fromDirectory, toDirectory, io = defaultIo) {
  if (!fromDirectory || !toDirectory || sameDirectory(fromDirectory, toDirectory) || !io.existsSync(fromDirectory)) return;
  try {
    for (const name of OWNED_FILES) {
      const source = join(fromDirectory, name);
      const target = join(toDirectory, name);
      if (io.existsSync(source) && !io.existsSync(target)) io.copyFileSync(source, target);
    }
    const obsSource = join(fromDirectory, 'obs-capture');
    const obsTarget = join(toDirectory, 'obs-capture');
    if (io.existsSync(obsSource) && !io.existsSync(obsTarget)) io.cpSync(obsSource, obsTarget, { recursive: true });
  } catch (error) {
    throw new Error(`无法把原有数据复制到运行目录（${error.code ?? '复制失败'}）：${toDirectory}`, { cause: error });
  }
}

function applyRuntimePaths({ app, packaged, execPath, projectDirectory, explicitUserDataDir, io = defaultIo }) {
  const layout = runtimeLayout({
    packaged, execPath, projectDirectory, explicitUserDataDir, appName: app.getName(),
    legacyRoot: explicitUserDataDir == null ? app.getPath('appData') : undefined,
  });
  for (const directory of [layout.userData, layout.crashDumps, layout.logs, layout.updaterCachePath]) {
    ensureWritableDirectory(directory, io);
  }
  app.setPath('userData', layout.userData);
  app.setPath('sessionData', layout.sessionData);
  app.setPath('crashDumps', layout.crashDumps);
  app.setAppLogsPath(layout.logs);
  migrateOwnedData(layout.legacyUserData, layout.userData, io);
  return layout;
}

module.exports = { OWNED_FILES, applyRuntimePaths, migrateOwnedData, runtimeLayout };

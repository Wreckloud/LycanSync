const { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const defaultIo = { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
const MIGRATION_COMPLETE = '.legacy-migration-complete';
const ENCRYPTED_FILES = ['session.bin', 'pending-access.bin'];
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
  if (packaged && explicit) {
    const fromInstallation = relative(dirname(resolve(execPath)), explicit);
    if (fromInstallation === '..' || fromInstallation.startsWith(`..${sep}`) || isAbsolute(fromInstallation)) {
      throw new Error('安装版的数据目录必须位于所选安装目录内。');
    }
  }
  const userData = explicit ?? (packaged ? join(dirname(execPath), 'data') : join(projectDirectory, 'data', 'desktop'));
  return {
    userData,
    sessionData: userData,
    crashDumps: join(userData, 'crashDumps'),
    logs: join(userData, 'logs'),
    temp: join(userData, 'tmp'),
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
  if (!fromDirectory || !toDirectory || sameDirectory(fromDirectory, toDirectory)
      || io.existsSync(join(toDirectory, MIGRATION_COMPLETE))) return;
  try {
    if (!io.existsSync(fromDirectory)) {
      io.writeFileSync(join(toDirectory, MIGRATION_COMPLETE), '');
      return;
    }
    const oldStateFile = join(fromDirectory, 'Local State');
    const newStateFile = join(toDirectory, 'Local State');
    const oldEncrypted = ENCRYPTED_FILES.filter(name => io.existsSync(join(fromDirectory, name)));
    const newEncrypted = ENCRYPTED_FILES.filter(name => io.existsSync(join(toDirectory, name)));
    const copiedEncrypted = newEncrypted.length > 0 && newEncrypted.every(name =>
      io.existsSync(join(fromDirectory, name))
      && io.readFileSync(join(fromDirectory, name)).equals(io.readFileSync(join(toDirectory, name))));
    if (process.platform === 'win32' && oldEncrypted.length && (!newEncrypted.length || copiedEncrypted)) {
      if (!io.existsSync(oldStateFile)) throw new Error('旧凭据缺少配套的加密状态，请保留原目录以便恢复。');
      let oldState, newState;
      try {
        oldState = JSON.parse(io.readFileSync(oldStateFile, 'utf8'));
        newState = io.existsSync(newStateFile) ? JSON.parse(io.readFileSync(newStateFile, 'utf8')) : {};
      } catch { throw new Error('登录加密状态无法解析，请保留原文件以便恢复。'); }
      if (!oldState || !newState || typeof oldState !== 'object' || typeof newState !== 'object'
          || Array.isArray(oldState) || Array.isArray(newState)) {
        throw new Error('登录加密状态格式无效，请保留原文件以便恢复。');
      }
      if (typeof oldState.os_crypt?.encrypted_key !== 'string' || !oldState.os_crypt.encrypted_key) {
        throw new Error('旧凭据缺少配套的加密密钥，请保留原目录以便恢复。');
      }
      if (newState.os_crypt?.encrypted_key !== oldState.os_crypt.encrypted_key) {
        // 只修复仍是旧密文的误迁移；新账号或新邀请依赖的新密钥不能被覆盖。
        if (io.existsSync(newStateFile)) {
          const backup = join(toDirectory, 'Local State.before-legacy-migration');
          if (!io.existsSync(backup)) io.copyFileSync(newStateFile, backup);
        }
        const temporary = join(toDirectory, 'Local State.legacy-migration');
        io.writeFileSync(temporary, JSON.stringify({ ...newState,
          os_crypt: { ...newState.os_crypt, encrypted_key: oldState.os_crypt.encrypted_key } }));
        io.renameSync(temporary, newStateFile);
      }
    }
    for (const name of OWNED_FILES) {
      const source = join(fromDirectory, name);
      const target = join(toDirectory, name);
      // 已有独立加密状态时不混入另一份旧密文；保留当前账号和邀请。
      if ((ENCRYPTED_FILES.includes(name) || name === 'server-config.json') && newEncrypted.length && !copiedEncrypted) continue;
      if (io.existsSync(source) && !io.existsSync(target)) io.copyFileSync(source, target);
    }
    for (const name of ['obs-capture', 'Local Storage']) {
      const source = join(fromDirectory, name), target = join(toDirectory, name);
      if (!io.existsSync(source) || io.existsSync(target)) continue;
      const temporary = join(toDirectory, `.${name}.legacy-migration`);
      io.cpSync(source, temporary, { recursive: true });
      io.renameSync(temporary, target);
    }
    // 退出登录后不能再次从旧目录捡回凭据，也不再持续读取安装目录外的旧配置。
    io.writeFileSync(join(toDirectory, MIGRATION_COMPLETE), '');
  } catch (error) {
    throw new Error(`无法把原有数据复制到运行目录（${error.code ?? error.message ?? '复制失败'}）：${toDirectory}`, { cause: error });
  }
}

function applyRuntimePaths({ app, packaged, execPath, projectDirectory, explicitUserDataDir, environment, io = defaultIo }) {
  const layout = runtimeLayout({
    packaged, execPath, projectDirectory, explicitUserDataDir, appName: app.getName(),
    legacyRoot: explicitUserDataDir == null ? app.getPath('appData') : undefined,
  });
  for (const directory of [layout.userData, layout.crashDumps, layout.logs, layout.temp, layout.updaterCachePath]) {
    ensureWritableDirectory(directory, io);
  }
  app.setPath('userData', layout.userData);
  app.setPath('sessionData', layout.sessionData);
  app.setPath('crashDumps', layout.crashDumps);
  app.setPath('temp', layout.temp);
  app.setAppLogsPath(layout.logs);
  // 原生子进程按环境变量寻找临时目录；仅修改本进程环境，不改系统设置。
  if (environment) {
    environment.TEMP = layout.temp;
    environment.TMP = layout.temp;
    environment.TMPDIR = layout.temp;
  }
  migrateOwnedData(layout.legacyUserData, layout.userData, io);
  return layout;
}

module.exports = { OWNED_FILES, applyRuntimePaths, migrateOwnedData, runtimeLayout };

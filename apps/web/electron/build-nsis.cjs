const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const APPLICATION_FILES = [
  'LycanSync.exe', 'Uninstall LycanSync.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat',
  'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'version', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
];
const APPLICATION_DIRECTORIES = ['locales', 'resources'];

function applicationEntries(appDirectory) {
  const known = new Set([...APPLICATION_FILES, ...APPLICATION_DIRECTORIES]);
  for (const entry of readdirSync(appDirectory, { withFileTypes: true })) {
    if (!known.has(entry.name) || entry.isSymbolicLink()
        || entry.isDirectory() !== APPLICATION_DIRECTORIES.includes(entry.name)) {
      throw new Error(`安装包包含未声明的程序路径：${entry.name}`);
    }
  }
  const lines = [...APPLICATION_FILES.map(name => `  !insertmacro \${ACTION} "${name}" file`),
    ...APPLICATION_DIRECTORIES.map(name => `  !insertmacro \${ACTION} "${name}" directory`)];
  return `!macro LycanApplicationEntries ACTION\n${lines.join('\n')}\n!macroend\n`;
}

function upgradeInstallerScript(script) {
  const anchor = '  !include "installUtil.nsh"';
  const installSection = '!include "installSection.nsh"';
  const silentElevation = '${if} $hasPerMachineInstallation == "1" # set in onInit by initMultiUser';
  if (script.split(anchor).length !== 2 || script.split(installSection).length !== 2
      || script.split(silentElevation).length !== 2) {
    throw new Error('固定 NSIS 安装模板已变化，拒绝生成未经核验的升级流程。');
  }
  // 两种安装并存时按本次实际范围提权，不能仅凭历史全用户记录切回旧目录。
  return script.replace(anchor, '  !include "${BUILD_RESOURCES_DIR}\\installer-util.nsh"\n  !include "${BUILD_RESOURCES_DIR}\\installer-upgrade.nsh"')
    .replace(installSection, '!include "${BUILD_RESOURCES_DIR}\\installer-section.nsh"')
    .replace(silentElevation, '${if} $installMode == "all"');
}

function upgradeInstallerSection(script) {
  const desktopShortcut = '!insertmacro addDesktopLink $keepShortcuts';
  const payload = '!include installer.nsh';
  if (script.split(desktopShortcut).length !== 2 || script.split(payload).length !== 2) {
    throw new Error('固定 NSIS 安装内容或快捷方式入口已变化，拒绝生成安装包。');
  }
  // 默认与静默升级仍由构建器处理，只在用户取消本次创建时跳过。
  return script.replace(desktopShortcut, '${If} $lycanDesktopShortcut != "0"\n  '
    + desktopShortcut + '\n${EndIf}')
    .replace(payload, '!include "${BUILD_RESOURCES_DIR}\\installer-payload.nsh"');
}

function upgradeInstallerPayload(script) {
  const cacheCopy = '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (script.split(cacheCopy).length !== 2) throw new Error('固定 NSIS 更新缓存入口已变化，拒绝生成安装包。');
  // 与 startup-update 的 baseCachePath 对齐，否则每轮都缺少差量下载所需的旧安装包。
  // 手动安装可能跨过已下载的版本；清掉旧块表，下轮从服务器取与当前版本匹配的块表。
  return script.replace(cacheCopy, '!insertmacro copyFile "$EXEPATH" "$INSTDIR\\data\\updater\\${APP_INSTALLER_STORE_FILE}"\n'
    + '      ${IfNot} ${Errors}\n        Delete "$R5\\current.blockmap"\n      ${EndIf}');
}

function upgradeInstallerUtilities(script) {
  const oldUninstall = /^Function uninstallOldVersion\r?\n[\s\S]*?^FunctionEnd/gm;
  if ([...script.matchAll(oldUninstall)].length !== 1) throw new Error('固定 NSIS 旧卸载入口已变化，拒绝生成安装包。');
  return script.replace(oldUninstall, 'Function uninstallOldVersion\n  Call PrepareApplicationReplacement\nFunctionEnd');
}

async function buildInstaller() {
  if (require('app-builder-lib/package.json').version !== '26.15.3') throw new Error('请先核验新构建器的 NSIS 接入点。');
  const { build, Platform, Arch } = require('electron-builder');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const original = NsisTarget.prototype.computeFinalScript;
  // 固定构建期接点只在内存生效，不改依赖文件，也不启用会跳过标准保护的自定义主脚本。
  NsisTarget.prototype.computeFinalScript = function (script, isInstaller, architectures) {
    return original.call(this, isInstaller ? upgradeInstallerScript(script) : script, isInstaller, architectures);
  };
  try {
    await build({ projectDir: resolve(__dirname, '..'), config: require('../electron-builder.cjs'),
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never' });
  } finally { NsisTarget.prototype.computeFinalScript = original; }
}

function prepareInstallerFiles(appDirectory, resourcesDirectory) {
  writeFileSync(join(resourcesDirectory, 'installer-files.nsh'), applicationEntries(appDirectory));
  writeFileSync(join(resourcesDirectory, 'installer-upgrade.nsh'), readFileSync(join(__dirname, 'installer-upgrade.nsh')));
  const builderRoot = resolve(require.resolve('app-builder-lib/package.json'), '..');
  writeFileSync(join(resourcesDirectory, 'installer-util.nsh'), upgradeInstallerUtilities(
    readFileSync(join(builderRoot, 'templates/nsis/include/installUtil.nsh'), 'utf8')));
  writeFileSync(join(resourcesDirectory, 'installer-section.nsh'), upgradeInstallerSection(
    readFileSync(join(builderRoot, 'templates/nsis/installSection.nsh'), 'utf8')));
  writeFileSync(join(resourcesDirectory, 'installer-payload.nsh'), upgradeInstallerPayload(
    readFileSync(join(builderRoot, 'templates/nsis/include/installer.nsh'), 'utf8')));
}

module.exports = { applicationEntries, upgradeInstallerScript, upgradeInstallerUtilities, upgradeInstallerSection,
  upgradeInstallerPayload, prepareInstallerFiles };
if (require.main === module) buildInstaller().catch(error => { console.error(error); process.exitCode = 1; });

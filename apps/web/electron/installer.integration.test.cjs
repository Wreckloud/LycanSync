const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { applicationEntries, upgradeInstallerUtilities, upgradeInstallerScript, upgradeInstallerPayload } = require('./build-nsis.cjs');

const root = resolve(__dirname, '../../..');
mkdirSync(join(root, 'release/diagnostics'), { recursive: true });
const templates = resolve(require.resolve('app-builder-lib/package.json'), '../templates/nsis');
const utilities = readFileSync(join(templates, 'include/installUtil.nsh'), 'utf8');

test('真实 NSIS 隔离安装：继承唯一旧安装范围，升级、回退及卸载均保留 data', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(root, 'release/diagnostics/installer-regression-'));
  const nsisDirectory = join(root, 'release/build-cache/nsis-3.0.4.1');
  assert.ok(existsSync(nsisDirectory), '请先完成桌面打包以准备固定 NSIS 缓存，再运行隔离安装回归。');
  const toolset = join(nsisDirectory, readdirSync(nsisDirectory).find(name => name.startsWith('nsis-3.0.4.1-')));
  const compiler = join(toolset, 'Bin/makensis.exe');
  const empty = join(directory, 'empty'); mkdirSync(empty);
  writeFileSync(join(directory, 'installer-files.nsh'), applicationEntries(empty));
  writeFileSync(join(directory, 'installer-util.nsh'), upgradeInstallerUtilities(utilities));
  function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NSISDIR: toolset }, ...options });
    if (result.error) throw result.error;
    return result;
  }
  // 执行实际宏及固定构建器的接入条件，不写注册表或触碰真实安装。
  const installerSource = readFileSync(join(__dirname, 'installer.nsh'), 'utf8');
  const modeMacro = installerSource.match(/^  !macro customInstallMode\r?\n[\s\S]*?^  !macroend/m)?.[0];
  const modeUi = readFileSync(join(templates, 'multiUserUi.nsh'), 'utf8');
  const modeHook = modeUi.match(/!ifmacrodef customInstallmode\r?\n\s*!insertmacro customInstallMode\r?\n\s*!endif/)?.[0];
  assert.ok(modeMacro && modeHook, '固定 NSIS 安装范围接入点已变化');
  const modeExecutable = join(directory, 'install-mode.exe');
  const modeResults = join(directory, 'install-mode.txt');
  const modeSource = join(directory, 'install-mode.nsi');
  writeFileSync(modeSource, `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${modeExecutable}"
!include LogicLib.nsh
Var hasPerUserInstallation
Var hasPerMachineInstallation
Var isForceCurrentInstall
Var isForceMachineInstall
${modeMacro}
Section
  FileOpen $0 "${modeResults}" w
${[[0, 0], [1, 0], [0, 1], [1, 1]].map(([user, machine]) => `
  StrCpy $hasPerUserInstallation "${user}"
  StrCpy $hasPerMachineInstallation "${machine}"
  StrCpy $isForceCurrentInstall "0"
  StrCpy $isForceMachineInstall "0"
  ${modeHook}
  FileWrite $0 "$isForceCurrentInstall,$isForceMachineInstall$\\r$\\n"
`).join('')}
  FileClose $0
SectionEnd
`);
  const modeBuild = run(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', modeSource]);
  assert.equal(modeBuild.status, 0, modeBuild.stdout + modeBuild.stderr);
  assert.equal(run(modeExecutable, []).status, 0);
  assert.equal(readFileSync(modeResults, 'utf8').replaceAll('\r\n', '\n'), '0,0\n1,0\n0,1\n0,0\n');

  // 执行正式静默分支，仅把真正提权替换为记录；不触发 UAC 或写系统安装记录。
  const patchedScript = upgradeInstallerScript(readFileSync(join(templates, 'installer.nsi'), 'utf8'));
  const elevationBranch = patchedScript.slice(patchedScript.indexOf('    # If we\'re running a silent upgrade'),
    patchedScript.indexOf('    !include "${BUILD_RESOURCES_DIR}\\installer-section.nsh"'))
    .replaceAll('${UAC_IsAdmin}', '${Errors}');
  assert.ok(elevationBranch.includes('!insertmacro UAC_RunElevated'));
  const payload = upgradeInstallerPayload(readFileSync(join(templates, 'include/installer.nsh'), 'utf8'));
  const cacheCopy = payload.match(/^\s*!insertmacro copyFile "\$EXEPATH"[^\r\n]*\r?\n\s*\$\{IfNot\} \$\{Errors\}[\s\S]*?\$\{EndIf\}/m)?.[0];
  const copyMacro = utilities.match(/^!macro copyFile FROM TO\r?\n[\s\S]*?^!macroend/m)?.[0];
  assert.ok(cacheCopy && copyMacro);
  const resources = join(root, 'release/build-cache/nsis-resources-3.4.1');
  const plugins = join(resources, readdirSync(resources).find(name => name.startsWith('nsis-resources-3.4.1-')), 'plugins/x86-unicode');
  const scopeExecutable = join(directory, 'silent-scope.exe');
  const scopeResults = join(directory, 'silent-scope.txt');
  const scopeSource = join(directory, 'silent-scope.nsi');
  writeFileSync(scopeSource, `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${scopeExecutable}"
!include LogicLib.nsh
!include FileFunc.nsh
!addplugindir "${plugins}"
!include "${join(templates, 'include/StdUtils.nsh')}"
!define APP_INSTALLER_STORE_FILE "@lycan-syncweb-updater\\installer.exe"
Var installMode
Var hasPerMachineInstallation
!macro UAC_RunElevated
  FileWrite $9 "elevated"
  FileClose $9
  StrCpy $0 0
  SetErrorLevel 0
!macroend
!macro setInstallModePerAllUsers
  FileWrite $9 "all-users"
!macroend
${copyMacro}
Section
  StrCpy $INSTDIR "${directory}"
  ${cacheCopy}
  \${GetParameters} $R0
  \${GetOptions} $R0 "/scope=" $installMode
  \${GetOptions} $R0 "/machine=" $hasPerMachineInstallation
  FileOpen $9 "${scopeResults}" w
  ClearErrors
${elevationBranch}
  FileWrite $9 "current-user"
  FileClose $9
SectionEnd
`);
  const scopeBuild = run(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', scopeSource]);
  assert.equal(scopeBuild.status, 0, scopeBuild.stdout + scopeBuild.stderr);
  for (const [scope, machine, expected] of [
    ['CurrentUser', '0', 'current-user'], ['CurrentUser', '1', 'current-user'], ['all', '1', 'elevated'],
  ]) {
    const cacheDirectory = join(directory, 'data/updater/@lycan-syncweb-updater');
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(join(cacheDirectory, 'current.blockmap'), 'stale-blockmap');
    assert.equal(run(scopeExecutable, [`/scope=${scope}`, `/machine=${machine}`]).status, 0);
    assert.equal(readFileSync(scopeResults, 'utf8'), expected);
    assert.deepEqual(readFileSync(join(directory, 'data/updater/@lycan-syncweb-updater/installer.exe')),
      readFileSync(scopeExecutable), '已安装版本必须可作为更新器下一轮差量下载的基底');
    assert.ok(!existsSync(join(cacheDirectory, 'current.blockmap')), '手动安装不能沿用其他版本的块表');
  }

  function compile(mode) {
    const executable = join(directory, `${mode}.exe`);
    const script = `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
!define BUILD_UNINSTALLER
!define BUILD_RESOURCES_DIR "${directory}"
!define APP_EXECUTABLE_FILENAME "LycanSync.exe"
!define INSTALL_REGISTRY_KEY "Software\\LycanSyncInstallerRegressionNeverRegistered"
!define UNINSTALL_REGISTRY_KEY "Software\\LycanSyncInstallerRegressionNeverRegistered"
!include "${join(__dirname, 'installer.nsh')}"
!include "${join(directory, 'installer-util.nsh')}"
!include "${join(__dirname, 'installer-upgrade.nsh')}"
Function EnsureVisualCppRuntime
FunctionEnd
Section
${mode === 'protected' ? '  StrCpy $INSTDIR "$PROGRAMFILES64\\LycanSync"\n  Call EnsureUserInstallLocation\n  Return' : ''}
  SetOutPath $INSTDIR
${mode === 'uninstall' ? '  !insertmacro customRemoveFiles' : `  !insertmacro uninstallOldVersion SHELL_CONTEXT
  !insertmacro handleUninstallResult SHELL_CONTEXT
  FileOpen $0 "$INSTDIR\\LycanSync.exe" w
  FileWrite $0 "new-application"
  FileClose $0
  FileOpen $0 "$INSTDIR\\version" w
  FileWrite $0 "new-version"
  FileClose $0
  CreateDirectory "$INSTDIR\\resources"
  FileOpen $0 "$INSTDIR\\resources\\new-package.txt" w
  FileWrite $0 "new-package"
  FileClose $0
${mode === 'abort' ? '  Abort' : mode === 'quit' ? '  SetErrorLevel 2\n  Quit' : '  Call FinishApplicationReplacement'}`}
SectionEnd
`;
    const source = join(directory, `${mode}.nsi`); writeFileSync(source, script);
    const result = run(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', source]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return executable;
  }
  assert.notEqual(run(compile('protected'), []).status, 0, '系统目录必须在文件操作前拒绝');
  const upgrade = compile('upgrade'); const abort = compile('abort'); const quit = compile('quit'); const uninstall = compile('uninstall');
  function fixture(name, installer) {
    const path = join(directory, name); mkdirSync(join(path, 'resources'), { recursive: true });
    mkdirSync(join(path, 'locales'));
    mkdirSync(join(path, 'data/updater/pending'), { recursive: true });
    writeFileSync(join(path, 'LycanSync.exe'), 'old-application');
    writeFileSync(join(path, 'ffmpeg.dll'), 'old-library');
    writeFileSync(join(path, 'Uninstall LycanSync.exe'), 'legacy-uninstaller-must-not-run');
    writeFileSync(join(path, 'resources/old-package.txt'), 'old-package');
    writeFileSync(join(path, 'data/session.bin'), 'synthetic-credential');
    writeFileSync(join(path, 'data/Local State'), 'synthetic-key');
    writeFileSync(join(path, 'user-note.txt'), 'not-owned');
    cpSync(installer, join(path, 'data/updater/pending/installer.exe'));
    return path;
  }
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  function dataHashes(path) {
    return Object.fromEntries(['data/session.bin', 'data/Local State', 'data/updater/pending/installer.exe', 'user-note.txt']
      .map(name => [name, digest(join(path, name))]));
  }
  function runWhileLocked(path, executable, installation) {
    assert.ok(path.startsWith(directory + '\\'));
    const quote = value => value.replaceAll("'", "''");
    const command = `$stream = [IO.File]::Open('${quote(path)}', 'Open', 'Read', 'Read'); try { $p = Start-Process -FilePath '${quote(executable)}' -ArgumentList '/D=${quote(installation)}' -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } finally { $stream.Dispose() }`;
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  }
  const success = fixture('success', upgrade); const original = dataHashes(success);
  assert.equal(run(join(success, 'data/updater/pending/installer.exe'), [`/D=${success}`]).status, 0);
  assert.equal(readFileSync(join(success, 'LycanSync.exe'), 'utf8'), 'new-application');
  assert.ok(!existsSync(join(success, 'resources/old-package.txt')));
  assert.ok(!existsSync(join(success, '.lycan-update-backup')));
  assert.deepEqual(dataHashes(success), original);
  assert.equal(run(uninstall, [`/D=${success}`]).status, 0);
  assert.ok(!existsSync(join(success, 'LycanSync.exe')));
  assert.ok(!existsSync(join(success, 'resources')));
  assert.deepEqual(dataHashes(success), original);

  const interrupted = fixture('interrupted', abort); const interruptedData = dataHashes(interrupted);
  assert.notEqual(run(join(interrupted, 'data/updater/pending/installer.exe'), [`/D=${interrupted}`]).status, 0);
  assert.equal(readFileSync(join(interrupted, 'LycanSync.exe'), 'utf8'), 'old-application');
  assert.ok(existsSync(join(interrupted, 'resources/old-package.txt')));
  assert.ok(existsSync(join(interrupted, 'locales')));
  assert.ok(!existsSync(join(interrupted, 'version')));
  assert.deepEqual(dataHashes(interrupted), interruptedData);

  const terminated = fixture('terminated', quit); const terminatedData = dataHashes(terminated);
  assert.notEqual(run(join(terminated, 'data/updater/pending/installer.exe'), [`/D=${terminated}`]).status, 0);
  assert.deepEqual(dataHashes(terminated), terminatedData);

  const partial = fixture('partial-restore', quit); const partialData = dataHashes(partial);
  assert.notEqual(run(join(partial, 'data/updater/pending/installer.exe'), [`/D=${partial}`]).status, 0);
  assert.notEqual(runWhileLocked(join(partial, 'LycanSync.exe'), upgrade, partial).status, 0);
  assert.equal(readFileSync(join(partial, '.lycan-update-backup/LycanSync.exe'), 'utf8'), 'old-application');
  assert.equal(readFileSync(join(partial, '.lycan-update-backup/ffmpeg.dll'), 'utf8'), 'old-library');
  assert.equal(run(upgrade, [`/D=${partial}`]).status, 0);
  assert.deepEqual(dataHashes(partial), partialData);
  assert.equal(readFileSync(join(terminated, '.lycan-update-backup/state'), 'utf8'), 'staged');
  assert.equal(readFileSync(join(terminated, '.lycan-update-backup/LycanSync.exe'), 'utf8'), 'old-application');
  assert.equal(run(upgrade, [`/D=${terminated}`]).status, 0);
  assert.equal(readFileSync(join(terminated, 'LycanSync.exe'), 'utf8'), 'new-application');
  assert.ok(!existsSync(join(terminated, '.lycan-update-backup')));
  assert.deepEqual(dataHashes(terminated), terminatedData);

  const locked = fixture('locked', upgrade); const lockedData = dataHashes(locked);
  assert.notEqual(runWhileLocked(join(locked, 'ffmpeg.dll'), join(locked, 'data/updater/pending/installer.exe'), locked).status, 0);
  assert.equal(readFileSync(join(locked, 'LycanSync.exe'), 'utf8'), 'old-application');
  assert.equal(readFileSync(join(locked, 'ffmpeg.dll'), 'utf8'), 'old-library');
  assert.deepEqual(dataHashes(locked), lockedData);
  assert.ok(!existsSync(join(locked, '.lycan-update-backup')));
});

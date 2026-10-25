const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { applicationEntries, upgradeInstallerUtilities } = require('./build-nsis.cjs');

const root = resolve(__dirname, '../../..');
mkdirSync(join(root, 'release/diagnostics'), { recursive: true });
const templates = resolve(require.resolve('app-builder-lib/package.json'), '../templates/nsis');
const utilities = readFileSync(join(templates, 'include/installUtil.nsh'), 'utf8');

test('真实 NSIS 隔离升级：数据内运行、文件占用回退、解包中止及卸载均不删除 data', { skip: process.platform !== 'win32' }, () => {
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

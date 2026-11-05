const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve, join, normalize } = require('node:path');
const { writeDesktopLicenses } = require('./package-licenses.cjs');
const { serverUrl } = require('./server-settings.cjs');
const { updateFeedUrl } = require('./startup-update.cjs');
const { prepareVisualCppRuntime } = require('./visual-cpp-runtime.cjs');

const appDirectory = resolve(__dirname, '..');
const projectRoot = resolve(appDirectory, '../..');
const outputDirectory = join(projectRoot, 'release/desktop');
const version = require('../package.json').version;
const obsDirectory = join(projectRoot, 'release/build-cache/obs-32.2.2/prepared');
const obsManifest = JSON.parse(readFileSync(join(obsDirectory, 'build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (obsManifest.obsVersion !== '32.2.2' || obsManifest.architecture !== 'x64'
    || obsManifest.redistributionReady !== true) {
  throw new Error('OBS 正式发布材料尚未核验：需补齐对应源码、构建材料与第三方许可，不能直接发布开发运行包。');
}
for (const file of obsManifest.files) {
  const contents = readFileSync(join(obsDirectory, file.path));
  if (contents.length !== file.bytes || createHash('sha256').update(contents).digest('hex') !== file.sha256) {
    throw new Error(`OBS 文件与构建清单不一致：${file.path}`);
  }
}
const obsSource = obsManifest.sourceBundle;
if (!obsSource || obsSource.version !== version
    || obsSource.path !== `LycanSync-${version}-obs-source.tar.gz`
    || obsSource.runtimeSha256 !== createHash('sha256').update(JSON.stringify(obsManifest.files)).digest('hex')) {
  throw new Error('OBS 对应源码包缺失或与本次版本、运行文件不一致。');
}
const sourceContents = readFileSync(join(outputDirectory, obsSource.path));
if (sourceContents.length !== obsSource.bytes
    || createHash('sha256').update(sourceContents).digest('hex') !== obsSource.sha256) {
  throw new Error('OBS 对应源码包校验失败，拒绝发布安装包。');
}
const runtimeInstaller = process.env.LYCANSYNC_VC_REDIST_PATH || join(
  process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
  'Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/v143/vc_redist.x64.exe',
);
if (!existsSync(runtimeInstaller)) {
  throw new Error('未找到 VC++ x64 运行库安装程序，请用 LYCANSYNC_VC_REDIST_PATH 指定微软原版 vc_redist.x64.exe。');
}
mkdirSync(outputDirectory, { recursive: true });
const buildResources = join(projectRoot, 'release/build-resources');
mkdirSync(buildResources, { recursive: true });
prepareVisualCppRuntime(runtimeInstaller, buildResources);
if (!process.env.LYCANSYNC_PACKAGED_API_URL) throw new Error('请用 LYCANSYNC_PACKAGED_API_URL 指定本包的 HTTPS 服务器地址。');
const apiUrl = serverUrl(process.env.LYCANSYNC_PACKAGED_API_URL);
const updateUrl = updateFeedUrl(process.env.LYCANSYNC_PACKAGED_UPDATE_URL || new URL('/downloads/', apiUrl).href);
writeFileSync(join(buildResources, 'server-config.json'), `${JSON.stringify({ apiUrl }, null, 2)}\n`, 'utf8');
writeDesktopLicenses(join(outputDirectory, 'THIRD-PARTY-NOTICES.txt'));

// 使用 npm 锁定的解压工具，避免每次构建重新从 GitHub 下载 7zip。
const result = spawnSync(process.execPath, [
  join(__dirname, 'build-nsis.cjs'),
], {
  cwd: appDirectory,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_7ZIP_PATH: require('7zip-bin').path7za,
    ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || join(projectRoot, 'release/build-cache'),
  },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const metadata = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:LYCANSYNC_VERIFY_EXECUTABLE); '
  + '[pscustomobject]@{ name=$version.FileDescription; product=$version.ProductName; version=$version.FileVersion } | ConvertTo-Json -Compress'], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, LYCANSYNC_VERIFY_EXECUTABLE: join(outputDirectory, 'win-unpacked/LycanSync.exe') },
});
if (metadata.error || metadata.status !== 0) throw new Error('无法读取安装包主程序的 Windows 产品信息。');
const executable = JSON.parse(metadata.stdout);
if (executable.name !== 'LycanSync' || executable.product !== 'LycanSync' || executable.version !== version) {
  throw new Error('安装包的程序名称或版本资源不正确，拒绝发布。');
}
// 页面依赖已进入 dist；主进程更新库必须实际进入 asar，不能只验证开发目录可用。
const archive = join(outputDirectory, 'win-unpacked/resources/app.asar');
for (const file of ['electron/login-preferences.cjs', 'electron/desktop-tray.cjs', 'electron/media-background.cjs', 'electron/audio-shortcuts.cjs', 'electron/recording-voice.cjs', 'electron/recording.cjs', 'electron/recording-library.cjs', 'electron/obs-audio-host.cjs', 'electron/runtime-paths.cjs', 'electron/startup-update.cjs', 'electron/diagnostic-reports.cjs', 'electron/activity-helper.cjs', 'electron/window-layout.cjs', 'electron/voice-overlay.cjs',
  'electron/voice-overlay-preload.cjs', 'electron/screen-share-windows.cjs', 'electron/viewer-preload.cjs', 'electron/league-capture.cjs', 'electron/qq-login.cjs',
  'dist/overlay.html', 'dist/viewer.html', 'dist/qq-login.png', 'node_modules/electron-updater/package.json',
  'node_modules/builder-util-runtime/package.json']) require('@electron/asar').extractFile(archive, normalize(file));
const packagedIcon = require('@electron/asar').extractFile(archive, normalize('electron/app.ico'));
if (!packagedIcon.equals(readFileSync(join(__dirname, 'app.ico')))) {
  throw new Error('安装包内应用图标与构建资源不一致。');
}
for (const file of obsManifest.files) {
  const contents = readFileSync(join(outputDirectory, 'win-unpacked/resources/obs-capture', file.path));
  if (createHash('sha256').update(contents).digest('hex') !== file.sha256) {
    throw new Error(`安装包内 OBS 文件校验失败：${file.path}`);
  }
}
for (const file of ['latest.yml', `LycanSync-${version}-windows-x64-setup.exe.blockmap`]) {
  if (!existsSync(join(outputDirectory, file))) throw new Error(`构建缺少更新产物：${file}`);
}
writeFileSync(join(outputDirectory, '安装说明.txt'),
  '运行 LycanSync 安装程序即可，运行库由安装程序按需检测安装。\n'
  + `本包默认服务器：${apiUrl}。登录页可修改，选择保存在安装目录的 data 文件夹，升级时保留。\n`
  + `固定更新目录：${updateUrl}。每次打开检查一次，进入应用前自动下载、安装并重新打开；失败可继续使用当前版本。\n`
  + '发布时保留版本化安装包和 blockmap，最后更新 latest.yml；旧版本首次接入自动更新需手动安装此包。\n'
  + '内网测试仍需手动信任服务器的 CA 证书；正式可信 HTTPS 服务无需此步骤。\n'
  + '当前为未签名测试版本，安装和真实设备行为仍需验收。\n', 'utf8');

// 完整打包校验通过后才出具同批分发记录，部署脚本不再依赖当前机器的构建缓存。
const noticesName = `LycanSync-${version}-THIRD-PARTY-NOTICES.txt`;
copyFileSync(join(outputDirectory, 'THIRD-PARTY-NOTICES.txt'), join(outputDirectory, noticesName));
const releaseFiles = [`LycanSync-${version}-windows-x64-setup.exe`,
  `LycanSync-${version}-windows-x64-setup.exe.blockmap`, obsSource.path, noticesName, 'latest.yml'];
const releaseRecord = { schemaVersion: 1, version, obsVersion: obsManifest.obsVersion,
  runtimeSha256: obsSource.runtimeSha256, files: releaseFiles.map(name => {
    const contents = readFileSync(join(outputDirectory, name));
    return { name, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  }) };
writeFileSync(join(outputDirectory, `LycanSync-${version}-release.json`), `${JSON.stringify(releaseRecord, null, 2)}\n`, 'utf8');

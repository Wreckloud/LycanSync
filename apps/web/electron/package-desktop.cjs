const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { writeDesktopLicenses } = require('./package-licenses.cjs');
const { serverUrl } = require('./server-settings.cjs');

const appDirectory = resolve(__dirname, '..');
const projectRoot = resolve(appDirectory, '../..');
const outputDirectory = join(projectRoot, 'release/desktop');
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
copyFileSync(runtimeInstaller, join(buildResources, 'vc_redist.x64.exe'));
if (!process.env.LYCANSYNC_PACKAGED_API_URL) throw new Error('请用 LYCANSYNC_PACKAGED_API_URL 指定本包的 HTTPS 服务器地址。');
const apiUrl = serverUrl(process.env.LYCANSYNC_PACKAGED_API_URL);
writeFileSync(join(buildResources, 'server-config.json'), `${JSON.stringify({ apiUrl }, null, 2)}\n`, 'utf8');
writeDesktopLicenses(join(outputDirectory, 'THIRD-PARTY-NOTICES.txt'));

// 使用 npm 锁定的解压工具，避免每次构建重新从 GitHub 下载 7zip。
const result = spawnSync(process.execPath, [
  require.resolve('electron-builder/cli.js'),
  '--config', 'electron-builder.cjs', '--win', '--x64', '--publish', 'never',
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
writeFileSync(join(outputDirectory, '安装说明.txt'),
  '运行 LycanSync 安装程序即可，运行库由安装程序按需检测安装。\n'
  + `本包默认服务器：${apiUrl}。登录页可修改，用户选择会在升级时保留。\n`
  + '内网测试仍需手动信任服务器的 CA 证书；正式可信 HTTPS 服务无需此步骤。\n'
  + '当前为未签名测试版本，安装和真实设备行为仍需验收。\n', 'utf8');

const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

function writeDesktopLicenses(outputFile) {
  const appDirectory = resolve(__dirname, '..');
  const projectRoot = resolve(appDirectory, '../..');
  const sections = ['LycanSync 第三方组件许可证\nElectron/Chromium 许可证另见安装目录 LICENSE.electron.txt 和 LICENSES.chromium.html。'];
  const included = new Set();

  // OBS 及其运行依赖不能遗漏在 Cargo/npm 许可证清单之外。
  function includeObsLicenses(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) includeObsLicenses(file);
      else if (entry.isFile()) sections.push(`\n===== OBS runtime: ${entry.name} =====\n${readFileSync(file, 'utf8')}`);
    }
  }
  includeObsLicenses(join(projectRoot, 'release/build-cache/obs-32.2.2/prepared/licenses'));

  function includePackage(name, version, license, directory) {
    const identity = `${name}@${version}`;
    if (included.has(identity)) return;
    included.add(identity);
    const licenseFiles = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^(license|copying|notice)([._-]|$)/i.test(entry.name));
    sections.push(`\n===== ${identity} (${license || '未声明'}) =====`);
    for (const file of licenseFiles) {
      sections.push(`\n--- ${file.name} ---\n${readFileSync(join(directory, file.name), 'utf8')}`);
    }
    if (!licenseFiles.length) sections.push('上游发布包未附独立许可证文件，请参照组件声明及上游仓库。');
  }

  // 收集原生静态依赖的声明与随源发布的许可文本，不包含本机路径或源码。
  for (const helper of ['media-helper', 'media-bridge', 'activity-helper']) {
    const result = spawnSync('cargo', ['metadata', '--manifest-path',
      join(projectRoot, 'native', helper, 'Cargo.toml'), '--offline', '--locked',
      '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`无法读取 ${helper} 许可证元数据：${result.stderr}`);
    for (const pkg of JSON.parse(result.stdout).packages) {
      if (pkg.source) includePackage(pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path));
    }
  }

  const lock = JSON.parse(readFileSync(join(appDirectory, 'package-lock.json'), 'utf8'));
  const bundledPackages = new Set();
  // 这些依赖编译进页面，不再作为主进程运行依赖打包，但许可仍需交付。
  function includeBundledPackage(location) {
    if (bundledPackages.has(location)) return;
    const pkg = lock.packages[location];
    if (!pkg) throw new Error(`缺少页面依赖许可元数据：${location}`);
    bundledPackages.add(location);
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      let parent = location;
      while (true) {
        const candidate = `${parent ? `${parent}/` : ''}node_modules/${dependency}`;
        if (lock.packages[candidate]) { includeBundledPackage(candidate); break; }
        if (!parent) throw new Error(`缺少页面依赖许可：${dependency}`);
        parent = parent.slice(0, Math.max(0, parent.lastIndexOf('node_modules/'))).replace(/\/$/, '');
      }
    }
  }
  for (const name of ['@lucide/vue', 'livekit-client', 'vue']) includeBundledPackage(`node_modules/${name}`);
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location || ((pkg.dev || pkg.devOptional) && !bundledPackages.has(location))) continue;
    const directory = join(appDirectory, location);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    includePackage(manifest.name, manifest.version, manifest.license, directory);
  }
  writeFileSync(outputFile, sections.join('\n'), 'utf8');
}

module.exports = { writeDesktopLicenses };

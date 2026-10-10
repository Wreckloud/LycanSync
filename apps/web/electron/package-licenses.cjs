const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

function writeDesktopLicenses(outputFile) {
  const appDirectory = resolve(__dirname, '..');
  const projectRoot = resolve(appDirectory, '../..');
  const sections = ['LycanSync 第三方组件许可证\nElectron/Chromium 许可证另见安装目录 LICENSE.electron.txt 和 LICENSES.chromium.html。'];
  const included = new Set();

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
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location || pkg.dev || pkg.devOptional) continue;
    const directory = join(appDirectory, location);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    includePackage(manifest.name, manifest.version, manifest.license, directory);
  }
  writeFileSync(outputFile, sections.join('\n'), 'utf8');
}

module.exports = { writeDesktopLicenses };

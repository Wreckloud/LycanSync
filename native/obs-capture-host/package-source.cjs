const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve } = require('node:path');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function fileRecord(directory, file) {
  const contents = readFileSync(join(directory, file));
  return { path: file.replaceAll('\\', '/'), bytes: contents.length, sha256: sha256(contents) };
}

function verifyFile(directory, expected) {
  const actual = fileRecord(directory, expected.path);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`OBS 发布文件校验失败：${expected.path}`);
  }
}

function runTar(args) {
  const result = spawnSync('tar.exe', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OBS 源码归档处理失败：${result.stderr}`);
  return result.stdout;
}

function downloadSources(projectRoot) {
  const sourceRoot = join(projectRoot, 'native/obs-capture-host');
  const cache = join(projectRoot, 'release/build-cache/obs-32.2.2');
  const lock = JSON.parse(readFileSync(join(sourceRoot, 'sources.lock.json'), 'utf8'));
  for (const archive of lock.archives) {
    const target = join(cache, archive.path);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      const result = spawnSync('curl.exe', ['--fail', '--location', '--silent', '--show-error',
        '--connect-timeout', '20', '--max-time', '900', '--output', `${target}.download`, archive.url],
      { stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`OBS 对应源码下载失败：${archive.path}`);
      verifyFile(cache, { ...archive, path: `${archive.path}.download` });
      renameSync(`${target}.download`, target);
    }
    verifyFile(cache, archive);
    console.log(`已核验源码材料：${archive.path}`);
  }
}

function prepareSourceBundle(projectRoot) {
  const sourceRoot = join(projectRoot, 'native/obs-capture-host');
  const cache = join(projectRoot, 'release/build-cache/obs-32.2.2');
  const prepared = join(cache, 'prepared');
  const manifestPath = join(prepared, 'build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  // 本次核验失败后不能继续沿用上次打包的发布资格。
  manifest.redistributionReady = false;
  delete manifest.sourceBundle;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.obsVersion !== '32.2.2' || manifest.architecture !== 'x64') {
    throw new Error('OBS 构建版本或架构不符合固定发布范围。');
  }
  for (const file of manifest.files) verifyFile(prepared, file);
  if (!manifest.sourceFiles?.length) throw new Error('OBS 构建缺少自有源码记录，请重新构建。');
  for (const file of manifest.sourceFiles) verifyFile(projectRoot, file);
  const lock = JSON.parse(readFileSync(join(sourceRoot, 'sources.lock.json'), 'utf8'));
  if (lock.obsVersion !== manifest.obsVersion
      || lock.archives.find(archive => archive.name === 'OBS source')?.sha256 !== manifest.sourceSha256) {
    throw new Error('OBS 对应源码与运行包的上游源码不一致。');
  }
  for (const archive of lock.archives) {
    verifyFile(cache, archive);
    runTar(['-tf', join(cache, archive.path)]);
  }
  const version = JSON.parse(readFileSync(join(projectRoot, 'apps/web/package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('OBS 源码包需要明确的应用发布版本。');
  const name = `LycanSync-${version}-obs-source.tar.gz`;
  const output = join(projectRoot, 'release/desktop');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(cache, 'source-package-'));
  try {
    const bundleRoot = join(staging, `LycanSync-${version}-obs-source`);
    mkdirSync(bundleRoot);
    // FFmpeg 的固定构建启用 version3，不能只交付依赖 ZIP 内的 GPL v2 文本。
    const ffmpeg = lock.archives.find(archive => archive.name === 'FFmpeg');
    const gpl3 = runTar(['-xOf', join(cache, ffmpeg.path), `FFmpeg-${ffmpeg.revision}/COPYING.GPLv3`]);
    const notices = {
      'licenses/FFmpeg-COPYING.GPLv3.txt': gpl3,
      'licenses/OBS-SOURCE.txt': `OBS 32.2.2 / LycanSync ${version}\n`
        + `Corresponding source and build materials: ${name}\n`
        + 'Download from the same /downloads/ directory as the versioned installer.\n'
        + 'The host is GPL-2.0-or-later; upstream components retain their own licenses.\n'
        + 'FFmpeg uses its upstream GPL version3 build. See bundled license texts and source.\n'
        + 'This notice does not relicense the rest of LycanSync.\n',
    };
    for (const [file, contents] of Object.entries(notices)) {
      mkdirSync(dirname(join(prepared, file)), { recursive: true });
      writeFileSync(join(prepared, file), contents);
      manifest.files = manifest.files.filter(entry => entry.path !== file);
      manifest.files.push(fileRecord(prepared, file));
    }
    manifest.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    manifest.runtimeBytes = manifest.files.reduce((bytes, file) => bytes + file.bytes, 0);
    const runtimeSha256 = sha256(JSON.stringify(manifest.files));
    const sourceFiles = [];
    function copySources(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) copySources(file);
        else if (entry.isFile()) {
          const target = join(bundleRoot, 'native/obs-capture-host', relative(sourceRoot, file));
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(file, target);
          sourceFiles.push(fileRecord(bundleRoot, relative(bundleRoot, target)));
        } else throw new Error(`OBS 自有源码目录出现非普通文件：${entry.name}`);
      }
    }
    copySources(sourceRoot);
    for (const archive of lock.archives) {
      const target = join(bundleRoot, 'release/build-cache/obs-32.2.2', archive.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(cache, archive.path), target);
    }
    mkdirSync(join(bundleRoot, 'apps/web'), { recursive: true });
    writeFileSync(join(bundleRoot, 'apps/web/package.json'), `${JSON.stringify({ version })}\n`);
    writeFileSync(join(bundleRoot, 'runtime-build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(bundleRoot, 'source-materials.json'), `${JSON.stringify({ version,
      obsVersion: manifest.obsVersion, runtimeSha256, archives: lock.archives, sourceFiles }, null, 2)}\n`);
    copyFileSync(join(sourceRoot, 'SOURCE_BUILD.md'), join(bundleRoot, 'README.md'));
    runTar(['-czf', join(output, `${name}.partial`), '-C', staging, basename(bundleRoot)]);
    runTar(['-tf', join(output, `${name}.partial`)]);
    renameSync(join(output, `${name}.partial`), join(output, name));
    manifest.sourceBundle = { ...fileRecord(output, name), version, runtimeSha256 };
    manifest.redistributionReady = true;
    // 源码归档成功且与当前运行文件绑定后，才写入安装包使用的核验结果。
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`OBS 对应源码包：${name}（${manifest.sourceBundle.bytes} 字节）`);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const projectRoot = resolve(__dirname, '../..');
  if (process.argv.includes('--download')) downloadSources(projectRoot);
  else prepareSourceBundle(projectRoot);
}

module.exports = { prepareSourceBundle };

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const { prepareSourceBundle } = require('./package-source.cjs');

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'lycansync-source-package-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, contents) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  function record(file) {
    const contents = readFileSync(join(root, file));
    return { path: file, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  }
  const cache = 'release/build-cache/obs-32.2.2';
  const native = 'native/obs-capture-host';
  write(`${native}/src/fixture.cpp`, 'controlled source fixture');
  write(`${native}/SOURCE_BUILD.md`, 'controlled rebuild instructions');
  write('apps/web/package.json', JSON.stringify({ version: '0.1.3' }));
  write(`${cache}/prepared/bin/64bit/obs.dll`, 'controlled runtime fixture');
  write('archive/FFmpeg-fixture/COPYING.GPLv3', 'controlled license fixture');
  const archivePath = 'corresponding-source/FFmpeg-fixture.tar.gz';
  mkdirSync(join(root, cache, 'corresponding-source'), { recursive: true });
  const result = spawnSync('tar.exe', ['-czf', join(root, cache, archivePath), '-C', join(root, 'archive'), 'FFmpeg-fixture']);
  assert.equal(result.status, 0);
  const archive = { ...record(`${cache}/${archivePath}`), path: archivePath };
  const lock = { obsVersion: '32.2.2', archives: [
    { ...archive, name: 'OBS source' }, { ...archive, name: 'FFmpeg', revision: 'fixture' },
  ] };
  const manifest = { obsVersion: '32.2.2', architecture: 'x64', redistributionReady: false,
    sourceSha256: archive.sha256,
    sourceFiles: [record(`${native}/src/fixture.cpp`)],
    files: [{ ...record(`${cache}/prepared/bin/64bit/obs.dll`), path: 'bin/64bit/obs.dll' }] };
  function save() {
    write(`${native}/sources.lock.json`, JSON.stringify(lock));
    write(`${cache}/prepared/build-manifest.json`, '\uFEFF' + JSON.stringify(manifest));
  }
  save();
  const current = () => JSON.parse(readFileSync(join(root, cache, 'prepared/build-manifest.json'), 'utf8'));
  return { root, cache, native, archivePath, write, save, manifest, lock, current };
}

test('对应源码缺失或损坏时撤销旧资格，不写成可发布', context => {
  const f = fixture(context);
  f.manifest.redistributionReady = true;
  f.save();
  rmSync(join(f.root, f.cache, f.archivePath));
  assert.throws(() => prepareSourceBundle(f.root), /ENOENT/);
  assert.equal(f.current().redistributionReady, false);
  f.write(`${f.cache}/${f.archivePath}`, 'damaged archive');
  assert.throws(() => prepareSourceBundle(f.root), /发布文件校验失败/);
  assert.equal(f.current().redistributionReady, false);
});

test('构建后源码或运行文件变化时拒绝错配源码包', context => {
  const f = fixture(context);
  f.write(`${f.native}/src/fixture.cpp`, 'changed after build');
  assert.throws(() => prepareSourceBundle(f.root), /发布文件校验失败/);
  f.write(`${f.native}/src/fixture.cpp`, 'controlled source fixture');
  f.write(`${f.cache}/prepared/bin/64bit/obs.dll`, 'changed runtime');
  assert.throws(() => prepareSourceBundle(f.root), /发布文件校验失败/);
});

test('源码归档与上游构建身份不一致时拒绝发布', context => {
  const f = fixture(context);
  f.manifest.sourceSha256 = '0'.repeat(64);
  f.save();
  assert.throws(() => prepareSourceBundle(f.root), /上游源码不一致/);
  assert.equal(f.current().redistributionReady, false);
});

test('真实归档完成后才授予发布资格，并保留构建输入、许可证和版本绑定', context => {
  const f = fixture(context);
  const manifest = prepareSourceBundle(f.root);
  assert.equal(manifest.redistributionReady, true);
  assert.equal(manifest.sourceBundle.version, '0.1.3');
  const contents = readFileSync(join(f.root, 'release/desktop', manifest.sourceBundle.path));
  assert.equal(createHash('sha256').update(contents).digest('hex'), manifest.sourceBundle.sha256);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'), manifest.sourceBundle.runtimeSha256);
  const result = spawnSync('tar.exe', ['-tzf', join(f.root, 'release/desktop', manifest.sourceBundle.path)], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /native\/obs-capture-host\/src\/fixture.cpp/);
  assert.match(result.stdout, /source-materials.json/);
  assert.match(result.stdout, /corresponding-source\/FFmpeg-fixture.tar.gz/);
  assert.ok(manifest.files.some(file => file.path === 'licenses/FFmpeg-COPYING.GPLv3.txt'));
  assert.equal(f.current().redistributionReady, true);
});

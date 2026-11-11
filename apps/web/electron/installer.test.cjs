const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { join, resolve, posix } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const { applicationEntries, upgradeInstallerScript, upgradeInstallerUtilities, upgradeInstallerSection } = require('./build-nsis.cjs');

const root = resolve(__dirname, '../../..');
mkdirSync(join(root, 'release/diagnostics'), { recursive: true });
const templates = resolve(require.resolve('app-builder-lib/package.json'), '../templates/nsis');
const utilities = readFileSync(join(templates, 'include/installUtil.nsh'), 'utf8');

test('打包白名单包含每个主进程模块的本地依赖，避免重构后安装版缺失模块', () => {
  const configPath = resolve(__dirname, '../electron-builder.cjs');
  const scope = { module: { exports: {} }, require: createRequire(configPath), URL,
    process: { env: { LYCANSYNC_PACKAGED_API_URL: 'https://example.invalid' } } };
  runInNewContext(readFileSync(configPath, 'utf8'), scope);
  const files = new Set(scope.module.exports.files);
  for (const file of files) {
    if (!file.endsWith('.cjs')) continue;
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.\.?\/[^'"]+\.cjs)['"]\)/g)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file), match[1]));
      assert.ok(files.has(dependency), `${file} 依赖的 ${dependency} 未进入安装包清单`);
    }
  }
});

test('只替换固定的旧卸载函数，保留标准安装器、签名生成与归档验证入口', () => {
  const source = readFileSync(join(templates, 'installer.nsi'), 'utf8');
  const patched = upgradeInstallerScript(source);
  assert.ok(patched.includes('installer-util.nsh'));
  assert.ok(patched.includes('installer-upgrade.nsh'));
  assert.ok(patched.includes('WriteUninstaller'));
  assert.ok(patched.includes('installer-section.nsh'));
  const replaced = upgradeInstallerUtilities(utilities);
  assert.ok(replaced.includes('Call PrepareApplicationReplacement'));
  assert.ok(!replaced.includes('old-uninstaller.exe'));
  assert.ok(!replaced.includes('ExecWait'));
  assert.ok(replaced.includes('Function handleUninstallResult'));
  assert.throws(() => upgradeInstallerScript('different script'), /模板已变化/);
  assert.throws(() => upgradeInstallerUtilities('different utility'), /入口已变化/);
});

test('桌面勾选只约束现有快捷方式动作，保留构建器升级规则及其他安装步骤', () => {
  const section = readFileSync(join(templates, 'installSection.nsh'), 'utf8');
  const patched = upgradeInstallerSection(section);
  assert.ok(patched.includes('${If} $lycanDesktopShortcut != "0"'));
  assert.ok(patched.includes('!insertmacro addDesktopLink $keepShortcuts'));
  assert.ok(patched.includes('!insertmacro addStartMenuLink $keepShortcuts'));
  assert.ok(patched.includes('!insertmacro registryAddInstallInfo'));
  assert.throws(() => upgradeInstallerSection('changed'), /入口已变化/);
});

test('程序清单明确排除 data、未知路径和链接，SDK 新增文件必须先声明', () => {
  const directory = mkdtempSync(join(root, 'release/diagnostics/installer-inventory-'));
  mkdirSync(join(directory, 'resources')); writeFileSync(join(directory, 'LycanSync.exe'), 'application');
  const inventory = applicationEntries(directory);
  assert.ok(inventory.includes('"resources" directory'));
  assert.ok(!inventory.includes('"data"'));
  mkdirSync(join(directory, 'data'));
  assert.throws(() => applicationEntries(directory), /未声明/);
  const linked = join(directory, 'linked'); mkdirSync(linked);
  symlinkSync(join(directory, 'resources'), join(linked, 'resources'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => applicationEntries(linked), /未声明/);
});

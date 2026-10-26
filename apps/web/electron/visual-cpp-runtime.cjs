const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MINIMUM_RUNTIME_VERSION = '14.44.35211.0';

function validateVisualCppRuntime(details) {
  if (details?.signature !== 'Valid' || !/^CN=Microsoft Corporation(?:,|$)/.test(details.signer ?? '')
      || !/^VC_redist\.x64\.exe$/i.test(details.originalFile ?? '')
      || !/^Microsoft Visual C\+\+ .*Redistributable \(x64\)(?:\s|$)/.test(details.product ?? '')
      || !/^\d{1,5}(?:\.\d{1,5}){3}$/.test(details.version ?? '')) {
    throw new Error('VC++ 安装程序必须具有有效微软签名、x64 产品标识和完整版本号。');
  }
  const version = details.version.split('.').map(Number);
  const minimum = MINIMUM_RUNTIME_VERSION.split('.').map(Number);
  const difference = version.findIndex((value, index) => value !== minimum[index]);
  if (difference >= 0 && version[difference] < minimum[difference]) {
    throw new Error(`VC++ 安装程序低于本包要求的 ${MINIMUM_RUNTIME_VERSION}。`);
  }
  return details.version;
}

// 只在打包时校验微软原版，不启动安装程序，也不给客户端增加联网或检查任务。
function prepareVisualCppRuntime(source, resourcesDirectory) {
  mkdirSync(resourcesDirectory, { recursive: true });
  const temporary = join(resourcesDirectory, 'vc_redist.x64.pending.exe');
  copyFileSync(source, temporary);
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$file = Get-Item -LiteralPath $env:LYCANSYNC_RUNTIME_INSTALLER
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
[pscustomobject]@{ signature = [string]$signature.Status; signer = $signature.SignerCertificate.Subject;
  originalFile = $file.VersionInfo.OriginalFilename; product = $file.VersionInfo.ProductName;
  version = $file.VersionInfo.ProductVersion } | ConvertTo-Json -Compress
`;
  const checked = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LYCANSYNC_RUNTIME_INSTALLER: temporary },
  });
  if (checked.error || checked.status !== 0) {
    throw new Error('无法校验 VC++ 安装程序的微软签名与版本。', {
      cause: checked.error ?? new Error(checked.stderr.trim() || `校验进程返回 ${checked.status}`),
    });
  }
  let details;
  try { details = JSON.parse(checked.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new Error('VC++ 安装程序的校验结果无效。'); }
  const version = validateVisualCppRuntime(details);
  const contents = readFileSync(temporary);
  const manifest = { architecture: 'x64', version, minimumVersion: MINIMUM_RUNTIME_VERSION,
    sha256: createHash('sha256').update(contents).digest('hex'), bytes: contents.length, signature: 'Microsoft Corporation' };
  renameSync(temporary, join(resourcesDirectory, 'vc_redist.x64.exe'));
  writeFileSync(join(resourcesDirectory, 'vc-runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(resourcesDirectory, 'installer-runtime.nsh'),
    `!define LYCAN_BUNDLED_VC_RUNTIME_VERSION "${version}"\n`, 'utf8');
  return manifest;
}

module.exports = { MINIMUM_RUNTIME_VERSION, validateVisualCppRuntime, prepareVisualCppRuntime };

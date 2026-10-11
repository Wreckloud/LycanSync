param([string]$OutputDirectory, [string]$DesktopInstaller)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'release/server' }
$serverJar = Join-Path $projectRoot 'services/api/target/lycan-sync-api-0.0.1-SNAPSHOT.jar'
if (-not (Test-Path -LiteralPath $serverJar)) { throw '请先执行 mvn -f services/api/pom.xml package' }
$bundleDirectory = Join-Path $OutputDirectory 'lycansync-server-0.0.1'
New-Item -ItemType Directory -Force -Path $bundleDirectory | Out-Null
$downloadDirectory = Join-Path $bundleDirectory 'downloads'
New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
if (-not $DesktopInstaller) { throw '请用 -DesktopInstaller 指定本次构建的安装包。' }
$installerPath = (Resolve-Path -LiteralPath $DesktopInstaller).Path
$installerName = Split-Path $installerPath -Leaf
$manifestPath = Join-Path (Split-Path $installerPath -Parent) 'latest.yml'
$blockmapPath = "$installerPath.blockmap"
if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $blockmapPath)) {
    throw '安装包目录缺少 latest.yml 或 blockmap，请使用 package:desktop 完整构建。'
}
# 当前锁定 builder 26.x 生成的单个 NSIS x64 清单；不混用不同批次的安装包和清单。
$manifest = Get-Content -LiteralPath $manifestPath -Raw
$manifestInstaller = [regex]::Match($manifest, '(?m)^path: (.+)\r?$').Groups[1].Value.Trim()
$manifestHash = [regex]::Match($manifest, '(?m)^sha512: (.+)\r?$').Groups[1].Value.Trim()
$installerHash = (Get-FileHash -Algorithm SHA512 -LiteralPath $installerPath).Hash
$hashBytes = for ($offset = 0; $offset -lt $installerHash.Length; $offset += 2) {
    [Convert]::ToByte($installerHash.Substring($offset, 2), 16)
}
if ($manifestInstaller -cne $installerName -or $manifestHash -cne [Convert]::ToBase64String([byte[]]$hashBytes)) {
    throw '更新清单与安装包名称或 SHA-512 不一致，请重新构建后打包。'
}
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $downloadDirectory $installerName) -Force
Copy-Item -LiteralPath $blockmapPath -Destination (Join-Path $downloadDirectory "$installerName.blockmap") -Force
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $downloadDirectory 'LycanSync-setup.exe') -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $downloadDirectory 'latest.yml') -Force
$bundleFiles = @('Dockerfile', 'compose.yaml', 'compose.lan.yaml', 'Caddyfile', 'Caddyfile.lan', '.env.example', '.dockerignore', 'DEPLOY.md')
foreach ($bundleFile in $bundleFiles) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "server/$bundleFile") -Destination $bundleDirectory
}
Copy-Item -LiteralPath $serverJar -Destination (Join-Path $bundleDirectory 'api.jar')
$bundleArchive = Join-Path $OutputDirectory 'lycansync-server-0.0.1.zip'
# 指定文件列表，确保 ZIP 包含 Linux 部署所需的点文件，不带运行时密钥。
$bundleInputs = @($bundleFiles + 'api.jar' + 'downloads') | ForEach-Object { Join-Path $bundleDirectory $_ }
Compress-Archive -LiteralPath $bundleInputs -DestinationPath $bundleArchive -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $bundleArchive

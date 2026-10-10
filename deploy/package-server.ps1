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
if (-not $DesktopInstaller) { throw '请用 -DesktopInstaller 指定支持邀请唤起协议的新安装包。' }
Copy-Item -LiteralPath $DesktopInstaller -Destination (Join-Path $downloadDirectory 'LycanSync-setup.exe')
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

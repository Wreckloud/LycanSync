param([string]$OutputDirectory, [string]$DesktopInstaller)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'release/server' }
$serverJar = Join-Path $projectRoot 'services/api/target/lycan-sync-api-0.0.1-SNAPSHOT.jar'
if (-not (Test-Path -LiteralPath $serverJar)) { throw '请先执行 mvn -f services/api/pom.xml package' }
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
$version = [regex]::Match($manifest, '(?m)^version: ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\r?$').Groups[1].Value
if (-not $version -or $installerName -cne "LycanSync-$version-windows-x64-setup.exe") {
    throw '安装包名称与清单版本不一致，请使用完整构建产物。'
}
$manifestInstaller = [regex]::Match($manifest, '(?m)^path: (.+)\r?$').Groups[1].Value.Trim()
$manifestHash = [regex]::Match($manifest, '(?m)^sha512: (.+)\r?$').Groups[1].Value.Trim()
$installerHash = (Get-FileHash -Algorithm SHA512 -LiteralPath $installerPath).Hash
$hashBytes = for ($offset = 0; $offset -lt $installerHash.Length; $offset += 2) {
    [Convert]::ToByte($installerHash.Substring($offset, 2), 16)
}
if ($manifestInstaller -cne $installerName -or $manifestHash -cne [Convert]::ToBase64String([byte[]]$hashBytes)) {
    throw '更新清单与安装包名称或 SHA-512 不一致，请重新构建后打包。'
}
$installerDirectory = Split-Path $installerPath -Parent
$recordName = "LycanSync-$version-release.json"
$recordPath = Join-Path $installerDirectory $recordName
if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { throw '缺少同版本分发校验记录，请重新完整打包客户端。' }
$recordText = Get-Content -LiteralPath $recordPath -Raw
$record = $recordText | ConvertFrom-Json
$downloadFiles = @($installerName, "$installerName.blockmap", "LycanSync-$version-obs-source.tar.gz",
    "LycanSync-$version-THIRD-PARTY-NOTICES.txt", 'latest.yml')
if ($record.schemaVersion -ne 1 -or $record.version -cne $version -or $record.obsVersion -cne '32.2.2' `
    -or $record.runtimeSha256 -cnotmatch '^[0-9a-f]{64}$' -or @($record.files).Count -ne $downloadFiles.Count) {
    throw '客户端分发记录无效或版本不匹配。'
}
foreach ($name in $downloadFiles) {
    $entries = @($record.files | Where-Object { $_.name -ceq $name })
    $path = Join-Path $installerDirectory $name
    if ($entries.Count -ne 1 -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "分发材料缺失或记录重复：$name"
    }
    $entry = $entries[0]
    if ($entry.bytes -isnot [long] -and $entry.bytes -isnot [int]) { throw "文件大小记录无效：$name" }
    if ($entry.bytes -le 0 -or $entry.bytes -ne (Get-Item -LiteralPath $path).Length `
        -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' `
        -or $entry.sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()) {
        throw "分发材料与构建校验记录不一致：$name"
    }
}
$bundleFiles = @('Dockerfile', 'compose.yaml', 'compose.lan.yaml', 'Caddyfile', 'Caddyfile.lan', '.env.example', '.dockerignore', 'DEPLOY.md', 'maintenance/maintain-releases.py')
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$temporaryName = '.lycansync-server-' + [guid]::NewGuid().ToString('N')
$bundleDirectory = Join-Path $outputRoot $temporaryName
$temporaryArchive = Join-Path $outputRoot "$temporaryName.zip"
$bundleArchive = Join-Path $outputRoot 'lycansync-server-0.0.1.zip'
try {
    $downloadDirectory = Join-Path $bundleDirectory 'downloads'
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    foreach ($name in $downloadFiles) {
        Copy-Item -LiteralPath (Join-Path $installerDirectory $name) -Destination (Join-Path $downloadDirectory $name)
    }
    [IO.File]::WriteAllText((Join-Path $downloadDirectory $recordName), $recordText, [Text.UTF8Encoding]::new($false))
    foreach ($entry in $record.files) {
        $copied = Join-Path $downloadDirectory $entry.name
        if ($entry.bytes -ne (Get-Item -LiteralPath $copied).Length `
            -or $entry.sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $copied).Hash.ToLowerInvariant()) {
            throw "暂存文件与构建记录不符，可能正在重新构建：$($entry.name)"
        }
    }
    Copy-Item -LiteralPath (Join-Path $downloadDirectory $installerName) -Destination (Join-Path $downloadDirectory 'LycanSync-setup.exe')
    Copy-Item -LiteralPath (Join-Path $downloadDirectory "$installerName.blockmap") -Destination (Join-Path $downloadDirectory 'LycanSync-setup.exe.blockmap')
    foreach ($bundleFile in $bundleFiles) {
        $destination = Join-Path $bundleDirectory $bundleFile
        New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "server/$bundleFile") -Destination $destination
    }
    Copy-Item -LiteralPath $serverJar -Destination (Join-Path $bundleDirectory 'api.jar')
    # 只压入明确材料；新包完整生成前不覆盖原部署包，也不读取旧输出目录。
    $downloadEntries = @($downloadFiles + $recordName + 'LycanSync-setup.exe' + 'LycanSync-setup.exe.blockmap') `
        | ForEach-Object { "downloads/$_" }
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($temporaryArchive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        # Windows PowerShell 5.1 默认归档可能使用反斜杠；Linux 部署统一写入 ZIP 标准路径。
        foreach ($name in @($bundleFiles + 'api.jar' + $downloadEntries)) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
                (Join-Path $bundleDirectory $name), $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
    Move-Item -LiteralPath $temporaryArchive -Destination $bundleArchive -Force
    Get-FileHash -Algorithm SHA256 -LiteralPath $bundleArchive
} finally {
    # 仅清理本次在已解析输出目录中创建的随机暂存路径。
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($bundleDirectory)) -ne $outputRoot `
        -or [IO.Path]::GetFileName($bundleDirectory) -ne $temporaryName) { throw '部署暂存目录边界无效，已停止清理。' }
    if (Test-Path -LiteralPath $bundleDirectory) { Remove-Item -LiteralPath $bundleDirectory -Recurse -Force }
    if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
}

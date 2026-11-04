$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $projectRoot ('release/test-cache/server-package-' + [guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $testRoot 'project'
$fixtureDeploy = Join-Path $fixtureRoot 'deploy'
$client = Join-Path $fixtureRoot 'client'
$output = Join-Path $testRoot 'output'
New-Item -ItemType Directory -Force -Path $fixtureDeploy, $client, (Join-Path $fixtureRoot 'services/api/target') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package-server.ps1') -Destination $fixtureDeploy
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'server') -Destination $fixtureDeploy -Recurse
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'services/api/target/lycan-sync-api-0.0.1-SNAPSHOT.jar'), 'synthetic jar; not executed')
$version = '0.2.99'
$installerName = "LycanSync-$version-windows-x64-setup.exe"
$installer = Join-Path $client $installerName
$recordName = "LycanSync-$version-release.json"
$sourceName = "LycanSync-$version-obs-source.tar.gz"
$noticeName = "LycanSync-$version-THIRD-PARTY-NOTICES.txt"
$files = @($installerName, "$installerName.blockmap", $sourceName, $noticeName, 'latest.yml')
$original = @{}
foreach ($name in $files) { $original[$name] = [Text.Encoding]::UTF8.GetBytes("synthetic $name") }
$installerSha = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($original[$installerName]))
$original['latest.yml'] = [Text.Encoding]::UTF8.GetBytes("version: $version`npath: $installerName`nsha512: $installerSha`n")
function Reset-Fixture {
    foreach ($name in $files) { [IO.File]::WriteAllBytes((Join-Path $client $name), $original[$name]) }
    $entries = foreach ($name in $files) {
        $bytes = $original[$name]
        $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
        @{ name = $name; bytes = $bytes.Length; sha256 = ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant() }
    }
    @{ schemaVersion = 1; version = $version; obsVersion = '32.2.2'; runtimeSha256 = ('a' * 64); files = @($entries) } `
        | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $client $recordName) -Encoding utf8
}
function Package-Fixture {
    & (Join-Path $fixtureDeploy 'package-server.ps1') -OutputDirectory $output -DesktopInstaller $installer | Out-Null
}
function Require-Rejected([scriptblock]$Mutation, [string]$Expected) {
    Reset-Fixture
    & $Mutation
    $failed = $false
    try { Package-Fixture } catch {
        $failed = $true
        if ($_.Exception.Message -notlike "*$Expected*") { throw }
    }
    if (-not $failed) { throw "错误输入未拒绝：$Expected" }
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $script:publishedHash) { throw '失败打包覆盖了旧部署包' }
    if (Get-ChildItem -LiteralPath $output -Filter '.lycansync-server-*') { throw '打包失败遗留暂存文件' }
}

Reset-Fixture
Package-Fixture
$archive = Join-Path $output 'lycansync-server-0.0.1.zip'
$script:publishedHash = (Get-FileHash -LiteralPath $archive).Hash
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ('maintenance/maintain-releases.py' -cnotin $names) { throw '部署 ZIP 缺少发布维护工具' }
    if ($zip.Entries | Where-Object { $_.FullName.Contains('\') }) { throw 'ZIP 含非 Linux 目录分隔符' }
    foreach ($name in @($files + $recordName + 'LycanSync-setup.exe' + 'LycanSync-setup.exe.blockmap')) {
        $entry = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -ceq "downloads/$name" }
        if (-not $entry) { throw "部署 ZIP 缺少 $name" }
        if ($original.ContainsKey($name)) {
            $stream = $entry.Open()
            try { $hash = [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($stream)) }
            finally { $stream.Dispose() }
            $expected = [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($original[$name]))
            if ($hash -cne $expected) { throw "ZIP 文件字节不符：$name" }
        }
    }
    foreach ($name in @('.env.example', '.dockerignore', 'api.jar', 'compose.yaml')) {
        if ($names -cnotcontains $name) { throw "ZIP 缺少部署文件：$name" }
    }
} finally { $zip.Dispose() }
Require-Rejected { Remove-Item -LiteralPath (Join-Path $client $sourceName) } '分发材料缺失'
Require-Rejected { [IO.File]::WriteAllText((Join-Path $client $noticeName), 'tampered notice') } '构建校验记录不一致'
Require-Rejected { [IO.File]::WriteAllText("$installer.blockmap", 'tampered blockmap') } '构建校验记录不一致'
Require-Rejected {
    $path = Join-Path $client $sourceName
    $bytes = [IO.File]::ReadAllBytes($path)
    $bytes[0] = $bytes[0] -bxor 1
    [IO.File]::WriteAllBytes($path, $bytes)
} '构建校验记录不一致'
Require-Rejected {
    $path = Join-Path $client $recordName
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $record.version = '0.2.98'
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding utf8
} '版本不匹配'
Require-Rejected {
    $path = Join-Path $client $recordName
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $record.files[1].name = '../outside'
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding utf8
} '分发材料缺失'
Require-Rejected { [IO.File]::WriteAllText($installer, 'wrong installer') } 'SHA-512 不一致'
Require-Rejected { Remove-Item -LiteralPath (Join-Path $client $recordName) } '缺少同版本分发校验记录'
Reset-Fixture
# 旧的解包目录不进入新 ZIP；生成中失败只清理自己创建的随机目录。
New-Item -ItemType Directory -Force -Path (Join-Path $output 'lycansync-server-0.0.1/downloads') | Out-Null
[IO.File]::WriteAllText((Join-Path $output 'lycansync-server-0.0.1/downloads/old-private-file'), 'old output')
Package-Fixture
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try { if ($zip.Entries | Where-Object { $_.FullName -like '*old-private-file*' }) { throw '旧输出混入新 ZIP' } }
finally { $zip.Dispose() }
$script:publishedHash = (Get-FileHash -LiteralPath $archive).Hash
Require-Rejected { Remove-Item -LiteralPath (Join-Path $fixtureDeploy 'server/Caddyfile') } 'Caddyfile'
Write-Output '通过：材料完整与 ZIP 字节、点文件、8 组缺失／损坏／版本／路径拒绝、旧包保留、旧输出隔离及失败清理。未启动应用、设备或容器。'

param([switch]$Offline, [switch]$BuildTestWindows)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
    throw 'OBS 宿主构建仅支持 Windows x64 PowerShell。'
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$cacheDirectory = Join-Path $projectRoot 'release/build-cache/obs-32.2.2'
$downloadDirectory = Join-Path $cacheDirectory 'downloads'
$preparedDirectory = Join-Path $cacheDirectory 'prepared'
New-Item -ItemType Directory -Force -Path $downloadDirectory, $preparedDirectory | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw '需要已有的 Visual Studio C++ Build Tools；本脚本不会安装系统组件。' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $visualStudio) { throw '未找到已有的 x64 C++ Build Tools。' }
$visualStudio = @($visualStudio)[0]
$toolsVersion = (Get-Content (Join-Path $visualStudio.installationPath 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
$toolsDirectory = Join-Path $visualStudio.installationPath "VC/Tools/MSVC/$toolsVersion/bin/Hostx64/x64"
$dumpbin = Join-Path $toolsDirectory 'dumpbin.exe'
$librarian = Join-Path $toolsDirectory 'lib.exe'
$cmake = Join-Path $visualStudio.installationPath 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
foreach ($tool in @($dumpbin, $librarian, $cmake)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "缺少已有构建工具：$tool；不会自动安装。" }
}

function Get-VerifiedArchive([string]$Name, [string]$Sha256, [string]$Url = '') {
    $archive = Join-Path $downloadDirectory $Name
    if (-not (Test-Path -LiteralPath $archive)) {
        if ($Offline) { throw "离线缓存缺少 $Name。" }
        $partialArchive = "$archive.download"
        Write-Host "下载固定版本官方文件：$Name"
        if (-not $Url) { $Url = "https://github.com/obsproject/obs-studio/releases/download/32.2.2/$Name" }
        & curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 900 --retry 2 --continue-at - --output $partialArchive $Url
        if ($LASTEXITCODE -ne 0) { throw "下载失败：$Name；未完成文件仅留在构建缓存。" }
        if ((Get-FileHash -LiteralPath $partialArchive -Algorithm SHA256).Hash -ine $Sha256) {
            throw "官方文件 SHA-256 不匹配：$Name；拒绝解压或使用。"
        }
        Move-Item -LiteralPath $partialArchive -Destination $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $Sha256) {
        throw "缓存 SHA-256 不匹配：$Name；请移走损坏文件后重试。"
    }
    return $archive
}

$sourceHash = 'ec81fb66b03e75ddb3076b576f62679c39262e0e9960cef3e17a40dc5d68e6b4'
$runtimeHash = '4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1'
$sourceArchive = Get-VerifiedArchive 'OBS-Studio-32.2.2-Sources.tar.gz' $sourceHash
$runtimeArchive = Get-VerifiedArchive 'OBS-Studio-32.2.2-Windows-x64.zip' $runtimeHash
$sourceDirectory = Join-Path $cacheDirectory 'source'
$upstreamDirectory = Join-Path $cacheDirectory 'runtime-upstream'
New-Item -ItemType Directory -Force -Path $sourceDirectory, $upstreamDirectory | Out-Null
# 只解压头文件所在目录及许可证，避免无关 Unix 格式化工具的符号链接。
& tar.exe -xzf $sourceArchive -C $sourceDirectory 'obs-studio-32.2.2-sources/libobs' 'obs-studio-32.2.2-sources/COPYING'
if ($LASTEXITCODE -ne 0) { throw '官方源码头文件解压失败。' }
& tar.exe -xf $runtimeArchive -C $upstreamDirectory
if ($LASTEXITCODE -ne 0) { throw '官方运行包解压失败。' }
$libobsSource = Join-Path $sourceDirectory 'obs-studio-32.2.2-sources/libobs'
$gameSourceRoot = Join-Path $sourceDirectory 'obs-studio-32.2.2-sources'
$gameDepsDirectory = Join-Path $cacheDirectory 'game-build-deps'
& tar.exe -xzf $sourceArchive -C $sourceDirectory 'obs-studio-32.2.2-sources/plugins/win-capture' 'obs-studio-32.2.2-sources/plugins/win-wasapi' 'obs-studio-32.2.2-sources/libobs-winrt' 'obs-studio-32.2.2-sources/shared/obs-hook-config' 'obs-studio-32.2.2-sources/shared/obs-inject-library' 'obs-studio-32.2.2-sources/shared/ipc-util' 'obs-studio-32.2.2-sources/shared/file-updater' 'obs-studio-32.2.2-sources/deps/w32-pthreads'
if ($LASTEXITCODE -ne 0) { throw '游戏插件固定源码解压失败。' }
$gameDepsHash = '6f90e9598fa10cff5ad23cdcfae49b87868c07bf896b02cd464582b4ce2f2ba9'
# 哈希与版本来自同一份已校验 OBS 源码归档中的 CMakePresets.json。
$gameDepsArchive = Get-VerifiedArchive 'windows-deps-2026-07-15-x64.zip' $gameDepsHash 'https://github.com/obsproject/obs-deps/releases/download/2026-07-15/windows-deps-2026-07-15-x64.zip'
New-Item -ItemType Directory -Force -Path $gameDepsDirectory | Out-Null
& tar.exe -xf $gameDepsArchive -C $gameDepsDirectory 'include/curl' 'include/jansson.h' 'include/jansson_config.h' 'lib/jansson.lib' 'lib/libcurl_imp.lib' 'licenses'
if ($LASTEXITCODE -ne 0) { throw '游戏插件依赖解压失败。' }
& git -C $projectRoot apply --recount --whitespace=error-all --directory=release/build-cache/obs-32.2.2/source/obs-studio-32.2.2-sources (Join-Path $PSScriptRoot 'patches/bound-game-capture.patch')
if ($LASTEXITCODE -ne 0) { throw '固定游戏插件补丁不适用，拒绝继续构建。' }
& git -C $projectRoot apply --recount --whitespace=error-all --directory=release/build-cache/obs-32.2.2/source/obs-studio-32.2.2-sources (Join-Path $PSScriptRoot 'patches/bound-audio-capture.patch')
if ($LASTEXITCODE -ne 0) { throw '固定声音插件补丁不适用，拒绝继续构建。' }
$includeDirectory = Join-Path $preparedDirectory 'include'
$libraryDirectory = Join-Path $preparedDirectory 'lib'
$binaryDirectory = Join-Path $preparedDirectory 'bin/64bit'
New-Item -ItemType Directory -Force -Path $includeDirectory, $libraryDirectory, $binaryDirectory | Out-Null
foreach ($header in Get-ChildItem -LiteralPath $libobsSource -File -Recurse | Where-Object { $_.Extension -in @('.h', '.hpp') }) {
    $destination = Join-Path $includeDirectory $header.FullName.Substring($libobsSource.Length + 1)
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $header.FullName -Destination $destination -Force
}
Copy-Item -LiteralPath (Join-Path $libobsSource 'obsconfig.h.in') -Destination $includeDirectory -Force

# 仅收集共享来源的运行依赖，不带 UI、浏览器、录制输出或其他插件。
$runtimeFiles = @('obs.dll', 'libobs-d3d11.dll', 'libobs-winrt.dll', 'avcodec-62.dll', 'avformat-62.dll',
    'avutil-60.dll', 'swscale-9.dll', 'swresample-6.dll', 'w32-pthreads.dll', 'zlib.dll',
    'libx264-164.dll', 'librist.dll', 'srt.dll', 'libcurl.dll')
foreach ($runtimeFile in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $upstreamDirectory "bin/64bit/$runtimeFile") -Destination $binaryDirectory -Force
}
$pluginDirectory = Join-Path $preparedDirectory 'obs-plugins/64bit'
$dataDirectory = Join-Path $preparedDirectory 'data'
New-Item -ItemType Directory -Force -Path $pluginDirectory, $dataDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $upstreamDirectory 'data/libobs') -Destination $dataDirectory -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $dataDirectory 'obs-plugins') | Out-Null
$captureDataSource = Join-Path $upstreamDirectory 'data/obs-plugins/win-capture'
foreach ($captureFile in Get-ChildItem -LiteralPath $captureDataSource -File -Recurse | Where-Object { $_.Extension -ne '.pdb' }) {
    $destination = Join-Path $dataDirectory "obs-plugins/win-capture/$($captureFile.FullName.Substring($captureDataSource.Length + 1))"
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $captureFile.FullName -Destination $destination -Force
}
$audioDataSource = Join-Path $upstreamDirectory 'data/obs-plugins/win-wasapi'
foreach ($audioFile in Get-ChildItem -LiteralPath $audioDataSource -File -Recurse | Where-Object { $_.Extension -ne '.pdb' }) {
    $destination = Join-Path $dataDirectory "obs-plugins/win-wasapi/$($audioFile.FullName.Substring($audioDataSource.Length + 1))"
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $audioFile.FullName -Destination $destination -Force
}
$licenseDirectory = Join-Path $preparedDirectory 'licenses'
New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'obs-studio-32.2.2-sources/COPYING') -Destination (Join-Path $licenseDirectory 'OBS-COPYING.txt') -Force
$dependencyLicenses = Join-Path $gameDepsDirectory 'licenses'
foreach ($licenseFile in Get-ChildItem -LiteralPath $dependencyLicenses -File -Recurse) {
    $destination = Join-Path $licenseDirectory "dependencies/$($licenseFile.FullName.Substring($dependencyLicenses.Length + 1))"
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $licenseFile.FullName -Destination $destination -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE.md') -Destination (Join-Path $licenseDirectory 'LycanSync-OBS-LICENSE.md') -Force

$obsDll = Join-Path $binaryDirectory 'obs.dll'
if ((Get-Item -LiteralPath $obsDll).VersionInfo.ProductVersion -cne '32.2.2') { throw '官方 obs.dll 文件版本不匹配。' }
$exports = & $dumpbin /nologo /exports $obsDll
if ($LASTEXITCODE -ne 0) { throw '无法读取官方 obs.dll 导出。' }
$symbols = @($exports | ForEach-Object { if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)') { $Matches[1] } })
if ($symbols.Count -ne 1784) { throw '固定版本 obs.dll 的导出表不符合预期。' }
$definitionPath = Join-Path $libraryDirectory 'obs.def'
@('LIBRARY obs.dll', 'EXPORTS') + $symbols | Set-Content -LiteralPath $definitionPath -Encoding ascii
& $librarian /nologo "/def:$definitionPath" /machine:x64 "/out:$(Join-Path $libraryDirectory 'obs.lib')"
if ($LASTEXITCODE -ne 0) { throw '真实 DLL 导出生成导入库失败。' }
$pthreadExports = & $dumpbin /nologo /exports (Join-Path $binaryDirectory 'w32-pthreads.dll')
if ($LASTEXITCODE -ne 0) { throw '无法读取固定 pthread DLL 导出。' }
$pthreadSymbols = @($pthreadExports | ForEach-Object { if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)') { $Matches[1] } })
if (-not $pthreadSymbols.Count) { throw '固定 pthread DLL 导出为空。' }
$pthreadDefinition = Join-Path $libraryDirectory 'w32-pthreads.def'
@('LIBRARY w32-pthreads.dll', 'EXPORTS') + $pthreadSymbols | Set-Content -LiteralPath $pthreadDefinition -Encoding ascii
& $librarian /nologo "/def:$pthreadDefinition" /machine:x64 "/out:$(Join-Path $libraryDirectory 'w32-pthreads.lib')"
if ($LASTEXITCODE -ne 0) { throw 'pthread 导入库生成失败。' }
Set-Content -LiteralPath (Join-Path $preparedDirectory 'sdk-version.txt') -Value '32.2.2' -Encoding ascii

$buildDirectory = Join-Path $cacheDirectory 'cmake-build'
# vswhere 的 productLineVersion 是年份，生成器主版本来自 installationVersion。
$generator = "Visual Studio $($visualStudio.installationVersion.Split('.')[0]) $($visualStudio.catalog.productLineVersion)"
& $cmake -S $PSScriptRoot -B $buildDirectory -G $generator -A x64 "-DLYCANSYNC_OBS_SDK=$preparedDirectory" "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=$binaryDirectory" "-DLYCANSYNC_OBS_SOURCE=$gameSourceRoot" "-DLYCANSYNC_OBS_DEPS=$gameDepsDirectory"
if ($LASTEXITCODE -ne 0) { throw 'OBS 宿主 CMake 配置失败。' }
& $cmake --build $buildDirectory --config Release --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'OBS 宿主构建失败。' }
if ($BuildTestWindows) {
    & $cmake --build $buildDirectory --config Release --target lycansync-obs-test-windows lycansync-bound-game-target-tests lycansync-bound-audio-target-tests lycansync-screen-audio-pcm-tests lycansync-obs-test-d3d --parallel 2
    if ($LASTEXITCODE -ne 0) { throw '测试色块窗口构建失败。' }
}
$gamePlugin = Join-Path $buildDirectory 'game-plugin/win-capture.dll'
# 开发包只有这一份精确绑定插件，不保留可被默认构建换回的原插件。
Copy-Item -LiteralPath $gamePlugin -Destination (Join-Path $pluginDirectory 'win-capture.dll') -Force
$audioPlugin = Join-Path $buildDirectory 'audio-plugin/win-wasapi.dll'
Copy-Item -LiteralPath $audioPlugin -Destination (Join-Path $pluginDirectory 'win-wasapi.dll') -Force

# 静态检查 DLL 依赖；不加载 OBS、辅助程序或设备。API-set 由 Windows 装载器提供。
$imports = @()
$runtimeBinaries = @(Get-ChildItem -LiteralPath $binaryDirectory -File) + @(Get-Item (Join-Path $pluginDirectory 'win-capture.dll')) + @(Get-Item (Join-Path $pluginDirectory 'win-wasapi.dll'))
foreach ($binary in $runtimeBinaries) {
    $dependencies = & $dumpbin /nologo /dependents $binary.FullName
    if ($LASTEXITCODE -ne 0) { throw "无法静态检查运行依赖：$($binary.Name)" }
    foreach ($line in $dependencies) {
        if ($line -notmatch '^\s+([^\s]+\.dll)\s*$') { continue }
        $dependency = $Matches[1]
        $provided = Test-Path -LiteralPath (Join-Path $binaryDirectory $dependency)
        $systemProvided = $dependency -match '^(api|ext)-ms-' -or (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32/$dependency"))
        if (-not $provided -and -not $systemProvided) { throw "运行依赖缺失：$($binary.Name) → $dependency" }
        $imports += [ordered]@{ binary = $binary.Name; dependency = $dependency; provider = $(if ($provided) { 'bundle' } else { 'windows' }) }
    }
}
[ordered]@{ obsVersion = '32.2.2'; sourceSha256 = $sourceHash; dependencySha256 = $gameDepsHash;
    patchSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'patches/bound-game-capture.patch') -Algorithm SHA256).Hash.ToLowerInvariant();
    binarySha256 = (Get-FileHash -LiteralPath $gamePlugin -Algorithm SHA256).Hash.ToLowerInvariant();
    bytes = (Get-Item -LiteralPath $gamePlugin).Length; importsChecked = $true;
    runtimeExecuted = $false; redistributionReady = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildDirectory 'game-plugin/build-manifest.json') -Encoding utf8
[ordered]@{ obsVersion = '32.2.2'; sourceSha256 = $sourceHash;
    patchSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'patches/bound-audio-capture.patch') -Algorithm SHA256).Hash.ToLowerInvariant();
    binarySha256 = (Get-FileHash -LiteralPath $audioPlugin -Algorithm SHA256).Hash.ToLowerInvariant();
    bytes = (Get-Item -LiteralPath $audioPlugin).Length; importsChecked = $true;
    runtimeExecuted = $false; redistributionReady = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildDirectory 'audio-plugin/build-manifest.json') -Encoding utf8
$files = @(Get-ChildItem -LiteralPath $preparedDirectory -File -Recurse | Where-Object {
    $_.FullName -notmatch '[\\/]include[\\/]|[\\/]lib[\\/]' -and $_.Name -notin @('build-manifest.json', 'sdk-version.txt')
} | Sort-Object FullName | ForEach-Object {
    [pscustomobject][ordered]@{ path = $_.FullName.Substring($preparedDirectory.Length + 1).Replace('\', '/'); bytes = $_.Length;
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$hostSources = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | Where-Object {
    $_.Extension -in @('.cpp', '.hpp', '.c', '.h', '.txt', '.cmake', '.ps1', '.patch')
} | Sort-Object FullName | ForEach-Object {
    [pscustomobject][ordered]@{ path = $_.FullName.Substring($projectRoot.Length + 1).Replace('\', '/'); bytes = $_.Length;
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = [ordered]@{ obsVersion = '32.2.2'; architecture = 'x64'; sourceSha256 = $sourceHash; runtimeSha256 = $runtimeHash;
    sourceUrl = 'https://github.com/obsproject/obs-studio/releases/tag/32.2.2'; sourceArchive = (Split-Path $sourceArchive -Leaf);
    compiler = $toolsVersion; runtimeBytes = ($files | Measure-Object -Property bytes -Sum).Sum;
    runtimeExecuted = $false; redistributionReady = $false; imports = $imports; sourceFiles = $hostSources; files = $files }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $preparedDirectory 'build-manifest.json') -Encoding utf8
Write-Host "构建和静态依赖检查完成（未运行）：$preparedDirectory"
Write-Host "运行文件合计 $($manifest.runtimeBytes) 字节；许可证和对应源码仍需发布前审查。"

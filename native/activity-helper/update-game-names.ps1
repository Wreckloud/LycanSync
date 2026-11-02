param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$cacheDirectory = Join-Path $projectRoot 'release/build-cache/game-names'
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)

function Save-Cache([string]$Path, [object]$Value) {
    $temporary = "$Path.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 12 -Compress), $utf8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

$wikiPath = Join-Path $cacheDirectory 'wikidata.json'
if ($Refresh -or -not (Test-Path -LiteralPath $wikiPath)) {
    $query = 'SELECT ?item ?steam ?name WHERE { ?item wdt:P1733 ?steam; rdfs:label ?name . FILTER(LANG(?name) IN ("zh-hans", "zh-cn", "zh")) }'
    $uri = 'https://query.wikidata.org/sparql?format=json&query=' + [uri]::EscapeDataString($query)
    Write-Host '获取 Wikidata 中文名称与 Steam 标识。'
    $wiki = Invoke-RestMethod -Uri $uri -Headers @{Accept='application/sparql-results+json'; 'User-Agent'='LycanSync-game-catalog/1.0 (offline metadata build)'} -TimeoutSec 60
    if (-not $wiki.results.bindings.Count) { throw 'Wikidata 未返回名称记录，保留原有名称库。' }
    Save-Cache $wikiPath $wiki
}

$snapshot = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'resources/games.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$ids = @($snapshot.games | ForEach-Object { $_.install_keys } | Where-Object { $_ -match '^steam:\d+$' } |
    ForEach-Object { [int]$_.Substring(6) } | Sort-Object -Unique)
if (-not $ids.Count) { throw '现有识别库中没有 Steam 标识。' }
$steamPath = Join-Path $cacheDirectory 'steam.json'
$cached = @{}
if (Test-Path -LiteralPath $steamPath) {
    $saved = Get-Content -LiteralPath $steamPath -Encoding UTF8 -Raw | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $cached[$property.Name] = $property.Value }
}
$pending = @($ids | Where-Object { $Refresh -or -not $cached.ContainsKey([string]$_) })
Write-Host "Steam 名称采集：共 $($ids.Count) 个 AppID，本次查询 $($pending.Count) 个；成功批次会保存，失败后可继续。"
for ($offset = 0; $offset -lt $pending.Count; $offset += 100) {
    $batch = @($pending[$offset..([Math]::Min($offset + 99, $pending.Count - 1))])
    $inputJson = @{ids=@($batch | ForEach-Object { @{appid=$_} }); context=@{language='schinese';country_code='CN'}} | ConvertTo-Json -Depth 5 -Compress
    $uri = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' + [uri]::EscapeDataString($inputJson)
    $response = Invoke-RestMethod -Uri $uri -TimeoutSec 30
    $rows = @($response.response.store_items)
    $seen = @{}
    foreach ($row in $rows) {
        $id = [int]$row.id
        if ($id -notin $batch -or $seen.ContainsKey([string]$id) -or $null -eq $row.success) { throw 'Steam 返回了不属于本批次的条目或无效状态，未替换名称库。' }
        $seen[[string]$id] = $true
        $cached[[string]$id] = @{appid=$id;success=[int]$row.success;name=$row.name}
    }
    if ($seen.Count -ne $batch.Count) { throw 'Steam 名称响应不完整，保留已完成批次，请稍后重试。' }
    Save-Cache $steamPath $cached
    Write-Host "Steam 已查询 $([Math]::Min($offset + 100, $pending.Count))/$($pending.Count)。"
    Start-Sleep -Milliseconds 500
}
& node (Join-Path $PSScriptRoot 'game-names.cjs') $cacheDirectory
if ($LASTEXITCODE -ne 0) { throw '中文名称库生成失败。' }
& node (Join-Path $PSScriptRoot 'update-game-catalog.cjs') --names-only
if ($LASTEXITCODE -ne 0) { throw '识别快照名称更新失败。' }

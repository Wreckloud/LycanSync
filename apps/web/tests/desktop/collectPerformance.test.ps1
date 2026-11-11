$ErrorActionPreference = 'Stop'
$script:mockReadCount = 0
$script:created = [DateTime]::UtcNow.AddMinutes(-1)
function Get-CimInstance([string]$ClassName, [int]$OperationTimeoutSec) {
  if ($ClassName -eq 'Win32_Process') {
    $script:mockReadCount++
    foreach ($pair in @(@(10, 0), @(11, 10), @(20, 0), @(21, 20), @(30, 0), @($PID, 0), @(999, 0))) {
      [pscustomobject]@{ ProcessId = [uint32]$pair[0]; ParentProcessId = [uint32]$pair[1]; CreationDate = $script:created;
        KernelModeTime = $script:mockReadCount * 100000; UserModeTime = $script:mockReadCount * 100000;
        WorkingSetSize = 4096; PrivatePageCount = 8192; ReadTransferCount = 100; WriteTransferCount = 200 }
    }
  } elseif ($ClassName -like '*GPUEngine') {
    foreach ($id in @(10, 20, 999)) { [pscustomobject]@{ Name = "pid_${id}_luid_0x000_eng_0_engtype_VideoEncode"; UtilizationPercentage = 15 } }
  } elseif ($ClassName -like '*GPUProcessMemory') {
    throw '模拟驱动统计不可用'
  } else { [pscustomobject]@{ Name = '_Total'; DiskReadBytesPersec = 200; DiskWriteBytesPersec = 300; CurrentDiskQueueLength = 1 } }
}
$path = Join-Path $PSScriptRoot "../../../../release/test-cache/performance-mock-$([Guid]::NewGuid()).jsonl"
try {
  & "$PSScriptRoot/collectPerformance.ps1" -ClientProcessId 10 -LoadProcessId 20 -ServerProcessId 30 -DurationSeconds 3 -OutputPath $path
  $lines = @(Get-Content -Encoding UTF8 -LiteralPath $path | ForEach-Object { $_ | ConvertFrom-Json })
  $samples = @($lines | Select-Object -Skip 1)
  if ($samples.Count -lt 2) { throw '缺少差分样本' }
  foreach ($sample in $samples) {
    if (@($sample.entries | Where-Object group -eq 'client').Count -ne 2) { throw '客户端树不正确' }
    if (@($sample.entries | Where-Object group -eq 'load').Count -ne 2) { throw '测试端树不正确' }
    if ($sample.entries.Count -ne 6) { throw '混入未指定进程' }
    if ($sample.gpuMemoryState -ne 'unavailable' -or $sample.hostDisk[0].writeBytesPerSecond -ne 300) { throw '缺失与整机数据语义错误' }
  }
  if ($null -ne $samples[0].entries[0].cpuCorePercent -or $samples[1].entries[0].cpuCorePercent -le 0) { throw 'CPU 基线错误' }
  if ((Get-Content -Encoding UTF8 -LiteralPath $path -Raw) -match 'pid_10|pid_20|luid_0x000|commandLine') { throw '泄露内部身份' }
  Write-Output 'PASS: process groups, descendants, missing GPU metrics, CPU baseline, host disk scope, privacy'
} finally { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }

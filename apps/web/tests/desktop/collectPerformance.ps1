param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ClientProcessId,
  [int[]]$LoadProcessId = @(),
  [int[]]$ServerProcessId = @(),
  [ValidateRange(3, 3600)][int]$DurationSeconds = 180,
  [ValidateRange(2, 10)][int]$IntervalSeconds = 2,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$roots = @{ client = @($ClientProcessId); load = $LoadProcessId; server = $ServerProcessId; observer = @($PID) }
$ids = @($roots.Values | ForEach-Object { $_ })
if (@($ids | Select-Object -Unique).Count -ne $ids.Count -or @($ids | Where-Object { $_ -le 0 }).Count) {
  throw '各组必须使用不同且有效的进程 ID。'
}
$known = @{}
$aliases = @{}
$rootStarts = @{}
$engineAliases = @{}
$logicalProcessors = [Environment]::ProcessorCount
$clock = [Diagnostics.Stopwatch]::StartNew()
$previous = @{}
$initial = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
foreach ($group in $roots.Keys) {
  foreach ($processId in $roots[$group]) {
    $item = $initial | Where-Object { $_.ProcessId -eq $processId }
    if (!$item) { throw "测试组 $group 的根进程不存在。" }
    $rootStarts[$processId] = $item.CreationDate.Ticks
  }
}

function Read-Counters([string]$ClassName) {
  try { return @{ state = 'available'; rows = @(Get-CimInstance $ClassName -OperationTimeoutSec 5) } }
  catch { return @{ state = 'unavailable'; rows = @() } }
}

# 独占新文件；只记录指定进程树的数值，不保存 PID、窗口标题、路径或命令行。
$stream = [IO.File]::Open([IO.Path]::GetFullPath($OutputPath), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
$writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
try {
  $writer.WriteLine((@{ kind = 'lycansync-local-performance'; schemaVersion = 1; logicalProcessors = $logicalProcessors;
    intervalSeconds = $IntervalSeconds; scope = 'explicit-process-trees';
    limitations = @('client 与 load/server/observer 分组，整机数据不可归因给客户端',
      'GPU 引擎分项不能直接相加为总占用；显存为驱动报告的进程分配量',
      '进程传输字节包括文件、管道和网络，物理磁盘吞吐只在 hostDisk 中',
      '服务器若运行在 VM 中，server 组只表示指定 VM 进程树；服务内部成本需另采',
      '首次CPU样本和不可用指标为null；CIM采样开销单独计时，脚本不代表压测已经运行') } | ConvertTo-Json -Compress))
  while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $started = $clock.Elapsed.TotalMilliseconds
    $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
    $selected = @{}
    foreach ($item in $processes) {
      $key = "$($item.ProcessId):$($item.CreationDate.Ticks)"
      if ($known.ContainsKey($key)) { $selected[$item.ProcessId] = $known[$key] }
      foreach ($group in $roots.Keys) {
        if ($roots[$group] -contains [int]$item.ProcessId -and $rootStarts[[int]$item.ProcessId] -eq $item.CreationDate.Ticks) {
          $selected[$item.ProcessId] = $group
        }
      }
    }
    do {
      $added = $false
      foreach ($item in $processes) {
        if (!$selected.ContainsKey($item.ProcessId) -and $selected.ContainsKey($item.ParentProcessId)) {
          $parent = $processes | Where-Object { $_.ProcessId -eq $item.ParentProcessId }
          if ($parent -and $parent.CreationDate -le $item.CreationDate) {
            $selected[$item.ProcessId] = $selected[$item.ParentProcessId]; $added = $true
          }
        }
      }
    } while ($added)
    $sampleTime = $clock.Elapsed.TotalMilliseconds
    $gpu = Read-Counters 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine'
    $gpuMemory = Read-Counters 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory'
    $disk = Read-Counters 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk'
    $next = @{}; $known = @{}; $entries = @()
    foreach ($item in $processes) {
      if (!$selected.ContainsKey($item.ProcessId)) { continue }
      $key = "$($item.ProcessId):$($item.CreationDate.Ticks)"
      $known[$key] = $selected[$item.ProcessId]
      if (!$aliases.ContainsKey($key)) { $aliases[$key] = "process-$($aliases.Count + 1)" }
      $cpu = $null
      if ($null -ne $item.KernelModeTime -and $null -ne $item.UserModeTime) {
        $cpu = ([double]$item.KernelModeTime + [double]$item.UserModeTime) / 10000000
      }
      $corePercent = $null
      if ($null -ne $cpu -and $previous.ContainsKey($key) -and $null -ne $previous[$key].cpu -and
          $sampleTime -gt $previous[$key].time -and $cpu -ge $previous[$key].cpu) {
        $corePercent = [Math]::Round(($cpu - $previous[$key].cpu) * 100000 / ($sampleTime - $previous[$key].time), 2)
      }
      $next[$key] = @{ time = $sampleTime; cpu = $cpu }
      $engines = @(); $memory = @()
      foreach ($row in $gpu.rows) {
        if ($row.Name -match '^pid_(\d+)_(.+)_engtype_(.+)$' -and [int]$Matches[1] -eq $item.ProcessId) {
          $engine = $Matches[2]; $type = $Matches[3]
          if (!$engineAliases.ContainsKey($engine)) { $engineAliases[$engine] = "engine-$($engineAliases.Count + 1)" }
          $engines += @{ engine = $engineAliases[$engine]; type = $type; percent = $row.UtilizationPercentage }
        }
      }
      foreach ($row in $gpuMemory.rows) {
        if ($row.Name -match '^pid_(\d+)_' -and [int]$Matches[1] -eq $item.ProcessId) {
          $memory += @{ dedicatedBytes = $row.DedicatedUsage; sharedBytes = $row.SharedUsage }
        }
      }
      $entries += @{ group = $selected[$item.ProcessId]; process = $aliases[$key]; cpuCorePercent = $corePercent;
        workingSetBytes = $item.WorkingSetSize; privateCommitBytes = $item.PrivatePageCount;
        ioReadBytes = $item.ReadTransferCount; ioWriteBytes = $item.WriteTransferCount;
        gpuEngines = $engines; gpuMemory = $memory }
    }
    $previous = $next
    $hostDisk = @($disk.rows | Where-Object { $_.Name -eq '_Total' } | ForEach-Object {
      @{ readBytesPerSecond = $_.DiskReadBytesPersec; writeBytesPerSecond = $_.DiskWriteBytesPersec; queue = $_.CurrentDiskQueueLength }
    })
    $sample = @{ time = [DateTime]::UtcNow.ToString('o'); elapsedMs = $sampleTime; entries = $entries;
      gpuState = $gpu.state; gpuMemoryState = $gpuMemory.state; diskState = $disk.state; hostDisk = $hostDisk;
      probeMs = [Math]::Round($clock.Elapsed.TotalMilliseconds - $started, 1) }
    $writer.WriteLine(($sample | ConvertTo-Json -Depth 8 -Compress)); $writer.Flush()
    $remaining = [Math]::Min($IntervalSeconds * 1000 - ($clock.Elapsed.TotalMilliseconds - $started),
      $DurationSeconds * 1000 - $clock.Elapsed.TotalMilliseconds)
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int]$remaining) }
  }
} finally { $writer.Dispose(); $stream.Dispose() }

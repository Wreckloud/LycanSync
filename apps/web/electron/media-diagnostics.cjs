const { appendFile, mkdir, open, rename, stat } = require('node:fs/promises');
const { dirname } = require('node:path');

// 保存故障与一次性启动摘要；串行轮转避免并发写入时覆盖日志。
function createMediaDiagnostics(path, maxBytes = 1024 * 1024) {
  let pending = Promise.resolve();
  const repeated = new Map();
  const append = (entry) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
    pending = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const size = await stat(path).then((value) => value.size).catch((error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
        await rename(path, `${path}.previous`);
      }
      await appendFile(path, line, 'utf8');
    }).catch((error) => {
      console.error('无法写入原生媒体诊断', error.code ?? error.message);
    });
    return pending;
  };
  const write = (entry) => {
    if (['helperStderr', 'obsCaptureHostStderr', 'voiceOverlayCreated', 'gpuAdapters'].includes(entry.stage)) {
      const key = JSON.stringify(entry);
      const previous = repeated.get(key);
      if (previous && performance.now() - previous.time < 30_000) {
        previous.count++;
        return pending;
      }
      if (previous?.count) void append({ ...previous.entry, repeatCount: previous.count });
      repeated.delete(key);
      if (repeated.size >= 64) {
        const oldestKey = repeated.keys().next().value;
        const oldest = repeated.get(oldestKey);
        if (oldest.count) void append({ ...oldest.entry, repeatCount: oldest.count });
        repeated.delete(oldestKey);
      }
      repeated.set(key, { entry, time: performance.now(), count: 0 });
    }
    return append(entry);
  };
  // 导出与退出时补齐重复次数，不为日志合并增加定时器。
  write.flush = () => {
    for (const previous of repeated.values()) {
      if (previous.count) void append({ ...previous.entry, repeatCount: previous.count });
      previous.count = 0;
    }
    return pending;
  };
  return write;
}

// 仅读取有界日志尾部；导出阶段/错误码，不把异常正文、路径或凭据带入报告。
async function readDiagnosticEvents(path, startedAt, endedAt) {
  const events = [];
  for (const file of [`${path}.previous`, path]) {
    let handle;
    try {
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
      if (start > 0) lines.shift();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const time = Date.parse(entry.time);
        if (!Number.isFinite(time) || time < startedAt || time > endedAt) continue;
        const stage = typeof entry.stage === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(entry.stage)
          ? entry.stage : 'unknown';
        const message = typeof entry.message === 'string' ? entry.message : '';
        const hresults = [...new Set(message.match(/\b0x[0-9a-fA-F]{8}\b/g) ?? [])].slice(0, 8);
        const audioTiming = {};
        const details = {};
        if (entry.stage === 'rendererExited' && ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom',
          'launch-failed', 'integrity-failure', 'memory-eviction'].includes(entry.outcome)) details.outcome = entry.outcome;
        if (['nativeVideoFirstFrameTimeout', 'nativeVideoFrameAdjustmentFailed', 'nativeVideoTrackWriteFailed',
          'nativeVideoSessionStopped', 'nativeVideoFailed', 'obsCaptureStopUnconfirmed', 'obsCaptureHostUnavailable',
          'obsCapturePrepareTimeout', 'obsCaptureStartTimeout', 'sharedTextureReleaseTimedOut',
          'sharedTextureImportFailed', 'sharedTextureTransferFailed', 'sharedTextureReceiverFailed',
          'sharedTextureSlotReleaseFailed', 'captureTargetClosed', 'remoteControlInputFailed',
          'nativeVideoBridgeUnavailable', 'videoSourceExpired', 'videoCaptureAlreadyRunning',
          'obsCaptureGameDetectionFailed', 'obsCaptureVersionUnsupported', 'dxgiMonitorUnavailable',
          'dxgiAdapterMismatch', 'obsGameTargetMismatch', 'obsGameBindingUnavailable'].includes(entry.code)) details.code = entry.code;
        if (['window', 'monitor'].includes(entry.sourceKind)) details.sourceKind = entry.sourceKind;
        if (typeof entry.hostReused === 'boolean') details.hostReused = entry.hostReused;
        for (const key of ['repeatCount', 'importedCount', 'pendingReleaseCount', 'width', 'height', 'maxFps',
          'adapterIndex', 'sourceWidth', 'sourceHeight']) {
          if (Number.isSafeInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 1_000_000) details[key] = entry[key];
        }
        if (['dxgi', 'wgc-window', 'game'].includes(entry.captureMethod)) details.captureMethod = entry.captureMethod;
        if (['DuplicateOutput1', 'DuplicateOutput'].includes(entry.captureApi)) details.captureApi = entry.captureApi;
        if (typeof entry.adapterMatched === 'boolean') details.adapterMatched = entry.adapterMatched;
        if (['graceful', 'forced', 'unexpected', 'beforeStart'].includes(entry.stopMode)) details.stopMode = entry.stopMode;
        if (['shutdown', 'stopTimeout', 'adapterChange', 'textureTimeout', 'idle', 'failure'].includes(entry.stopReason)) {
          details.stopReason = entry.stopReason;
        }
        if (entry.stage === 'applicationReady') {
          for (const key of ['appVersion', 'electronVersion', 'osVersion']) {
            if (typeof entry[key] === 'string' && /^[\d.]{1,40}$/.test(entry[key])) details[key] = entry[key];
          }
          if (['win32', 'darwin', 'linux'].includes(entry.platform)) details.platform = entry.platform;
          if (['x64', 'arm64', 'ia32'].includes(entry.arch)) details.arch = entry.arch;
        }
        if (stage === 'screenAudioStartup') {
          if (['published', 'failed'].includes(entry.outcome)) audioTiming.outcome = entry.outcome;
          if (['capture', 'graph', 'publish'].includes(entry.phase)) audioTiming.phase = entry.phase;
          for (const key of ['pluginLoadMs', 'captureReadyMs', 'graphReadyMs', 'publishMs']) {
            if (Number.isFinite(entry[key]) && entry[key] >= 0 && entry[key] <= 300_000) audioTiming[key] = entry[key];
          }
        }
        events.push({ time: new Date(time).toISOString(), stage, hresults,
          ...(typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? { durationMs: entry.durationMs } : {}),
          ...audioTiming, ...details });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取本机故障诊断，请检查数据目录权限。');
    } finally { await handle?.close(); }
  }
  return events.sort((left, right) => left.time.localeCompare(right.time)).slice(-200);
}

function createProcessMetricsReader(openNativeProcess) {
  const nativeReaders = new WeakMap();
  const memoryMiB = (value, unit) => Number.isFinite(value) && value >= 0 ? Math.round(value / unit * 10) / 10 : null;
  return (metrics, nativeProcesses, supported) => {
    const entries = metrics.map((entry) => ({
      role: ['Browser', 'Tab', 'GPU', 'Utility'].includes(entry.type) ? `electron-${entry.type}` : 'electron-other',
      state: 'running', workingSetMiB: memoryMiB(entry.memory?.workingSetSize, 1024),
      privateCommitMiB: memoryMiB(entry.memory?.privateBytes, 1024),
    }));
    for (const { role, children, executablePath } of nativeProcesses) {
      const running = children.filter((child) => child.exitCode == null && child.signalCode == null);
      if (!supported || !running.length) {
        entries.push({ role, state: supported ? 'stopped' : 'unavailable', workingSetMiB: null, privateCommitMiB: null });
        continue;
      }
      for (const child of running) {
        try {
          let reader = nativeReaders.get(child);
          if (!reader) {
            reader = openNativeProcess(child.pid, executablePath);
            nativeReaders.set(child, reader);
            // 固定进程句柄只随本次子进程存活，不因停止后 PID 重用而读取其他程序。
            child.once('close', () => { reader.release(); nativeReaders.delete(child); });
          }
          const memory = reader.readMemory();
          const workingSetMiB = memoryMiB(memory.workingSetBytes, 1024 * 1024);
          const privateCommitMiB = memoryMiB(memory.privateCommitBytes, 1024 * 1024);
          entries.push({ role, state: workingSetMiB === null || privateCommitMiB === null ? 'unavailable' : 'running',
            workingSetMiB, privateCommitMiB });
        } catch {
          entries.push({ role, state: 'unavailable', workingSetMiB: null, privateCommitMiB: null });
        }
      }
    }
    return {
      cpuPercent: Math.round(metrics.reduce((sum, entry) => sum + (entry.cpu?.percentCPUUsage ?? 0), 0) * 10) / 10,
      memoryMb: Math.round(metrics.reduce((sum, entry) => sum + (entry.memory?.workingSetSize ?? 0), 0) / 1024), entries,
    };
  };
}

module.exports = { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader };

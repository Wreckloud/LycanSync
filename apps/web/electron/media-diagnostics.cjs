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
    if (['helperStderr', 'obsCaptureHostStderr', 'voiceOverlayCreated', 'gpuAdapters', 'diagnosticSnapshotFailed'].includes(entry.stage)) {
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
        if (stage.startsWith('screenPicker') || stage === 'sourceWindowThumbnail') {
          for (const key of ['pickerId', 'sourceCount', 'readyCount']) {
            if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) details[key] = entry[key];
          }
          if (typeof entry.confirmed === 'boolean') details.confirmed = entry.confirmed;
          if (['ready', 'timeout', 'failed'].includes(entry.outcome)) details.outcome = entry.outcome;
        }
        if (entry.stage === 'screenSourceReserved' && typeof entry.requiresWindowCapture === 'boolean') {
          details.requiresWindowCapture = entry.requiresWindowCapture;
        }
        if (entry.stage === 'screenSourceReserved' && typeof entry.preparationReused === 'boolean') {
          details.preparationReused = entry.preparationReused;
        }
        if (entry.stage === 'diagnosticSnapshotFailed'
            && ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'unknown'].includes(entry.storageError)) {
          details.storageError = entry.storageError;
        }
        if (entry.stage === 'rendererExited' && ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom',
          'launch-failed', 'integrity-failure', 'memory-eviction'].includes(entry.outcome)) details.outcome = entry.outcome;
        if (['nativeVideoFirstFrameTimeout', 'nativeVideoFrameAdjustmentFailed', 'nativeVideoTrackWriteFailed',
          'nativeVideoSessionStopped', 'nativeVideoFailed', 'nativeGameFollowFailed', 'nativeGameFollowUnavailable',
          'nativeGameFollowTargetInvalid', 'nativeGameFollowTargetAmbiguous', 'nativeGameFollowBusy',
          'obsCaptureStopUnconfirmed', 'obsCaptureHostUnavailable',
          'obsCapturePrepareTimeout', 'obsCaptureStartTimeout', 'sharedTextureReleaseTimedOut',
          'sharedTextureImportFailed', 'sharedTextureTransferFailed', 'sharedTextureTransferTimedOut',
          'sharedTextureReceiverUnavailable', 'sharedTextureReceiverFailed',
          'sharedTextureSlotReleaseFailed', 'captureTargetClosed', 'remoteControlInputFailed',
          'nativeVideoBridgeUnavailable', 'videoSourceExpired', 'videoCaptureAlreadyRunning',
          'obsCaptureGameDetectionFailed', 'obsCaptureVersionUnsupported', 'dxgiMonitorUnavailable',
          'dxgiAdapterMismatch', 'obsGameTargetMismatch', 'obsGameBindingUnavailable',
          'captureSettingsUnsupported', 'captureMethodNotIsolated', 'captureBorderUnsupported', 'captureBorderAccessDenied', 'obsCaptureHostFailed',
          'obsCaptureHostDisposed', 'obsCaptureSlotReleaseUnavailable', 'obsCaptureAlreadyRunning', 'obsCaptureStopping',
          'obsCaptureProtocolLineTooLong', 'obsCaptureProtocolLineInvalid', 'obsCaptureProtocolJsonInvalid',
          'obsCaptureProtocolEventInvalid', 'obsCaptureFrameInvalid', 'obsCaptureFrameDeliveryFailed',
          'obsCaptureSuspensionInvalid', 'obsCaptureDiagnosticsInvalid', 'obsCaptureConfigurationInvalid',
          'obsCaptureConfigurationRejected', 'obsCaptureDiagnosticsUnavailable', 'obsCaptureDiagnosticsTimeout',
          'obsCaptureConfigurationInProgress', 'obsCaptureConfigurationTimeout', 'obsCaptureConfigurationRollbackFailed',
          'obsCaptureModuleLoadFailed', 'obsCaptureHostClosed', 'obsCaptureHostClosedUnexpectedly',
          'obsCaptureHostClosedBeforeStart', 'sharedTextureUnavailable', 'sharedTextureDeviceUnavailable',
          'sharedTextureSourceInvalid', 'sharedTextureAcquireFailed', 'sharedTextureGpuWaitFailed',
          'sharedTextureGpuStalled', 'sharedTextureReleaseFailed',
          'invalidCaptureArguments', 'invalidCaptureCommand', 'obsStartupFailed', 'obsVideoInitFailed',
          'obsAudioInitFailed', 'obsVideoIdleFailed', 'obsSceneUnavailable', 'obsDisplaySceneAddFailed',
          'obsDisplaySourceUnavailable', 'obsGameSourceUnavailable', 'obsWindowRuntimeUnavailable',
          'obsWindowCaptureStartFailed', 'obsWindowCaptureStopped', 'obsWindowSourceUnavailable',
          'obsWindowBindingUnavailable', 'obsWindowTargetMismatch',
          'microphoneModuleLoadFailed', 'microphoneCaptureStartFailed', 'microphoneProcessingFailed',
          'microphoneCapturePipeFailed', 'microphoneCaptureStartTimedOut', 'microphoneCaptureFailed',
          'microphoneDeviceUnavailable', 'invalidMicrophoneCommand', 'obsAudioProtocolInvalid',
          'microphoneRequestTimedOut', 'microphoneCaptureStopFailed', 'microphoneCapturePipeClosed',
          'microphoneCaptureInvalidPacket', 'microphoneCaptureBufferOverflow',
          'recordingShareUnavailable', 'recordingBusy', 'recordingPathInvalid', 'recordingHardwareEncoderUnavailable',
          'recordingEncoderStartFailed', 'recordingAudioEncoderUnavailable', 'recordingOutputUnavailable',
          'recordingModuleUnavailable', 'recordingApplicationAudioUnavailable', 'recordingDiskFull',
          'recordingWriteFailed', 'recordingHostExited', 'recordingStartTimedOut', 'recordingStopUnconfirmed', 'recordingVoiceUnavailable', 'recordingLibraryUnavailable', 'replaySaveUnconfirmed'].includes(entry.code)) details.code = entry.code;
        if (['recordingStarted', 'recordingStopped', 'recordingFailed', 'replayStarted', 'replayStopRequested', 'replayStopped', 'replaySaved', 'replayFailed'].includes(stage)) {
          for (const key of ['applicationAudio', 'microphone', 'friends', 'saved', 'saving', 'duringWarmup']) {
            if (typeof entry[key] === 'boolean') details[key] = entry[key];
          }
          for (const key of ['bytes', 'outputFrames', 'operationId', 'startupMs', 'stopMs', 'saveMs', 'bufferedMs']) {
            if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) details[key] = entry[key];
          }
          if (['nvenc', 'qsv', 'amf', 'unknown'].includes(entry.encoder)) details.encoder = entry.encoder;
          if (['CQP', 'ICQ', 'unknown'].includes(entry.configuredRateControl)) details.configuredRateControl = entry.configuredRateControl;
          if (typeof entry.configuredLookahead === 'boolean') details.configuredLookahead = entry.configuredLookahead;
          if ([30, 60, 120].includes(entry.seconds)) details.seconds = entry.seconds;
          if ([256, 512, 1024].includes(entry.memoryBudgetMb)) details.memoryBudgetMb = entry.memoryBudgetMb;
          if ([30, 60, 120].includes(entry.configuredFrameRate)) details.configuredFrameRate = entry.configuredFrameRate;
        }
        if (stage === 'microphoneSourceFailed' && entry.code === 'microphoneCapturePipeFailed'
            && ['samples', 'open', 'completionEvent', 'write', 'writeWait', 'writeResult', 'shortWrite'].includes(entry.pipePhase)) {
          details.pipePhase = entry.pipePhase;
          if (Number.isInteger(entry.win32Error) && entry.win32Error > 0 && entry.win32Error <= 0xffffffff) {
            details.win32Error = entry.win32Error;
          }
        }
        if (stage === 'microphoneEchoState' && ['disabled', 'pending', 'ready', 'unavailable'].includes(entry.status)) {
          details.status = entry.status;
        }
        // 导出的时间范围可能跨越升级，旧处理器记录仍用于定位历史问题。
        if (stage === 'microphoneReady' && entry.backend === 'obsLibobs'
            && ['sonora-0.2.0', 'aec3+rnnoise-obs32.2.2+sonora-0.2.0'].includes(entry.processing)) {
          details.backend = entry.backend;
          details.processing = entry.processing;
          for (const key of ['coreReadyMs', 'pluginLoadMs', 'sourceSetupMs', 'firstBlockWaitMs']) {
            if (Number.isInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 300_000) details[key] = entry[key];
          }
        }
        if (stage === 'microphoneHostExited' && Number.isInteger(entry.exitCode)
            && entry.exitCode >= -2147483648 && entry.exitCode <= 4294967295) details.exitCode = entry.exitCode;
        if (['window', 'monitor'].includes(entry.sourceKind)) details.sourceKind = entry.sourceKind;
        if (typeof entry.hostReused === 'boolean') details.hostReused = entry.hostReused;
        for (const key of ['repeatCount', 'importedCount', 'pendingReleaseCount', 'width', 'height', 'maxFps',
          'adapterIndex', 'sourceWidth', 'sourceHeight']) {
          if (Number.isSafeInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 1_000_000) details[key] = entry[key];
        }
        if (['dxgi', 'wgc-window', 'bitblt-window', 'game'].includes(entry.captureMethod)) details.captureMethod = entry.captureMethod;
        if (['auto', 'game', 'bitblt', 'wgc'].includes(entry.requestedMethod)) details.requestedMethod = entry.requestedMethod;
        if (typeof entry.borderAllowed === 'boolean') details.borderAllowed = entry.borderAllowed;
        if (typeof entry.clientArea === 'boolean') details.clientArea = entry.clientArea;
        if (stage === 'sendTexture') {
          for (const key of ['rendererAlive', 'rendererLoading', 'backgroundThrottling', 'windowMinimized', 'windowVisible']) {
            if (typeof entry[key] === 'boolean') details[key] = entry[key];
          }
        }
        // 仍可分析旧版本报告中的切换原因；当前宿主不再执行这条降级路径。
        if (['captureSettingsUnsupported', 'captureBorderAccessDenied', 'obsWindowRuntimeUnavailable'].includes(entry.windowFallbackReason)) {
          details.windowFallbackReason = entry.windowFallbackReason;
        }
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
        if (stage === 'voiceJoinReady') {
          for (const key of ['preflightMs', 'tokenMs', 'connectMs', 'microphoneMs', 'listeningMs']) {
            if (Number.isFinite(entry[key]) && entry[key] >= 0 && entry[key] <= 300_000) details[key] = entry[key];
          }
          if (typeof entry.microphoneEnabled === 'boolean') details.microphoneEnabled = entry.microphoneEnabled;
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

function createProcessMetricsReader(openNativeProcess, { now = () => performance.now(), logicalProcessors = require('node:os').cpus().length } = {}) {
  const nativeReaders = new WeakMap();
  let electronPrevious = new Map();
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  const rounded = value => value === null ? null : Math.round(value * 10) / 10;
  const memoryMiB = (value, unit) => numeric(value) === null ? null : rounded(value / unit);
  const empty = { cpuCorePercent: null, intervalMs: null, ioReadBytesPerSecond: null, ioWriteBytesPerSecond: null };
  function interval(current, previous) {
    const elapsed = previous ? current.time - previous.time : 0;
    const rate = key => elapsed > 0 && numeric(current[key]) !== null && numeric(previous?.[key]) !== null
      && current[key] >= previous[key] ? (current[key] - previous[key]) * 1000 / elapsed : null;
    const cpu = rate('cpuSeconds');
    return { cpuCorePercent: rounded(cpu === null ? null : cpu * 100), intervalMs: elapsed > 0 ? elapsed : null,
      ioReadBytesPerSecond: rounded(rate('ioReadBytes')), ioWriteBytesPerSecond: rounded(rate('ioWriteBytes')) };
  }
  return (metrics, nativeProcesses, supported) => {
    const time = now();
    const nextElectron = new Map();
    const entries = metrics.map(entry => {
      const key = `${entry.pid}:${entry.creationTime}`;
      const current = { time, cpuSeconds: entry.cpu?.cumulativeCPUUsage };
      nextElectron.set(key, current);
      return { role: ['Browser', 'Tab', 'GPU', 'Utility'].includes(entry.type) ? `electron-${entry.type}` : 'electron-other',
        state: 'running', workingSetMiB: memoryMiB(entry.memory?.workingSetSize, 1024),
        privateCommitMiB: memoryMiB(entry.memory?.privateBytes, 1024), ...interval(current, electronPrevious.get(key)) };
    });
    electronPrevious = nextElectron;
    const seen = new Set(metrics.map(entry => entry.pid));
    for (const { role, children, executablePath } of nativeProcesses) {
      const running = children.filter(child => child.exitCode == null && child.signalCode == null);
      if (!supported || !running.length) {
        entries.push({ role, state: supported ? 'stopped' : 'unavailable', workingSetMiB: null, privateCommitMiB: null, ...empty });
        continue;
      }
      for (const child of running) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        try {
          let owned = nativeReaders.get(child);
          if (!owned) {
            owned = { reader: openNativeProcess(child.pid, executablePath), previous: undefined };
            nativeReaders.set(child, owned);
            // 固定句柄绑定本次子进程；重启或 PID 重用不能沿用旧计数基线。
            child.once('close', () => { owned.reader.release(); nativeReaders.delete(child); });
          }
          const current = { ...owned.reader.readMetrics(), time };
          const rates = interval(current, owned.previous);
          owned.previous = current;
          const workingSetMiB = memoryMiB(current.workingSetBytes, 1024 * 1024);
          const privateCommitMiB = memoryMiB(current.privateCommitBytes, 1024 * 1024);
          entries.push({ role, state: workingSetMiB === null || privateCommitMiB === null ? 'unavailable' : 'running',
            workingSetMiB, privateCommitMiB, ...rates });
        } catch {
          const owned = nativeReaders.get(child);
          if (owned) owned.previous = undefined;
          entries.push({ role, state: 'unavailable', workingSetMiB: null, privateCommitMiB: null, ...empty });
        }
      }
    }
    const active = entries.filter(entry => entry.state !== 'stopped');
    const completeCpu = active.length > 0 && active.every(entry => entry.cpuCorePercent !== null);
    const clientCpuCorePercent = completeCpu ? rounded(active.reduce((sum, entry) => sum + entry.cpuCorePercent, 0)) : null;
    return {
      cpuPercent: rounded(metrics.reduce((sum, entry) => sum + (entry.cpu?.percentCPUUsage ?? 0), 0)),
      memoryMb: rounded(metrics.reduce((sum, entry) => sum + (entry.memory?.workingSetSize ?? 0), 0) / 1024),
      clientCpuCorePercent, logicalProcessors,
      clientCpuMachinePercent: clientCpuCorePercent !== null && logicalProcessors > 0 ? rounded(clientCpuCorePercent / logicalProcessors) : null,
      entries,
    };
  };
}

module.exports = { createMediaDiagnostics, readDiagnosticEvents, createProcessMetricsReader };

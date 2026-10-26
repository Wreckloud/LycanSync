import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { Participant, Room } from 'livekit-client';
import { createMediaDiagnosticsSampler, type MediaDiagnosticsSnapshot } from './mediaDiagnostics';
import packageInfo from '../../package.json';
import { SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality } from '../rtc/screenShareQuality';

const SAMPLE_INTERVAL_MS = 2_000;
const CHECKPOINT_INTERVAL_MS = 15_000;
const MAX_SAMPLES = 900;
const MAX_DURATION_MS = 30 * 60_000;
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;
const AUTOMATIC_DIAGNOSTICS_KEY = 'lycansync.automatic-diagnostics';
type DiagnosticSettings = { quality: string; customQuality?: CustomScreenShareQuality;
  inputGain: number; outputVolume: number; screenShareVolume: number;
  voiceVolumeBalance: boolean;
  noiseSuppression: boolean; autoGainControl: boolean; voiceEnhancement: boolean; echoCancellation: boolean;
  viewerCount: number };
type ReportSettings = DiagnosticSettings & { bitrateMode: 'recommended' | 'manual' | null;
  preset: { width: number; height: number; maxFrameRate: number; maxBitrate: number } | null };

function numeric(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function label(value: unknown) {
  return typeof value === 'string' && /^[\w .()+-]{1,120}$/.test(value) ? value : null;
}
function errorCode(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(value) ? value : null;
}

type DiagnosticSample = Omit<ReturnType<typeof diagnosticReportSample>, 'streams'> & { requestedSettings: ReportSettings;
  elapsedMs: number; actualIntervalMs: number | null;
  streams: (ReturnType<typeof diagnosticReportSample>['streams'][number] & { segmentId: string; segmentReason: string })[] };

function median(values: number[], decimals = 0) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function summarizeSegments(samples: DiagnosticSample[], clientVersion: string, desktop: boolean) {
  const grouped = new Map<string, { sample: DiagnosticSample; stream: DiagnosticSample['streams'][number] }[]>();
  for (const sample of samples) for (const stream of sample.streams) {
    const entries = grouped.get(stream.segmentId) ?? [];
    entries.push({ sample, stream }); grouped.set(stream.segmentId, entries);
  }
  return [...grouped].map(([segmentId, entries]) => {
    const first = entries[0]; const last = entries[entries.length - 1];
    const paused = entries.map(({ sample, stream }) => stream.subscription.subscribed === false
      || stream.subscription.enabled === false || stream.subscription.muted === true
      || (stream.direction === '发送' && sample.nativeVideoSessionMatched && sample.native?.captureSuspended === true));
    // 恢复后的首区间仍跨越暂停边界；仅排除明确暂停，不掩盖正常运行时的零帧。
    const comparableEntries = entries.filter((_, index) => !paused[index] && !paused[index - 1]);
    const sourceFps = comparableEntries.map(({ stream }) => stream.sourceFps).filter((value): value is number => value !== null);
    const submittedFps = comparableEntries.map(({ stream }) => stream.nativeInputInterval?.submittedFps)
      .filter((value): value is number => typeof value === 'number');
    const receivedFps = comparableEntries.map(({ stream }) => stream.nativeInputInterval?.receivedFps)
      .filter((value): value is number => typeof value === 'number');
    const playbackFps = comparableEntries.map(({ stream }) => stream.playbackFps).filter((value): value is number => value !== null);
    const nativeCaptureFps = comparableEntries.filter(({ stream, sample }) =>
      stream.direction === '发送' && sample.nativeVideoSessionMatched)
      .map(({ sample }) => sample.nativeInterval?.receivedFps)
      .filter((value): value is number => typeof value === 'number');
    const nativeProcessedFps = comparableEntries.filter(({ stream, sample }) =>
      stream.direction === '发送' && sample.nativeVideoSessionMatched)
      .map(({ sample }) => sample.nativeInterval?.processedFps)
      .filter((value): value is number => typeof value === 'number');
    const renderEntries = comparableEntries.filter(({ stream, sample }) =>
      stream.direction === '发送' && sample.nativeVideoSessionMatched);
    const obsRenderFps = renderEntries.map(({ sample }) => sample.obsRenderInterval?.renderedFps)
      .filter((value): value is number => typeof value === 'number');
    const renderMs = renderEntries.map(({ sample }) => sample.native?.obsRender?.averageRenderMs)
      .filter((value): value is number => typeof value === 'number');
    const renderTotal = renderEntries.reduce((sum, { sample }) => sum + (sample.obsRenderInterval?.totalFrames ?? 0), 0);
    const renderLagged = renderEntries.reduce((sum, { sample }) => sum + (sample.obsRenderInterval?.laggedFrames ?? 0), 0);
    const layerIds = [...new Set(entries.flatMap(({ stream }) => stream.layers.map((layer) => layer.layer)))];
    const layers = layerIds.map((layer) => {
      const matching = entries.flatMap(({ stream }) => stream.layers.filter((item) => item.layer === layer));
      const active = matching.find((item) => item.active !== null)?.active ?? null;
      const values = comparableEntries.flatMap(({ stream }) => stream.layers.filter((item) => item.layer === layer && item.active !== false)
        .map((item) => item.fps).filter((value): value is number => value !== null));
      const measured = comparableEntries.flatMap(({ stream }) => stream.layers.filter((item) => item.layer === layer && item.active !== false));
      const numbers = (field: 'bitrateKbps' | 'averageEncodeMs' | 'roundTripMs' | 'receiverReportedLossPercent' | 'receiveLossPercent' | 'jitterBufferMs') =>
        measured.map((item) => item[field]).filter((value): value is number => value !== null);
      return { layer, active, size: matching.find((item) => item.size !== '未知')?.size ?? null,
        typicalFps: median(values), validSamples: values.length,
        typicalBitrateKbps: median(numbers('bitrateKbps')), typicalEncodeMs: median(numbers('averageEncodeMs'), 1),
        encoderImplementations: [...new Set(matching.map((item) => item.encoder).filter((value) => value !== null))],
        powerEfficientEncoderValues: [...new Set(matching.map((item) => item.powerEfficientEncoder).filter((value) => value !== null))],
        network: { typicalRoundTripMs: median(numbers('roundTripMs')),
          typicalReceiverReportedLossPercent: median(numbers('receiverReportedLossPercent'), 2),
          typicalReceiveLossPercent: median(numbers('receiveLossPercent'), 2), typicalJitterBufferMs: median(numbers('jitterBufferMs'), 1),
          validSamples: { roundTrip: numbers('roundTripMs').length, receiverReport: numbers('receiverReportedLossPercent').length,
            receiveLoss: numbers('receiveLossPercent').length, jitterBuffer: numbers('jitterBufferMs').length } } };
    });
    const totalReceived = comparableEntries.reduce((sum, { stream }) => sum + (stream.nativeInputInterval?.receivedFrames ?? 0), 0);
    const totalBackpressureDrops = comparableEntries.reduce((sum, { stream }) =>
      sum + (stream.nativeInputInterval?.backpressureDroppedFrames ?? 0), 0);
    const warnings = new Set<string>();
    for (const [index, { sample, stream }] of entries.entries()) {
      if (!sample.pageVisible) warnings.add('页面在后台，采样定时器可能被系统节流。');
      if (sample.actualIntervalMs !== null && sample.actualIntervalMs > SAMPLE_INTERVAL_MS * 1.5) {
        warnings.add(`存在较长采样区间（约 ${Math.round(sample.actualIntervalMs / 1000)} 秒），区间 FPS 是该时段平均值。`);
      }
      if (sample.failures.length) warnings.add('部分统计读取失败或缺失。');
      if (stream.nativeInput?.frameRateAdjustmentFailed) warnings.add('采集帧率自动调整失败，保留最后确认的运行目标；不代表已恢复用户帧率。');
      if (stream.subscription.subscribed === false) warnings.add('接收端未订阅此路视频。');
      if (paused[index]) {
        warnings.add('记录期间存在暂停或静音状态。');
        warnings.add('明确暂停及恢复边界区间不计入摘要帧率和页面背压比例；原始样本仍保留。');
      }
      if (stream.nativeInput?.placeholderFrames) warnings.add('最小化提示画面单独计数，不纳入真实帧提交 FPS。');
      if (stream.layers.some((layer) => layer.active === false)) warnings.add('部分编码层处于停用状态。');
      if (stream.segmentReason === 'counter-reset') warnings.add('计数器重置后已另起分段。');
    }
    if ((first.stream.direction === '发送' && sourceFps.length === 0)
        || (first.stream.direction === '接收' && playbackFps.length === 0)
        || (first.stream.direction === '发送' && submittedFps.length === 0)) {
      warnings.add('至少一个阶段没有可比较样本；等待统计或缺失值不按 0 处理。');
    }
    const firstNativeInput = entries.find(({ stream }) => typeof stream.nativeInput?.firstFrameMs === 'number')?.stream.nativeInput;
    const matchedNativeSamples = entries.filter(({ sample }) => sample.nativeVideoSessionMatched)
      .map(({ sample }) => sample.native).filter((value) => value !== null);
    const native = matchedNativeSamples[0];
    const latestNative = matchedNativeSamples[matchedNativeSamples.length - 1];
    const obsBridgeDroppedFrames = native?.captureBackend === 'obsLibobs'
      && typeof native.obsBridgeDroppedFrames === 'number'
      && typeof latestNative?.obsBridgeDroppedFrames === 'number'
      && latestNative.obsBridgeDroppedFrames >= native.obsBridgeDroppedFrames
      ? latestNative.obsBridgeDroppedFrames - native.obsBridgeDroppedFrames : null;
    if (native?.captureBackend === 'obsLibobs') {
      warnings.add('OBS 帧计数截至宿主事件发出，不代表 Electron 已成功导入纹理或 LiveKit 已编码。');
      warnings.add('OBS 渲染 FPS 不代表不同来源画面；渲染耗时是内部约一秒滚动均值，不是编码或端到端延迟。');
    }
    const nativeResolution = first.stream.direction === '发送' && native?.frameWidth && native.frameHeight
      ? `${native.frameWidth}×${native.frameHeight}` : null;
    const encodedDimensions = [...new Set(entries.flatMap(({ stream }) => stream.layers)
      .map((layer) => layer.size).filter((size) => size !== '未知'))];
    const targetResolution = entries.map(({ stream }) => stream.target?.resolution).find(Boolean) ?? null;
    const typicalReceivedFps = median(receivedFps);
    const typicalSubmittedFps = median(submittedFps);
    const observations = [
      typicalReceivedFps !== null ? `页面收到约 ${typicalReceivedFps} FPS。` : null,
      typicalSubmittedFps !== null ? `页面提交约 ${typicalSubmittedFps} FPS。` : null,
      layers.some((layer) => layer.typicalFps !== null)
        ? `${first.stream.direction === '发送' ? '编码' : '解码'}层 FPS 分别记录为 ${layers.map((layer) => `第 ${layer.layer} 层 ${layer.typicalFps ?? '等待统计'}`).join('、')}，不跨层相加。` : null,
      median(playbackFps) !== null ? `本机显示约 ${median(playbackFps)} FPS。` : null,
      median(nativeCaptureFps) !== null ? `${native?.captureBackend === 'obsLibobs' ? 'OBS 渲染回调' : '原生采集收到'}约 ${median(nativeCaptureFps)} FPS。` : null,
      median(nativeProcessedFps) !== null ? `${native?.captureBackend === 'obsLibobs' ? 'OBS 宿主发出共享纹理帧' : '原生采集处理'}约 ${median(nativeProcessedFps)} FPS。` : null,
      obsBridgeDroppedFrames !== null ? `记录期间 OBS 纹理桥累计丢帧 ${obsBridgeDroppedFrames}（槽位忙或 GPU 等待跳过）。` : null,
      median(obsRenderFps) !== null ? `OBS 渲染循环约 ${median(obsRenderFps)} FPS。` : null,
      median(renderMs, 2) !== null ? `OBS 平均渲染耗时典型值 ${median(renderMs, 2)} ms。` : null,
      renderTotal > 0 ? `OBS 可比较区间延误 ${renderLagged} / ${renderTotal} 个渲染时隙。` : null,
      totalBackpressureDrops > 0 ? `页面背压期间累计丢弃 ${totalBackpressureDrops} 帧（占收到真实帧 ${totalReceived > 0
        ? `${Math.round(totalBackpressureDrops / totalReceived * 10_000) / 100}%` : '比例待统计'}）。` : null,
    ].filter((value): value is string => value !== null);
    const evidence = [
      { stage: '来源供帧', available: nativeProcessedFps.length > 0 || sourceFps.length > 0 },
      { stage: '页面交付', available: submittedFps.length > 0 },
      { stage: first.stream.direction === '发送' ? '编码' : '解码', available: layers.some((layer) => layer.validSamples > 0) },
      { stage: '网络反馈', available: layers.some((layer) => layer.network.validSamples.receiverReport > 0
        || layer.network.validSamples.roundTrip > 0 || layer.network.validSamples.receiveLoss > 0) },
      { stage: '本机播放', available: playbackFps.length > 0 },
      { stage: 'OBS 渲染', available: obsRenderFps.length > 0 },
    ];
    if (first.stream.direction === '发送' && !evidence[3].available) warnings.add('没有有效的新接收报告，不能据此判断发送网络正常或异常。');
    return {
      segmentId, member: first.stream.member, direction: first.stream.direction,
      clientVersion, captureMode: first.stream.direction === '发送'
        ? native?.captureBackend ?? (desktop ? '桌面采集方式未取得' : '浏览器屏幕采集') : null,
      quality: first.stream.direction === '发送' ? first.sample.requestedSettings.quality : null,
      preset: first.stream.direction === '发送' ? first.sample.requestedSettings.preset : null,
      bitrateMode: first.stream.direction === '发送' ? first.sample.requestedSettings.bitrateMode : null,
      actualDimensions: { source: nativeResolution, encoded: encodedDimensions }, targetDimensions: targetResolution,
      durationMs: Math.max(0, last.sample.elapsedMs - first.sample.elapsedMs), sampleCount: entries.length,
      validSampleCounts: { nativeCaptureFps: nativeCaptureFps.length, nativeProcessedFps: nativeProcessedFps.length,
        sourceFps: sourceFps.length, pageReceivedFps: receivedFps.length, pageSubmittedFps: submittedFps.length,
        playbackFps: playbackFps.length },
      typicalFps: { nativeCapture: median(nativeCaptureFps), nativeProcessed: median(nativeProcessedFps),
        source: median(sourceFps), pageReceived: median(receivedFps), pageSubmitted: median(submittedFps),
        encodingLayers: layers, playback: median(playbackFps) },
      pageBackpressureDropRate: totalReceived > 0 ? Math.round(totalBackpressureDrops / totalReceived * 10_000) / 100 : null,
      pageBackpressureDroppedFrames: totalBackpressureDrops, pageReceivedFrames: totalReceived,
      localFirstFrameMs: firstNativeInput?.firstFrameMs ?? null,
      obsRender: { typicalFps: median(obsRenderFps), typicalRenderMs: median(renderMs, 2),
        validSamples: obsRenderFps.length, averageValidSamples: renderMs.length,
        totalFrames: obsRenderFps.length ? renderTotal : null, laggedFrames: obsRenderFps.length ? renderLagged : null,
        laggedPercent: renderTotal > 0 ? Math.round(renderLagged / renderTotal * 10_000) / 100 : null },
      evidence, observations, warnings: [...warnings],
    };
  });
}

/** 导出只挑选统计字段，不能序列化原始SDK报告、来源对象、昵称或会话标识。 */
export function diagnosticReportSample(snapshot: MediaDiagnosticsSnapshot, aliases: Map<string, string>) {
  const alias = (identity: string) => {
    if (!aliases.has(identity)) {
      const assigned = new Set(aliases.values());
      let number = aliases.size + 1;
      while (assigned.has(`member-${number}`)) number++;
      aliases.set(identity, `member-${number}`);
    }
    return aliases.get(identity)!;
  };
  const native = snapshot.native;
  return {
    time: snapshot.time, pageVisible: snapshot.pageVisible, participantCount: snapshot.participantCount,
    remoteParticipantCount: numeric(snapshot.remoteParticipantCount), roomState: label(snapshot.roomState),
    dynacast: snapshot.dynacast,
    nativeVideoSessionMatched: Boolean(snapshot.native?.sessionId && snapshot.streams.some((stream) =>
      stream.direction === '发送' && stream.nativeInput?.sessionId === snapshot.native?.sessionId)),
    nativeInterval: snapshot.nativeInterval && {
      elapsedMs: numeric(snapshot.nativeInterval.elapsedMs),
      framesReceived: numeric(snapshot.nativeInterval.framesReceived),
      framesProcessed: numeric(snapshot.nativeInterval.framesProcessed),
      receivedFps: numeric(snapshot.nativeInterval.receivedFps),
      processedFps: numeric(snapshot.nativeInterval.processedFps),
    },
    obsRenderInterval: snapshot.obsRenderInterval && {
      elapsedMs: numeric(snapshot.obsRenderInterval.elapsedMs), totalFrames: numeric(snapshot.obsRenderInterval.totalFrames),
      laggedFrames: numeric(snapshot.obsRenderInterval.laggedFrames), renderedFps: numeric(snapshot.obsRenderInterval.renderedFps),
      laggedPercent: numeric(snapshot.obsRenderInterval.laggedPercent),
    },
    omittedParticipants: snapshot.omittedParticipants, process: snapshot.process && {
      cpuPercent: numeric(snapshot.process.cpuPercent), memoryMb: numeric(snapshot.process.memoryMb),
      entries: snapshot.process.entries.map((entry) => ({
        role: ['electron-Browser', 'electron-Tab', 'electron-GPU', 'electron-Utility', 'electron-other', 'obs', 'media', 'activity']
          .includes(entry.role) ? entry.role : 'unknown',
        state: ['running', 'stopped', 'unavailable'].includes(entry.state) ? entry.state : 'unavailable',
        workingSetMiB: numeric(entry.workingSetMiB), privateCommitMiB: numeric(entry.privateCommitMiB),
      })),
    }, failures: snapshot.failures.map(errorCode).filter(Boolean),
    streams: snapshot.streams.map((stream) => ({ member: alias(stream.identity), direction: stream.direction,
      target: stream.target && { resolution: stream.target.resolution, frameRate: numeric(stream.target.frameRate),
        displaySurface: label(stream.target.displaySurface) },
      sourceFrames: numeric(stream.sourceFrames), sourceFps: numeric(stream.sourceFps), sourceIntervalMs: numeric(stream.sourceIntervalMs),
      playbackFrames: numeric(stream.playbackFrames), playbackFps: numeric(stream.playbackFps),
      playbackIntervalMs: numeric(stream.playbackIntervalMs),
      playbackDrops: numeric(stream.playbackDrops),
      subscription: { subscribed: stream.subscription.subscribed, enabled: stream.subscription.enabled,
        muted: stream.subscription.muted },
      nativeInput: stream.nativeInput && {
        receivedFrames: numeric(stream.nativeInput.receivedFrames), submittedFrames: numeric(stream.nativeInput.submittedFrames),
        backpressureDroppedFrames: numeric(stream.nativeInput.backpressureDroppedFrames),
        suspendedDroppedFrames: numeric(stream.nativeInput.suspendedDroppedFrames),
        completedWrites: numeric(stream.nativeInput.completedWrites), writeFailures: numeric(stream.nativeInput.writeFailures),
        placeholderFrames: numeric(stream.nativeInput.placeholderFrames), pendingWrite: stream.nativeInput.pendingWrite,
        firstFrameMs: numeric(stream.nativeInput.firstFrameMs),
        requestedFrameRate: numeric(stream.nativeInput.requestedFrameRate),
        captureFrameRate: numeric(stream.nativeInput.captureFrameRate),
        frameRateAdjustmentFailed: stream.nativeInput.frameRateAdjustmentFailed === true,
      },
      nativeInputInterval: stream.nativeInputInterval && {
        elapsedMs: numeric(stream.nativeInputInterval.elapsedMs),
        receivedFrames: numeric(stream.nativeInputInterval.receivedFrames),
        submittedFrames: numeric(stream.nativeInputInterval.submittedFrames),
        backpressureDroppedFrames: numeric(stream.nativeInputInterval.backpressureDroppedFrames),
        receivedFps: numeric(stream.nativeInputInterval.receivedFps),
        submittedFps: numeric(stream.nativeInputInterval.submittedFps),
        backpressureDropRate: numeric(stream.nativeInputInterval.backpressureDropRate),
      },
      layers: stream.layers.map((layer, index) => ({ layer: index + 1, size: layer.size, codec: label(layer.codec),
        active: layer.active,
        frameCount: numeric(layer.frameCount), fps: numeric(layer.fps), intervalMs: numeric(layer.intervalMs),
        bitrateKbps: numeric(layer.bitrateKbps), encoder: label(layer.encoder),
        powerEfficientEncoder: typeof layer.powerEfficientEncoder === 'boolean' ? layer.powerEfficientEncoder : null,
        roundTripMs: numeric(layer.roundTripMs), receiverReportedLossPercent: numeric(layer.receiverReportedLossPercent),
        feedbackAgeMs: numeric(layer.feedbackAgeMs), receiveLossPercent: numeric(layer.receiveLossPercent),
        jitterBufferMs: numeric(layer.jitterBufferMs),
        limitation: label(layer.limitation), averageEncodeMs: numeric(layer.averageEncodeMs),
        droppedFrames: numeric(layer.droppedFrames), lostPackets: numeric(layer.lostPackets) })),
    })),
    audio: snapshot.audio.map((audio) => ({ member: alias(audio.identity), source: audio.source, direction: audio.direction,
      sampleRate: numeric(audio.sampleRate), channels: numeric(audio.channels), packetsLost: numeric(audio.packetsLost),
      jitterMs: numeric(audio.jitterMs) })),
    native: native && {
      helperVersion: label(native.helperVersion), captureBackend: label(native.captureBackend),
      state: native.state, available: native.available, sourceKind: native.sourceKind,
      frameWidth: numeric(native.frameWidth), frameHeight: numeric(native.frameHeight),
      framesReceived: numeric(native.framesReceived), framesProcessed: numeric(native.framesProcessed),
      obsBridgeDroppedFrames: numeric(native.obsBridgeDroppedFrames),
      obsRender: native.obsRender ? { configuration: numeric(native.obsRender.configuration),
        elapsedMs: numeric(native.obsRender.elapsedMs), totalFrames: numeric(native.obsRender.totalFrames),
        laggedFrames: numeric(native.obsRender.laggedFrames), activeFps: numeric(native.obsRender.activeFps),
        averageRenderMs: numeric(native.obsRender.averageRenderMs) } : null,
      captureSuspended: native.captureSuspended,
      microphoneCaptureDroppedChunks: numeric(native.microphoneCaptureDroppedChunks),
      screenShareAudio: native.screenShareAudio && { state: native.screenShareAudio.state,
        sampleRate: numeric(native.screenShareAudio.sampleRate), channels: numeric(native.screenShareAudio.channels),
        packetsReceived: numeric(native.screenShareAudio.packetsReceived), framesReceived: numeric(native.screenShareAudio.framesReceived),
        silentPackets: numeric(native.screenShareAudio.silentPackets), droppedAudioChunks: numeric(native.screenShareAudio.droppedAudioChunks),
        lastError: errorCode(native.screenShareAudio.lastError) },
    },
  };
}

export function useDiagnosticReport(options: {
  room: () => Room | null;
  participants: () => Participant[];
  settings: () => DiagnosticSettings;
  automaticDefault?: boolean;
}) {
  const latest = shallowRef<MediaDiagnosticsSnapshot | null>(null);
  const recording = ref(false);
  const sampleCount = ref(0);
  const reason = ref('');
  const error = ref('');
  const saving = ref(false);
  const notes = ref('');
  const automaticEnabled = ref(false);
  const discardedSamples = ref(0);
  const savedSizeBytes = ref<number | null>(null);
  const savedReport = shallowRef<Awaited<ReturnType<NonNullable<Window['lycanDesktop']>['getSavedDiagnosticReport']>>>(null);
  const persistenceError = ref('');
  let viewing = false;
  let disposed = false;
  let generation = 0;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sampler = createMediaDiagnosticsSampler();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let samples: DiagnosticSample[] = [];
  let sampleBytes = 0;
  let sampleSizes: number[] = [];
  let sampleSequence = 0;
  let automaticRecording = false;
  let startSettings: ReportSettings | null = null;
  let endSettings: ReportSettings | null = null;
  let startedMonotonicAt = 0;
  let lastSampleMonotonicAt: number | null = null;
  let nextSegmentNumber = 1;
  let lastCheckpointAt = -Infinity;
  let checkpointPromise: Promise<void> | null = null;
  let savedReportRefreshedAfterCheckpoint = false;
  let savedReportGeneration = 0;
  const streamSegments = new Map<string, { sessionKey: string | null; quality: string; dimensions: string; renderConfiguration: number | null;
    segmentId: string; lastSampleIndex: number }>();
  const aliases = new Map<string, string>();

  function readSettings(): ReportSettings {
    const { customQuality, ...settings } = options.settings();
    const selected = SCREEN_SHARE_QUALITIES.find((item) => item.id === settings.quality);
    const preset = selected ? screenShareQuality(selected.id, customQuality) : null;
    const bitrateMode = !preset ? null
      : selected?.id === 'custom' && customQuality?.bitrateMbps !== undefined ? 'manual' : 'recommended';
    return { ...settings, bitrateMode,
      preset: preset ? { width: preset.width, height: preset.height,
        maxFrameRate: preset.fps, maxBitrate: preset.bitrate } : null };
  }

  function updateTimer() {
    if (!timer && (viewing || recording.value)) timer = setInterval(() => void poll(), SAMPLE_INTERVAL_MS);
    if (timer && !viewing && !recording.value) { clearInterval(timer); timer = undefined; }
  }

  function trimAutomaticSamples(elapsedMs: number) {
    while (samples.length && (samples.length > MAX_SAMPLES || sampleBytes > MAX_SAMPLE_BYTES
        || elapsedMs - samples[0].elapsedMs > MAX_DURATION_MS)) {
      samples.shift(); sampleBytes -= sampleSizes.shift()!; discardedSamples.value++;
    }
    if (!discardedSamples.value) return;
    const members = new Set(samples.flatMap((sample) => [...sample.streams, ...sample.audio].map((item) => item.member)));
    const streamKeys = new Set(samples.flatMap((sample) => sample.streams.map((stream) => `${stream.member}:${stream.direction}`)));
    for (const [identity, member] of aliases) if (!members.has(member)) aliases.delete(identity);
    for (const key of streamSegments.keys()) if (!streamKeys.has(key)) streamSegments.delete(key);
  }
  function stop(stopReason = 'user') {
    if (!recording.value) return;
    generation++;
    recording.value = false;
    endedAt = new Date().toISOString();
    endSettings = readSettings();
    reason.value = stopReason;
    updateTimer();
    return checkpoint(true);
  }
  async function poll() {
    if (disposed) return;
    if (recording.value && !automaticRecording && performance.now() - startedMonotonicAt >= MAX_DURATION_MS) stop('limit');
    const room = options.room();
    if (polling || (!room && !(recording.value && automaticRecording && window.lycanDesktop))
        || (!recording.value && (!viewing || document.hidden))) return;
    polling = true;
    const attempt = generation;
    const requestedSettings = readSettings();
    try {
      const snapshot = await sampler.collect(room, room ? options.participants() : []);
      if (disposed || attempt !== generation || room !== options.room()) return;
      latest.value = snapshot;
      if (recording.value) {
        const monotonicNow = performance.now();
        const currentSampleIndex = sampleSequence++;
        const exported = diagnosticReportSample(snapshot, aliases);
        const reportStreams = exported.streams.map((stream, index) => {
          const observed = snapshot.streams[index];
          const streamKey = `${stream.member}:${stream.direction}`;
          // 同为自定义模式时，尺寸、帧率或码率变化也必须划分统计区间。
          const quality = stream.direction === '发送'
            ? `${requestedSettings.quality}:${requestedSettings.bitrateMode}:${JSON.stringify(requestedSettings.preset)}` : '';
          const sourceDimensions = stream.direction === '发送' && exported.nativeVideoSessionMatched
            && snapshot.native?.frameWidth && snapshot.native.frameHeight
            ? `${snapshot.native.frameWidth}×${snapshot.native.frameHeight}` : '';
          const encodedDimensions = observed.layers.map((layer) => layer.size).sort().join(',');
          const dimensions = [observed.target?.resolution ?? '', sourceDimensions, encodedDimensions].join('|');
          const previousSegment = streamSegments.get(streamKey);
          const renderConfiguration = stream.direction === '发送' && exported.nativeVideoSessionMatched
            ? snapshot.native?.obsRender?.configuration ?? null : null;
          const previousStream = samples.at(-1)?.streams.find((item) =>
            item.member === stream.member && item.direction === stream.direction);
          const countersReset = previousStream !== undefined && [
            [stream.sourceFrames, previousStream.sourceFrames], [stream.playbackFrames, previousStream.playbackFrames],
            [stream.playbackDrops, previousStream.playbackDrops],
            [stream.nativeInput?.receivedFrames ?? null, previousStream.nativeInput?.receivedFrames ?? null],
            [stream.nativeInput?.submittedFrames ?? null, previousStream.nativeInput?.submittedFrames ?? null],
            [stream.nativeInput?.backpressureDroppedFrames ?? null,
              previousStream.nativeInput?.backpressureDroppedFrames ?? null],
            ...(stream.direction === '发送' && exported.nativeVideoSessionMatched ? [
              [exported.native?.framesReceived ?? null, samples.at(-1)?.native?.framesReceived ?? null],
              [exported.native?.framesProcessed ?? null, samples.at(-1)?.native?.framesProcessed ?? null],
            ] : []),
            ...stream.layers.map((layer) => [layer.frameCount,
              previousStream.layers.find((item) => item.layer === layer.layer)?.frameCount ?? null]),
          ].some(([current, prior]) => typeof current === 'number' && typeof prior === 'number' && current < prior);
          let segmentReason = previousSegment ? 'continuation' : 'initial';
          if (previousSegment) {
            if (currentSampleIndex - previousSegment.lastSampleIndex > 1) segmentReason = 'sampling-gap';
            else if (previousSegment.sessionKey !== observed.sessionKey) segmentReason = 'source-change';
            else if (previousSegment.quality !== quality) segmentReason = 'quality-change';
            else if (previousSegment.dimensions !== dimensions) segmentReason = 'dimensions-change';
            else if (previousSegment.renderConfiguration !== null && renderConfiguration !== null
                && previousSegment.renderConfiguration !== renderConfiguration) segmentReason = 'render-configuration-change';
            else if (countersReset) segmentReason = 'counter-reset';
          }
          const startsNewSegment = !previousSegment || segmentReason !== 'continuation';
          const segment = startsNewSegment
            ? { sessionKey: observed.sessionKey, quality, dimensions, renderConfiguration,
              segmentId: `segment-${nextSegmentNumber++}`, lastSampleIndex: currentSampleIndex }
            : previousSegment;
          // 初次缺失的配置可在后续补齐；短暂未知不能抹掉已确认的分段基线。
          segment.renderConfiguration = renderConfiguration ?? segment.renderConfiguration;
          segment.lastSampleIndex = currentSampleIndex;
          streamSegments.set(streamKey, segment);
          if (startsNewSegment) {
            // 首样本建立本段基线；跨边界的差分不能归给新来源或新画质。
            stream.sourceFps = null; stream.sourceIntervalMs = null;
            stream.playbackFps = null; stream.playbackIntervalMs = null;
            stream.nativeInputInterval = null;
            stream.layers = stream.layers.map((layer) => ({ ...layer, fps: null, intervalMs: null,
              bitrateKbps: null, averageEncodeMs: null, receiveLossPercent: null, jitterBufferMs: null }));
            if (stream.direction === '发送') { exported.nativeInterval = null; exported.obsRenderInterval = null; }
          }
          return { ...stream, segmentId: segment.segmentId, segmentReason };
        });
        const sample: DiagnosticSample = { ...exported, streams: reportStreams, requestedSettings,
          elapsedMs: Math.round(monotonicNow - startedMonotonicAt),
          actualIntervalMs: lastSampleMonotonicAt === null ? null : Math.round(monotonicNow - lastSampleMonotonicAt) };
        lastSampleMonotonicAt = monotonicNow;
        const size = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
        if (size > MAX_SAMPLE_BYTES && automaticRecording) {
          error.value = '本次统计过大，已略过；此前记录仍可导出。';
          return;
        }
        if (!automaticRecording && sampleBytes + size > MAX_SAMPLE_BYTES) { stop('limit'); return; }
        sampleBytes += size;
        samples.push(sample); sampleSizes.push(size);
        if (automaticRecording) trimAutomaticSamples(sample.elapsedMs);
        sampleCount.value = samples.length;
        if (!automaticRecording && samples.length >= MAX_SAMPLES) stop('limit');
        void checkpoint();
      }
    } catch { if (!disposed && attempt === generation) error.value = '媒体统计暂时无法读取，记录中可能存在缺口。'; }
    finally { polling = false; }
  }
  function setViewing(enabled: boolean) {
    viewing = enabled;
    updateTimer();
    if (enabled) void poll();
  }
  function start(automatic = false) {
    if (disposed || recording.value || saving.value) return;
    if (!automatic && !options.room()) { error.value = '请先加入语音，再开始记录。'; return; }
    if (!automatic && polling) { error.value = '统计仍在读取，请稍后再开始。'; return; }
    generation++;
    sampler = createMediaDiagnosticsSampler();
    // 自动开关恢复时保留此前记录；手动开始仍明确替换上次记录。
    if (!automatic || !startedAt) {
      aliases.clear(); samples = []; sampleCount.value = 0; nextSegmentNumber = 1;
      sampleBytes = 0; sampleSizes = []; sampleSequence = 0; discardedSamples.value = 0;
      savedSizeBytes.value = null;
      startSettings = readSettings(); startedAt = new Date().toISOString(); startedMonotonicAt = performance.now();
      lastCheckpointAt = -Infinity;
    }
    automaticRecording = automatic;
    streamSegments.clear(); endSettings = null; endedAt = null; lastSampleMonotonicAt = null;
    reason.value = ''; error.value = ''; recording.value = true;
    updateTimer();
    void poll();
  }

  function setAutomatic(enabled: boolean) {
    if (disposed || saving.value) return;
    automaticEnabled.value = enabled;
    if (enabled) {
      if (recording.value) automaticRecording = true;
      else start(true);
    } else stop('automaticDisabled');
    try { localStorage.setItem(AUTOMATIC_DIAGNOSTICS_KEY, String(enabled)); }
    catch { error.value = '本次自动诊断选择已生效，但无法保存；下次启动请检查开关。'; }
  }

  function createReport(notes: string) {
    const exportedSamples = samples.slice();
    if (discardedSamples.value && exportedSamples.length) {
      // 保留窗口外的基线不可冒充窗口内区间；导出副本不影响继续采样。
      const first = exportedSamples[0];
      exportedSamples[0] = { ...first, actualIntervalMs: null, nativeInterval: null, obsRenderInterval: null,
        streams: first.streams.map((stream) => ({ ...stream, segmentReason: 'retained-window',
          sourceFps: null, sourceIntervalMs: null, playbackFps: null, playbackIntervalMs: null, nativeInputInterval: null,
          layers: stream.layers.map((layer) => ({ ...layer, fps: null, intervalMs: null, bitrateKbps: null,
            averageEncodeMs: null, receiveLossPercent: null, jitterBufferMs: null })) })) };
      for (let index = 0; index < exportedSamples.length; index++) {
        exportedSamples[index] = { ...exportedSamples[index], elapsedMs: exportedSamples[index].elapsedMs - first.elapsedMs };
      }
    }
    const report = { kind: 'lycansync-diagnostics', schemaVersion: 9,
      startedAt: discardedSamples.value && exportedSamples.length ? exportedSamples[0].time : startedAt ?? new Date().toISOString(),
      endedAt: endedAt ?? new Date().toISOString(),
      stopReason: recording.value && automaticRecording ? 'automaticSnapshot' : reason.value || 'automaticEvents',
      recordingMode: automaticRecording ? 'automatic' : 'manual',
      retention: { maxSamples: MAX_SAMPLES, maxDurationMs: MAX_DURATION_MS, maxSampleBytes: MAX_SAMPLE_BYTES,
        discardedSamples: discardedSamples.value },
      sampleIntervalMs: SAMPLE_INTERVAL_MS, notes: notes.slice(0, 2000),
      startSettings: discardedSamples.value && exportedSamples.length ? exportedSamples[0].requestedSettings : startSettings,
      endSettings: recording.value ? readSettings() : endSettings, samples: exportedSamples,
      summary: { segments: summarizeSegments(exportedSamples, packageInfo.version, Boolean(window.lycanDesktop)), limitations: [
        '各阶段统计窗口来源不同，不能直接相减计算全链路丢帧率。FPS 仅描述视频链路，不代表游戏 FPS 或每帧画面内容均不同。',
        '摘要按单个轨道和画质分段计算；首样本仅建立基线，缺失值和等待统计不计为零。',
        '明确暂停及恢复边界区间不计入摘要帧率和页面背压比例；正常运行时的零帧仍计入，原始样本保留暂停区间。',
      ] },
      runtime: { clientVersion: packageInfo.version, desktop: Boolean(window.lycanDesktop),
        microphonePipeline: window.lycanDesktop ? 'WASAPI + Sonora' : 'Chromium + browser processor' },
      measurements: {
        fps: 'counter-delta-divided-by-monotonic-elapsed-time; first-or-reset-sample-is-null',
        process: { scope: 'electron-and-owned-native-processes', memoryUnit: 'MiB',
          memoryMb: 'electron-only-sum-working-set', nativeMemory: 'GetProcessMemoryInfo; private-commit-not-resident',
          sharedPagesMayBeCountedMoreThanOnce: true, includesGpuMemory: false, includesNativeCpu: false },
        native: { scope: 'current-or-last-capture-snapshot', stateDeterminesWhetherCaptureIsRunning: true },
        nativeInterval: { scope: 'running-helper-samples', counters: ['framesReceived', 'framesProcessed'] },
        obsRender: { scope: 'running-configuration-only', warmupMs: 2000,
          intervalFps: '(delta-totalFrames-minus-delta-laggedFrames)/native-monotonic-seconds',
          averages: 'OBS approximately-one-second-rolling-render-loop; not-source-or-encoder-latency' },
        nativeInput: { scope: 'current-track-session', firstFrameMs: 'start-request-to-first-real-frame-submitted',
          completedWrites: 'all-real-and-placeholder-writes-resolved-not-network-delivered',
          placeholderFrames: 'excluded-from-real-frame-submissions' },
        layerActive: 'outbound-rtp-active-or-matching-sender-encoding',
        remoteParticipantCount: 'room-members-not-viewers',
        network: { roundTripMs: 'new-rtcp-receiver-report-client-to-sfu-not-end-to-end',
          receiverReportedLossPercent: 'new-rtcp-report-fractionLost-not-local-sample-interval',
          receiveLossPercent: 'interval-lost-divided-by-received-plus-lost; reset-or-late-recovery-is-null',
          jitterBufferMs: 'interval-buffer-delay-divided-by-emitted-frames-not-end-to-end',
          feedbackAgeMs: 'local-stats-timestamp-minus-last-receiver-report-timestamp' },
        powerEfficientEncoder: 'browser-reported-hint-not-proof-of-hardware-encoding',
      },
      limitations: ['null表示未取得；轨道目标不等于实测；统计不包含端到端延迟或GPU利用率',
        '网络统计只描述本机与SFU的一段；RTT不能除以二冒充端到端延迟；接收缓冲等待不含完整解码与显示耗时',
        '节能编码标志是浏览器提供的线索，不单独证明硬件编码；旧接收报告保留年龄，不重复计为新反馈',
        '仅记录当前客户端；CPU与memoryMb汇总仅含Electron，entries分列Electron与已启动的原生进程内存；不含原生CPU和显存。工作集可能重复计算共享页，私有提交不等于驻留RAM，不代表整机物理内存占用',
        '后台采样可能被系统节流；各采样窗口不同，不能直接相减计算丢帧率；自动记录滚动保留最近30分钟且不超过900份/6MiB，手动记录达到上限停止；最多32名成员',
        '远端人数不等于观看人数；编码层启用不等于实际发送，无观看者且无有效码率时不能只凭bandwidth标签判断网络故障',
        'helper版本与采集后端以各样本为准；停止后原生统计可保留最后快照，以state判断是否仍在采集',
        '页面背压与原生限帧丢弃分别计数，写入完成不代表远端收到',
        window.lycanDesktop
          ? '详细采样按约15秒间隔保存在安装目录；正常关闭补存，异常退出可能丢失最后一个保存间隔；重开后可导出上次报告'
          : '记录仅保留在当前登录页面内存；退出或关闭应用前请主动导出'] };
    return report;
  }

  function hasUsage(sample: DiagnosticSample) {
    return sample.roomState !== null && sample.roomState !== 'disconnected'
      || sample.streams.length > 0 || sample.audio.length > 0 || sample.failures.length > 0;
  }

  async function refreshSavedReport() {
    const bridge = window.lycanDesktop;
    if (!bridge?.getSavedDiagnosticReport) return;
    const attempt = savedReportGeneration;
    try {
      const value = await bridge.getSavedDiagnosticReport();
      if (!disposed && attempt === savedReportGeneration) savedReport.value = value;
    } catch {
      if (!disposed && attempt === savedReportGeneration) persistenceError.value = '无法读取已保存报告，可关闭自动记录后清除详细报告再重试。';
    }
  }

  async function checkpoint(force = false): Promise<void> {
    const bridge = window.lycanDesktop;
    if (!bridge?.saveDiagnosticSnapshot || !startedAt || !samples.length
        || (force ? !samples.some(hasUsage) : !hasUsage(samples[samples.length - 1]))) return;
    if (checkpointPromise) {
      if (force) { await checkpointPromise; return checkpoint(true); }
      return;
    }
    if (!force && performance.now() - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = performance.now();
    const text = JSON.stringify(createReport(''));
    checkpointPromise = bridge.saveDiagnosticSnapshot(text)
      .then(async (bytes) => {
        if (disposed || bytes === null) return;
        savedSizeBytes.value = bytes;
        persistenceError.value = '';
        if (!savedReportRefreshedAfterCheckpoint) {
          await refreshSavedReport(); savedReportRefreshedAfterCheckpoint = true;
        }
      })
      .catch(() => { if (!disposed) persistenceError.value = '详细报告自动保存失败，当前内存记录仍可导出；请检查安装目录空间和写入权限。'; })
      .finally(() => { checkpointPromise = null; });
    await checkpointPromise;
  }

  async function flush() {
    if (recording.value) await stop('closed');
    else await checkpoint(true);
  }

  async function savePrevious() {
    const bridge = window.lycanDesktop;
    if (!bridge || disposed || saving.value) return;
    saving.value = true; error.value = '';
    try { await bridge.exportSavedDiagnosticReport(notes.value.slice(0, 2000)); }
    catch { if (!disposed) error.value = '无法导出上次使用报告，请检查保存位置后重试。'; }
    finally { saving.value = false; }
  }

  async function clearSaved() {
    const bridge = window.lycanDesktop;
    if (!bridge || disposed || saving.value || recording.value) return;
    saving.value = true; error.value = '';
    generation++;
    savedReportGeneration++;
    try {
      await checkpointPromise;
      await bridge.clearSavedDiagnosticReports();
      if (disposed) return;
      aliases.clear(); streamSegments.clear(); samples = []; sampleSizes = []; sampleBytes = 0;
      sampleSequence = 0; nextSegmentNumber = 1; sampleCount.value = 0; discardedSamples.value = 0;
      startedAt = null; endedAt = null; startSettings = null; endSettings = null; lastSampleMonotonicAt = null;
      savedReport.value = null; persistenceError.value = ''; reason.value = ''; notes.value = '';
      savedSizeBytes.value = null;
      latest.value = null;
      savedReportRefreshedAfterCheckpoint = false;
      lastCheckpointAt = -Infinity;
      sampler = createMediaDiagnosticsSampler();
    } catch { if (!disposed) error.value = '无法清除详细报告，请检查安装目录写入权限后重试。'; }
    finally { saving.value = false; }
  }

  async function save(notes: string) {
    if (disposed || saving.value || (recording.value && !automaticRecording) || (!startedAt && !window.lycanDesktop)) return;
    saving.value = true; error.value = '';
    try {
      const text = JSON.stringify(createReport(notes));
      if (window.lycanDesktop) await window.lycanDesktop.exportDiagnosticReport(text);
      else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'LycanSync-diagnostics.json';
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch { if (!disposed) error.value = '无法导出诊断报告，请检查保存位置后重试。'; }
    finally { saving.value = false; }
  }
  watch(options.room, () => {
    if (!automaticEnabled.value) stop('roomChanged');
    else void checkpoint(true);
    generation++; latest.value = null; sampler = createMediaDiagnosticsSampler(); streamSegments.clear();
    if (automaticEnabled.value) void poll();
  }, { flush: 'sync' });
  try {
    const stored = localStorage.getItem(AUTOMATIC_DIAGNOSTICS_KEY);
    if (stored !== null && stored !== 'true' && stored !== 'false') throw new Error('invalidAutomaticDiagnosticsPreference');
    automaticEnabled.value = stored === null ? options.automaticDefault ?? Boolean(window.lycanDesktop) : stored === 'true';
  } catch { error.value = '无法读取自动诊断设置，已暂停自动记录；可手动开启。'; }
  if (automaticEnabled.value) start(true);
  void refreshSavedReport();
  onScopeDispose(() => { stop('closed'); disposed = true; generation++; if (timer) clearInterval(timer); });
  return { latest, recording, automaticEnabled, discardedSamples, sampleCount, reason, error, saving, notes,
    savedReport, savedSizeBytes, persistenceError, setViewing, setAutomatic, start, stop, save, savePrevious, clearSaved, flush };
}

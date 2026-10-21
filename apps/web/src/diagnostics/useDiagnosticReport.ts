import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { Participant, Room } from 'livekit-client';
import { createMediaDiagnosticsSampler, type MediaDiagnosticsSnapshot } from './mediaDiagnostics';
import packageInfo from '../../package.json';
import { SCREEN_SHARE_QUALITIES, screenShareQuality, type CustomScreenShareQuality } from '../rtc/screenShareQuality';

const SAMPLE_INTERVAL_MS = 2_000;
const MAX_SAMPLES = 900;
const MAX_DURATION_MS = 30 * 60_000;
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;
type DiagnosticSettings = { quality: string; customQuality?: CustomScreenShareQuality;
  inputGain: number; outputVolume: number; screenShareVolume: number;
  voiceVolumeBalance: boolean;
  noiseSuppression: boolean; autoGainControl: boolean; voiceEnhancement: boolean; echoCancellation: boolean;
  stageCount: number; focused: boolean };
type ReportSettings = DiagnosticSettings & { bitrateMode: 'recommended' | 'manual' | null;
  preset: { width: number; height: number; maxFrameRate: number; maxBitrate: number } | null };

function numeric(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function label(value: unknown) {
  return typeof value === 'string' && /^[\w .()+-]{1,120}$/.test(value) ? value : null;
}
function errorCode(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(value) ? value : null;
}

type DiagnosticSample = ReturnType<typeof diagnosticReportSample> & { requestedSettings: ReportSettings;
  elapsedMs: number; actualIntervalMs: number | null;
  streams: (ReturnType<typeof diagnosticReportSample>['streams'][number] & { segmentId: string; segmentReason: string })[] };

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
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
    const layerIds = [...new Set(entries.flatMap(({ stream }) => stream.layers.map((layer) => layer.layer)))];
    const layers = layerIds.map((layer) => {
      const matching = entries.flatMap(({ stream }) => stream.layers.filter((item) => item.layer === layer));
      const active = matching.find((item) => item.active !== null)?.active ?? null;
      const values = comparableEntries.flatMap(({ stream }) => stream.layers.filter((item) => item.layer === layer && item.active !== false)
        .map((item) => item.fps).filter((value): value is number => value !== null));
      return { layer, active, size: matching.find((item) => item.size !== '未知')?.size ?? null,
        typicalFps: median(values), validSamples: values.length };
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
        ? `编码层 FPS 分别记录为 ${layers.map((layer) => `第 ${layer.layer} 层 ${layer.typicalFps ?? '等待统计'}`).join('、')}，不跨层相加。` : null,
      median(playbackFps) !== null ? `本机显示约 ${median(playbackFps)} FPS。` : null,
      median(nativeCaptureFps) !== null ? `${native?.captureBackend === 'obsLibobs' ? 'OBS 渲染回调' : '原生采集收到'}约 ${median(nativeCaptureFps)} FPS。` : null,
      median(nativeProcessedFps) !== null ? `${native?.captureBackend === 'obsLibobs' ? 'OBS 宿主发出共享纹理帧' : '原生采集处理'}约 ${median(nativeProcessedFps)} FPS。` : null,
      obsBridgeDroppedFrames !== null ? `记录期间 OBS 共享纹理槽位累计丢帧 ${obsBridgeDroppedFrames}。` : null,
      totalBackpressureDrops > 0 ? `页面背压期间累计丢弃 ${totalBackpressureDrops} 帧（占收到真实帧 ${totalReceived > 0
        ? `${Math.round(totalBackpressureDrops / totalReceived * 10_000) / 100}%` : '比例待统计'}）。` : null,
    ].filter((value): value is string => value !== null);
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
      observations, warnings: [...warnings],
    };
  });
}

/** 导出只挑选统计字段，不能序列化原始SDK报告、来源对象、昵称或会话标识。 */
export function diagnosticReportSample(snapshot: MediaDiagnosticsSnapshot, aliases: Map<string, string>) {
  const alias = (identity: string) => {
    if (!aliases.has(identity)) aliases.set(identity, `member-${aliases.size + 1}`);
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
    omittedParticipants: snapshot.omittedParticipants, process: snapshot.process && {
      cpuPercent: numeric(snapshot.process.cpuPercent), memoryMb: numeric(snapshot.process.memoryMb),
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
      rawCaptureFps: numeric(native.rawCaptureFps), videoOutputFps: numeric(native.videoOutputFps),
      videoOutputDroppedFrames: numeric(native.videoOutputDroppedFrames), framesReceived: numeric(native.framesReceived),
      framesProcessed: numeric(native.framesProcessed), droppedNotifications: numeric(native.droppedNotifications),
      obsBridgeDroppedFrames: numeric(native.obsBridgeDroppedFrames),
      rawFrameIntervalP50Ms: numeric(native.rawFrameIntervalP50Ms), rawFrameIntervalP95Ms: numeric(native.rawFrameIntervalP95Ms),
      rawFrameIntervalP99Ms: numeric(native.rawFrameIntervalP99Ms), rawTimestampAnomalies: numeric(native.rawTimestampAnomalies),
      lastFrameAgeMs: numeric(native.lastFrameAgeMs), stopDurationMs: numeric(native.stopDurationMs),
      captureSuspended: native.captureSuspended, lastCaptureError: errorCode(native.lastCaptureError),
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
}) {
  const latest = shallowRef<MediaDiagnosticsSnapshot | null>(null);
  const recording = ref(false);
  const sampleCount = ref(0);
  const reason = ref('');
  const error = ref('');
  const saving = ref(false);
  const notes = ref('');
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
  let startSettings: ReportSettings | null = null;
  let endSettings: ReportSettings | null = null;
  let startedMonotonicAt = 0;
  let lastSampleMonotonicAt: number | null = null;
  let nextSegmentNumber = 1;
  const streamSegments = new Map<string, { sessionKey: string | null; quality: string; dimensions: string;
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
  function stop(stopReason = 'user') {
    if (!recording.value) return;
    generation++;
    recording.value = false;
    endedAt = new Date().toISOString();
    endSettings = readSettings();
    reason.value = stopReason;
    updateTimer();
  }
  async function poll() {
    if (disposed) return;
    if (recording.value && startedAt && Date.now() - Date.parse(startedAt) >= MAX_DURATION_MS) stop('limit');
    const room = options.room();
    if (polling || !room || (!recording.value && (!viewing || document.hidden))) return;
    polling = true;
    const attempt = generation;
    const requestedSettings = readSettings();
    try {
      const snapshot = await sampler.collect(room, options.participants());
      if (disposed || attempt !== generation || room !== options.room()) return;
      latest.value = snapshot;
      if (recording.value) {
        const monotonicNow = performance.now();
        const currentSampleIndex = samples.length;
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
          const previousStream = samples[currentSampleIndex - 1]?.streams.find((item) =>
            item.member === stream.member && item.direction === stream.direction);
          const countersReset = previousStream !== undefined && [
            [stream.sourceFrames, previousStream.sourceFrames], [stream.playbackFrames, previousStream.playbackFrames],
            [stream.playbackDrops, previousStream.playbackDrops],
            [stream.nativeInput?.receivedFrames ?? null, previousStream.nativeInput?.receivedFrames ?? null],
            [stream.nativeInput?.submittedFrames ?? null, previousStream.nativeInput?.submittedFrames ?? null],
            [stream.nativeInput?.backpressureDroppedFrames ?? null,
              previousStream.nativeInput?.backpressureDroppedFrames ?? null],
            ...(stream.direction === '发送' && exported.nativeVideoSessionMatched ? [
              [exported.native?.framesReceived ?? null, samples[currentSampleIndex - 1]?.native?.framesReceived ?? null],
              [exported.native?.framesProcessed ?? null, samples[currentSampleIndex - 1]?.native?.framesProcessed ?? null],
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
            else if (countersReset) segmentReason = 'counter-reset';
          }
          const startsNewSegment = !previousSegment || segmentReason !== 'continuation';
          const segment = startsNewSegment
            ? { sessionKey: observed.sessionKey, quality, dimensions,
              segmentId: `segment-${nextSegmentNumber++}`, lastSampleIndex: currentSampleIndex }
            : previousSegment;
          segment.lastSampleIndex = currentSampleIndex;
          streamSegments.set(streamKey, segment);
          if (startsNewSegment) {
            // 首样本建立本段基线；跨边界的差分不能归给新来源或新画质。
            stream.sourceFps = null; stream.sourceIntervalMs = null;
            stream.playbackFps = null; stream.playbackIntervalMs = null;
            stream.nativeInputInterval = null;
            stream.layers = stream.layers.map((layer) => ({ ...layer, fps: null, intervalMs: null,
              bitrateKbps: null, averageEncodeMs: null }));
            if (stream.direction === '发送') exported.nativeInterval = null;
          }
          return { ...stream, segmentId: segment.segmentId, segmentReason };
        });
        const sample: DiagnosticSample = { ...exported, streams: reportStreams, requestedSettings,
          elapsedMs: Math.round(monotonicNow - startedMonotonicAt),
          actualIntervalMs: lastSampleMonotonicAt === null ? null : Math.round(monotonicNow - lastSampleMonotonicAt) };
        lastSampleMonotonicAt = monotonicNow;
        const size = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
        if (sampleBytes + size > MAX_SAMPLE_BYTES) { stop('limit'); return; }
        sampleBytes += size;
        samples.push(sample);
        sampleCount.value = samples.length;
        if (samples.length >= MAX_SAMPLES) stop('limit');
      }
    } catch { if (!disposed && attempt === generation) error.value = '媒体统计暂时无法读取，记录中可能存在缺口。'; }
    finally { polling = false; }
  }
  function setViewing(enabled: boolean) {
    viewing = enabled;
    updateTimer();
    if (enabled) void poll();
  }
  function start() {
    if (disposed || recording.value || saving.value) return;
    if (!options.room()) { error.value = '请先加入语音，再开始记录。'; return; }
    if (polling) { error.value = '统计仍在读取，请稍后再开始。'; return; }
    generation++;
    sampler = createMediaDiagnosticsSampler();
    aliases.clear(); samples = []; sampleCount.value = 0; streamSegments.clear(); nextSegmentNumber = 1;
    sampleBytes = 0; startSettings = readSettings(); endSettings = null;
    startedAt = new Date().toISOString(); endedAt = null;
    startedMonotonicAt = performance.now(); lastSampleMonotonicAt = null;
    reason.value = ''; error.value = ''; recording.value = true;
    updateTimer();
    void poll();
  }
  async function save(notes: string) {
    if (disposed || saving.value || recording.value || !startedAt) return;
    saving.value = true; error.value = '';
    const report = { kind: 'lycansync-diagnostics', schemaVersion: 4, startedAt, endedAt, stopReason: reason.value,
      sampleIntervalMs: SAMPLE_INTERVAL_MS, notes: notes.slice(0, 2000), startSettings, endSettings, samples,
      summary: { segments: summarizeSegments(samples, packageInfo.version, Boolean(window.lycanDesktop)), limitations: [
        '各阶段统计窗口来源不同，不能直接相减计算全链路丢帧率。FPS 仅描述视频链路，不代表游戏 FPS 或每帧画面内容均不同。',
        '摘要按单个轨道和画质分段计算；首样本仅建立基线，缺失值和等待统计不计为零。',
        '明确暂停及恢复边界区间不计入摘要帧率和页面背压比例；正常运行时的零帧仍计入，原始样本保留暂停区间。',
      ] },
      runtime: { clientVersion: packageInfo.version, desktop: Boolean(window.lycanDesktop),
        microphonePipeline: window.lycanDesktop ? 'WASAPI + Sonora' : 'Chromium + browser processor' },
      measurements: {
        fps: 'counter-delta-divided-by-monotonic-elapsed-time; first-or-reset-sample-is-null',
        process: { scope: 'electron-app-metrics', memory: 'sum-working-set', includesNativeHelpers: false,
          sharedPagesMayBeCountedMoreThanOnce: true },
        native: { scope: 'current-or-last-capture-snapshot', stateDeterminesWhetherCaptureIsRunning: true },
        nativeInterval: { scope: 'running-helper-samples', counters: ['framesReceived', 'framesProcessed'] },
        nativeInput: { scope: 'current-track-session', firstFrameMs: 'start-request-to-first-real-frame-submitted',
          completedWrites: 'all-real-and-placeholder-writes-resolved-not-network-delivered',
          placeholderFrames: 'excluded-from-real-frame-submissions' },
        layerActive: 'outbound-rtp-active-or-matching-sender-encoding',
        remoteParticipantCount: 'room-members-not-viewers',
      },
      limitations: ['null表示未取得；轨道目标不等于实测；统计不包含端到端延迟或GPU利用率',
        '仅记录当前客户端；CPU/内存为Electron进程统计，不含原生helper；工作集合计可能重复计算共享页，不代表整机物理内存占用',
        '后台采样可能被系统节流；各采样窗口不同，不能直接相减计算丢帧率；每次最多30分钟/900份/6MiB，最多32名成员',
        '远端人数不等于观看人数；编码层启用不等于实际发送，无观看者且无有效码率时不能只凭bandwidth标签判断网络故障',
        'helper版本与采集后端以各样本为准；停止后原生统计可保留最后快照，以state判断是否仍在采集',
        '页面背压与原生限帧丢弃分别计数，写入完成不代表远端收到',
        '记录仅保留在当前登录页面内存；退出或关闭应用前请主动导出'] };
    try {
      const text = JSON.stringify(report);
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
    stop('roomChanged'); generation++; latest.value = null; sampler = createMediaDiagnosticsSampler();
  }, { flush: 'sync' });
  onScopeDispose(() => { stop('closed'); disposed = true; generation++; if (timer) clearInterval(timer); });
  return { latest, recording, sampleCount, reason, error, saving, notes, setViewing, start, stop, save };
}

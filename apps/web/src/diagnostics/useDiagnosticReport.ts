import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { Participant, Room } from 'livekit-client';
import { createMediaDiagnosticsSampler, type MediaDiagnosticsSnapshot } from './mediaDiagnostics';
import packageInfo from '../../package.json';

const SAMPLE_INTERVAL_MS = 2_000;
const MAX_SAMPLES = 900;
const MAX_DURATION_MS = 30 * 60_000;
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;
type DiagnosticSettings = { quality: string; inputGain: number; outputVolume: number; screenShareVolume: number;
  noiseSuppression: boolean; autoGainControl: boolean; voiceEnhancement: boolean; echoCancellation: boolean;
  stageCount: number; focused: boolean };

function numeric(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function label(value: unknown) {
  return typeof value === 'string' && /^[\w .()+-]{1,120}$/.test(value) ? value : null;
}
function errorCode(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(value) ? value : null;
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
    omittedParticipants: snapshot.omittedParticipants, process: snapshot.process && {
      cpuPercent: numeric(snapshot.process.cpuPercent), memoryMb: numeric(snapshot.process.memoryMb),
    }, failures: snapshot.failures.map(errorCode).filter(Boolean),
    streams: snapshot.streams.map((stream) => ({ member: alias(stream.identity), direction: stream.direction,
      target: stream.target && { resolution: stream.target.resolution, frameRate: numeric(stream.target.frameRate),
        displaySurface: label(stream.target.displaySurface) },
      sourceFps: numeric(stream.sourceFps), playbackFps: numeric(stream.playbackFps), playbackDrops: numeric(stream.playbackDrops),
      layers: stream.layers.map((layer, index) => ({ layer: index + 1, size: layer.size, codec: label(layer.codec),
        fps: numeric(layer.fps), bitrateKbps: numeric(layer.bitrateKbps), encoder: label(layer.encoder),
        limitation: label(layer.limitation), averageEncodeMs: numeric(layer.averageEncodeMs),
        droppedFrames: numeric(layer.droppedFrames), lostPackets: numeric(layer.lostPackets) })),
    })),
    audio: snapshot.audio.map((audio) => ({ member: alias(audio.identity), source: audio.source, direction: audio.direction,
      sampleRate: numeric(audio.sampleRate), channels: numeric(audio.channels), packetsLost: numeric(audio.packetsLost),
      jitterMs: numeric(audio.jitterMs) })),
    native: native && {
      state: native.state, available: native.available, sourceKind: native.sourceKind,
      frameWidth: numeric(native.frameWidth), frameHeight: numeric(native.frameHeight),
      rawCaptureFps: numeric(native.rawCaptureFps), videoOutputFps: numeric(native.videoOutputFps),
      videoOutputDroppedFrames: numeric(native.videoOutputDroppedFrames), framesReceived: numeric(native.framesReceived),
      framesProcessed: numeric(native.framesProcessed), droppedNotifications: numeric(native.droppedNotifications),
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
  let samples: (ReturnType<typeof diagnosticReportSample> & { requestedSettings: DiagnosticSettings })[] = [];
  let sampleBytes = 0;
  let startSettings: DiagnosticSettings | null = null;
  let endSettings: DiagnosticSettings | null = null;
  const aliases = new Map<string, string>();

  function updateTimer() {
    if (!timer && (viewing || recording.value)) timer = setInterval(() => void poll(), SAMPLE_INTERVAL_MS);
    if (timer && !viewing && !recording.value) { clearInterval(timer); timer = undefined; }
  }
  function stop(stopReason = 'user') {
    if (!recording.value) return;
    generation++;
    recording.value = false;
    endedAt = new Date().toISOString();
    endSettings = options.settings();
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
    const requestedSettings = options.settings();
    try {
      const snapshot = await sampler.collect(room, options.participants());
      if (disposed || attempt !== generation || room !== options.room()) return;
      latest.value = snapshot;
      if (recording.value) {
        const sample = { ...diagnosticReportSample(snapshot, aliases), requestedSettings };
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
    aliases.clear(); samples = []; sampleCount.value = 0;
    sampleBytes = 0; startSettings = options.settings(); endSettings = null;
    startedAt = new Date().toISOString(); endedAt = null;
    reason.value = ''; error.value = ''; recording.value = true;
    updateTimer();
    void poll();
  }
  async function save(notes: string) {
    if (disposed || saving.value || recording.value || !startedAt) return;
    saving.value = true; error.value = '';
    const report = { kind: 'lycansync-diagnostics', schemaVersion: 1, startedAt, endedAt, stopReason: reason.value,
      sampleIntervalMs: SAMPLE_INTERVAL_MS, notes: notes.slice(0, 2000), startSettings, endSettings, samples,
      runtime: { clientVersion: packageInfo.version, desktop: Boolean(window.lycanDesktop),
        microphonePipeline: window.lycanDesktop ? 'WASAPI + Sonora' : 'Chromium + browser processor' },
      limitations: ['null表示未取得；轨道目标不等于实测；统计不包含端到端延迟或GPU利用率',
        '仅记录当前客户端；CPU/内存不包含Rust helper，后台采样可能被系统节流；每次最多30分钟/900份/6MiB，最多32名成员',
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

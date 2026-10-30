import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { setNativeScreenRecordingDemand } from '../rtc/nativeScreenVideo';
import { RecordingVoice, type RecordingVoiceTrack } from './recordingVoice';

const messages: Record<string, string> = {
  recordingShareUnavailable: '请先开启自己的画面共享。',
  recordingHardwareEncoderUnavailable: '没有可用的硬件录像编码器，请检查显卡驱动。',
  recordingEncoderStartFailed: '硬件编码器启动失败，请降低共享规格或检查显卡驱动。',
  recordingApplicationAudioUnavailable: '无法单独录入应用声音，请关闭应用声音选项后重试。',
  recordingDiskFull: '录像目录可用空间不足，请腾出空间或更换目录。',
  recordingStopUnconfirmed: '录像保存尚未确认，请先结束共享，再重新录制。',
  recordingHostExited: '录制来源已中断，已写入的文件保留在录像目录。',
  recordingCaptureRateUnavailable: '未能恢复所选采集帧率，请重新共享后再录制。',
  recordingStartTimedOut: '录像启动超时，请结束共享后重试。',
  recordingWriteFailed: '录像写入失败，请检查保存目录和磁盘空间。',
  recordingVoiceUnavailable: '人声录制已中断，录像已停止，已写入的文件会保留。',
};

export function useRecording(options: { track: () => MediaStreamTrack | undefined; canStart: () => boolean;
  voices: (settings: RecordingSettings) => RecordingVoiceTrack[] }) {
  const desktop = window.lycanDesktop;
  const settings = shallowRef<RecordingSettings | null>(null);
  const state = shallowRef<DesktopRecordingStatus>({ holdingResources: false, phase: 'idle', recordingId: null, startedAt: null, bytes: 0,
    error: null, saved: false, continuing: false, applicationAudio: true });
  const notice = ref('');
  const pending = ref(false);
  const changingSource = ref(false);
  let sourceChangeVersion = 0;
  const now = ref(performance.now());
  let elapsedAnchor: { id: string; at: number; seconds: number } | undefined;
  const active = computed(() => changingSource.value || state.value.holdingResources || state.value.continuing || ['starting', 'recording', 'stopping'].includes(state.value.phase));
  const busy = computed(() => changingSource.value || !settings.value || pending.value || (state.value.holdingResources && state.value.phase === 'failed') || state.value.continuing || ['starting', 'stopping'].includes(state.value.phase));
  const elapsed = computed(() => {
    const seconds = elapsedAnchor?.id === state.value.recordingId
      ? Math.max(0, Math.floor(elapsedAnchor.seconds + (now.value - elapsedAnchor.at) / 1000)) : 0;
    const hours = Math.floor(seconds / 3600);
    return (hours ? hours + ':' : '') + `${(Math.floor(seconds / 60) % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  });
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let demandTrack: MediaStreamTrack | undefined;
  let voice: RecordingVoice | undefined;
  let stateRevision = 0;
  let refreshing = false;
  const setState = (next: DesktopRecordingStatus) => {
    if (disposed) return;
    stateRevision++;
    if (next.recordingId && next.startedAt !== null && elapsedAnchor?.id !== next.recordingId) {
      now.value = performance.now();
      elapsedAnchor = { id: next.recordingId, at: now.value, seconds: Math.max(0, (Date.now() - next.startedAt) / 1000) };
    }
    state.value = next;
    if (next.error) notice.value = messages[next.error] ?? '录制未完成，请检查录像目录和诊断记录。';
  };
  const removeListener = desktop?.onRecordingState(setState);
  async function refresh() {
    if (!desktop || refreshing) return;
    refreshing = true;
    const version = stateRevision;
    try { const next = await desktop.getRecordingStatus(); if (version === stateRevision) setState(next); }
    catch { if (!disposed) notice.value = '暂时无法读取录制状态。'; }
    finally { refreshing = false; }
  }
  async function load() {
    if (!desktop) return;
    try { const next = await desktop.getRecordingSettings(); if (!disposed) settings.value = next; await refresh(); }
    catch { if (!disposed) notice.value = '无法读取录制设置，请检查安装目录的读写权限。'; }
  }
  async function configure(patch: Partial<Omit<RecordingSettings, 'directory'>>) {
    if (!desktop || !settings.value || active.value || busy.value) return;
    pending.value = true; notice.value = '';
    try {
      const value = { ...settings.value, ...patch };
      settings.value = await desktop.configureRecording({ applicationAudio: value.applicationAudio,
        microphone: value.microphone, friends: value.friends });
    } catch { notice.value = '录制设置未能保存，请重试。'; }
    finally { pending.value = false; }
  }
  async function chooseDirectory() {
    if (!desktop || active.value || busy.value) return;
    pending.value = true;
    try { settings.value = await desktop.chooseRecordingDirectory(); }
    catch { notice.value = '保存目录未能修改，请重试。'; }
    finally { pending.value = false; }
  }
  async function start() {
    if (!desktop || busy.value || active.value || !options.canStart()) return;
    const track = options.track();
    if (!track) { notice.value = messages.recordingShareUnavailable; return; }
    pending.value = true; notice.value = '';
    try {
      demandTrack = track;
      await setNativeScreenRecordingDemand(track, true);
      if (disposed || options.track() !== track || !options.canStart()) return;
      const next = await desktop.startRecording();
      if (disposed) { await desktop.stopRecording(next.recordingId); return; }
      setState(next);
    } catch (error) {
      const code = error instanceof Error ? error.message.match(/(?:^|: )([a-zA-Z]+)$/)?.[1] : undefined;
      if (!disposed && code !== 'recordingCancelled') notice.value = messages[code ?? ''] ?? '录制未能开始，请查看诊断记录。';
    } finally {
      pending.value = false;
      if (!active.value && demandTrack) {
        void setNativeScreenRecordingDemand(demandTrack, false); demandTrack = undefined;
      }
    }
  }
  async function stopCurrent() {
    if (!desktop || !state.value.recordingId) return true;
    notice.value = '';
    try { setState(await desktop.stopRecording(state.value.recordingId)); return !state.value.error; }
    catch { notice.value = messages.recordingStopUnconfirmed; return false; }
  }
  async function stop() {
    sourceChangeVersion++;
    await stopCurrent();
  }
  async function withSourceChange(change: (beforeChange: () => Promise<void>) => Promise<boolean>) {
    const version = ++sourceChangeVersion;
    let resume = false;
    try {
      const changed = await change(async () => {
        if (state.value.phase !== 'recording') return;
        resume = true; changingSource.value = true;
        if (!await stopCurrent()) throw new Error('recordingStopUnconfirmed');
      });
      changingSource.value = false;
      if (resume && changed && version === sourceChangeVersion && !disposed) await start();
      return changed;
    } finally { changingSource.value = false; }
  }
  async function reveal() {
    try { await desktop?.revealRecording(); }
    catch { notice.value = '无法打开录像目录，请检查目录是否仍存在。'; }
  }
  watch(active, (value) => {
    if (timer) clearInterval(timer);
    let ticks = 0;
    if (value) timer = setInterval(() => {
      now.value = performance.now();
      // 时长每秒更新，文件状态仍低频读取；慢磁盘不能叠加未完成的查询。
      if (++ticks % 2 === 0) void refresh();
    }, 1000);
    else if (demandTrack) {
      void setNativeScreenRecordingDemand(demandTrack, false); demandTrack = undefined;
    }
  });
  watch(options.track, track => {
    if (!track || !active.value || track === demandTrack) return;
    const previous = demandTrack; demandTrack = track;
    if (previous) void setNativeScreenRecordingDemand(previous, false);
    void setNativeScreenRecordingDemand(track, true).catch(() => {
      notice.value = messages.recordingCaptureRateUnavailable; void stop();
    });
  });
  watch(() => desktop && settings.value && (settings.value.microphone || settings.value.friends)
    && ['starting', 'recording'].includes(state.value.phase) ? state.value.recordingId : null, (id, _, onCleanup) => {
    if (!id || !desktop) return;
    const graph = new RecordingVoice(id, (recordingId, position, pcm) => desktop.sendRecordingVoice(recordingId, position, pcm),
      () => { void desktop.failRecordingVoice(id).catch(() => {}); });
    voice = graph;
    void graph.start().then(() => {
      if (voice === graph && settings.value) graph.update(options.voices(settings.value));
    }).catch(() => { if (voice === graph) void desktop.failRecordingVoice(id).catch(() => {}); });
    onCleanup(() => { if (voice === graph) voice = undefined; void graph.stop(); });
  }, { flush: 'sync' });
  watch(() => settings.value ? options.voices(settings.value) : [], tracks => voice?.update(tracks), { flush: 'sync' });
  void load();
  onScopeDispose(() => {
    disposed = true; sourceChangeVersion++; removeListener?.(); if (timer) clearInterval(timer);
    const track = demandTrack;
    const stop = active.value && state.value.recordingId ? desktop?.stopRecording(state.value.recordingId) : undefined;
    void Promise.resolve(stop).catch(() => {}).finally(() => { if (track) void setNativeScreenRecordingDemand(track, false); });
  });
  return { settings, state, notice, active, busy, elapsed, load, configure, chooseDirectory, start, stop, reveal, withSourceChange };
}

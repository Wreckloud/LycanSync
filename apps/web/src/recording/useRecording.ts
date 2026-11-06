import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { setNativeScreenRecordingDemand } from '../rtc/nativeScreenVideo';
import { RecordingVoice, type RecordingVoiceTrack } from './recordingVoice';
import { useNotice } from '../feedback/useNotice';

const messages: Record<string, string> = {
  recordingShareUnavailable: '请先开启自己的画面共享。',
  recordingHardwareEncoderUnavailable: '没有可用的硬件录像编码器，请检查显卡驱动。',
  recordingEncoderStartFailed: '硬件编码器启动失败，请降低本地录制画质或检查显卡驱动。',
  recordingApplicationAudioUnavailable: '无法单独录入应用声音，请关闭应用声音选项后重试。',
  recordingDiskFull: '录像目录可用空间不足，请腾出空间或更换目录。',
  recordingStopUnconfirmed: '本地录制的停止尚未确认，请先结束共享后重试。',
  recordingHostExited: '录制来源已中断，已写入的文件保留在录像目录。',
  recordingCaptureRateUnavailable: '未能恢复所选采集帧率，请重新共享后再录制。',
  recordingStartTimedOut: '录像启动超时，请结束共享后重试。',
  recordingWriteFailed: '录像写入失败，请检查保存目录和磁盘空间。',
  recordingVoiceUnavailable: '人声录制已中断，录像已停止，已写入的文件会保留。',
  recordingLibraryUnavailable: '录像列表未能保存，请检查安装目录的读写权限；已写入的原片仍保留在录像目录。',
  replaySaveUnconfirmed: '回放保存尚未确认，请停止回放后重试。已写入的文件会保留。',
};

export function useRecording(options: { track: () => MediaStreamTrack | undefined; canStart: () => boolean;
  voices: (settings: RecordingSettings) => RecordingVoiceTrack[] }) {
  const desktop = window.lycanDesktop;
  const settings = shallowRef<RecordingSettings | null>(null);
  const state = shallowRef<DesktopRecordingStatus>({ holdingResources: false, phase: 'idle', recordingId: null, startedAt: null, bytes: 0,
    error: null, saved: false, continuing: false, applicationAudio: true });
  const { notice, noticeEvent } = useNotice();
  const noticeTarget = ref<'settings' | 'content' | 'files' | 'recording' | 'replay'>('settings');
  function reportNotice(message: string, target: typeof noticeTarget.value) {
    noticeTarget.value = target;
    notice.value = message;
  }
  const pending = ref(false);
  let replaySavePending = false;
  const successNotice = shallowRef<{ message: string } | null>(null);
  const changingSource = ref(false);
  let sourceChangeVersion = 0;
  const now = ref(performance.now());
  let elapsedAnchor: { id: string; at: number; seconds: number } | undefined;
  const active = computed(() => changingSource.value || state.value.holdingResources || state.value.continuing || ['starting', 'recording', 'stopping'].includes(state.value.phase));
  const replayActive = computed(() => state.value.replay?.holdingResources ?? false);
  const localActive = computed(() => active.value || replayActive.value);
  const busy = computed(() => changingSource.value || !settings.value || pending.value || (state.value.holdingResources && state.value.phase === 'failed')
    || state.value.replay?.holdingResources && ['starting', 'stopping', 'failed'].includes(state.value.replay.phase)
    || state.value.continuing || ['starting', 'stopping'].includes(state.value.phase));
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
  let statusLoaded = false;
  const setState = (next: DesktopRecordingStatus) => {
    if (disposed) return;
    stateRevision++;
    if (next.recordingId && next.startedAt !== null && elapsedAnchor?.id !== next.recordingId) {
      now.value = performance.now();
      elapsedAnchor = { id: next.recordingId, at: now.value, seconds: Math.max(0, (Date.now() - next.startedAt) / 1000) };
    }
    const code = next.error ?? next.replay?.error;
    // 仅提示已确认的新状态，不把初次读取的历史录像当成本次操作成功。
    if (statusLoaded && !code) {
      if (next.phase === 'recording' && state.value.phase !== 'recording') {
        successNotice.value = { message: '已开始录制' };
      } else if (next.saved && (!state.value.saved || next.recordingId !== state.value.recordingId)) {
        successNotice.value = { message: '录像已保存到本地录像' };
      } else if (next.replay?.phase === 'buffering' && state.value.replay?.phase !== 'buffering') {
        successNotice.value = { message: '即时回放已开启' };
      }
      if (next.replay?.lastSavedId && next.replay.lastSavedId !== state.value.replay?.lastSavedId) {
        successNotice.value = { message: next.replay.lastSavedDuringWarmup
          ? '回放已保存；缓存尚在积累，本次保存已有片段。' : '回放已保存到本地录像' };
      }
    }
    const previousCode = state.value.error ?? state.value.replay?.error;
    const errorChanged = code !== previousCode || next.recordingId !== state.value.recordingId
      || next.replay?.id !== state.value.replay?.id;
    statusLoaded = true;
    state.value = next;
    if (code && (errorChanged || !notice.value)) reportNotice(messages[code] ?? '本地录制未完成，请检查录像目录和诊断记录。', next.error ? 'recording' : 'replay');
  };
  const removeListener = desktop?.onRecordingState(setState);
  async function refresh() {
    if (!desktop || refreshing) return;
    refreshing = true;
    const version = stateRevision;
    try { const next = await desktop.getRecordingStatus(); if (version === stateRevision) setState(next); }
    catch { if (!disposed && notice.value !== '暂时无法读取录制状态。') reportNotice('暂时无法读取录制状态。', 'settings'); }
    finally { refreshing = false; }
  }
  async function load() {
    if (!desktop) return;
    try { const next = await desktop.getRecordingSettings(); if (!disposed) settings.value = next; await refresh(); }
    catch { if (!disposed) reportNotice('无法读取录制设置，请检查安装目录的读写权限。', 'settings'); }
  }
  async function configure(patch: Partial<Omit<RecordingSettings, 'directory' | 'replaySeconds'>>) {
    if (!desktop || !settings.value || localActive.value || busy.value) return;
    pending.value = true; notice.value = '';
    try {
      const value = { ...settings.value, ...patch };
      settings.value = await desktop.configureRecording({ applicationAudio: value.applicationAudio,
        microphone: value.microphone, friends: value.friends, videoHeight: value.videoHeight, videoFps: value.videoFps });
    } catch { reportNotice('录制设置未能保存，请重试。', patch.videoHeight !== undefined || patch.videoFps !== undefined ? 'files' : 'content'); }
    finally { pending.value = false; }
  }
  async function chooseDirectory() {
    if (!desktop || localActive.value || busy.value) return;
    pending.value = true; notice.value = '';
    try { settings.value = await desktop.chooseRecordingDirectory(); }
    catch { reportNotice('保存目录未能修改，请重试。', 'files'); }
    finally { pending.value = false; }
  }
  async function startCurrent(previousId?: string) {
    if (!desktop || busy.value || active.value || !options.canStart()) return;
    const track = options.track();
    if (!track) { reportNotice(messages.recordingShareUnavailable, 'recording'); return; }
    pending.value = true; notice.value = '';
    try {
      demandTrack = track;
      await setNativeScreenRecordingDemand(track, true);
      if (disposed || options.track() !== track || !options.canStart()) return;
      const revision = stateRevision;
      const next = await desktop.startRecording(previousId);
      if (disposed) { await desktop.stopRecording(next.recordingId); return; }
      if (revision === stateRevision) setState(next);
    } catch (error) {
      const code = error instanceof Error ? error.message.match(/(?:^|: )([a-zA-Z]+)$/)?.[1] : undefined;
      if (!disposed && code !== 'recordingCancelled') reportNotice(messages[code ?? ''] ?? '录制未能开始，请查看诊断记录。', 'recording');
    } finally {
      pending.value = false;
      if (!localActive.value && demandTrack) {
        void setNativeScreenRecordingDemand(demandTrack, false); demandTrack = undefined;
      }
    }
  }
  async function stopCurrent() {
    if (!desktop || !state.value.recordingId) return true;
    notice.value = '';
    const revision = stateRevision;
    try {
      const next = await desktop.stopRecording(state.value.recordingId);
      if (revision === stateRevision) setState(next);
      return !next.error;
    } catch { reportNotice(messages.recordingStopUnconfirmed, 'recording'); return false; }
  }
  async function stop() {
    sourceChangeVersion++;
    await stopCurrent();
  }
  async function replayAction(action: 'start' | 'save' | 'stop') {
    if (!desktop || (action !== 'stop' && pending.value) || (action === 'start' && (busy.value || replayActive.value || !options.canStart()))) return;
    if (action === 'save' && (replaySavePending || state.value.replay?.phase !== 'buffering' || state.value.replay.saving || state.value.replay.error)) return;
    if (action === 'stop') sourceChangeVersion++;
    if (action === 'save') replaySavePending = true;
    else pending.value = true;
    notice.value = '';
    const revision = stateRevision;
    try {
      if (action === 'start') {
        const track = options.track();
        if (!track) throw new Error('recordingShareUnavailable');
        demandTrack = track;
        await setNativeScreenRecordingDemand(track, true);
        if (disposed || options.track() !== track || !options.canStart()) return;
        const next = await desktop.startReplay();
        if (disposed) { await desktop.stopReplay(); return; }
        if (revision === stateRevision) setState(next);
      } else {
        const next = await (action === 'save' ? desktop.saveReplay() : desktop.stopReplay());
        if (revision === stateRevision) setState(next);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message.match(/(?:^|: )([a-zA-Z]+)$/)?.[1] : undefined;
      if (!disposed && code !== 'recordingCancelled') reportNotice(messages[code ?? ''] ?? '回放操作未完成，请查看诊断记录。', 'replay');
    } finally {
      if (action === 'save') replaySavePending = false;
      else pending.value = false;
      if (!localActive.value && demandTrack) { void setNativeScreenRecordingDemand(demandTrack, false); demandTrack = undefined; }
    }
  }
  async function configureReplay(seconds: number) {
    if (!desktop || localActive.value || busy.value) return;
    pending.value = true; notice.value = '';
    try { settings.value = await desktop.configureReplay(seconds); }
    catch { reportNotice('回放时长未能保存，请重试。', 'replay'); }
    finally { pending.value = false; }
  }
  async function withSourceChange(change: (beforeChange: () => Promise<void>) => Promise<boolean>) {
    const version = ++sourceChangeVersion;
    let resume = false;
    let previousId: string | undefined;
    let resumeReplay = false;
    try {
      const changed = await change(async () => {
        if (state.value.phase !== 'recording' && !replayActive.value) return;
        previousId = state.value.phase === 'recording' ? state.value.recordingId ?? undefined : undefined;
        resumeReplay = replayActive.value;
        resume = Boolean(previousId); changingSource.value = true;
        if (resumeReplay && desktop) setState(await desktop.stopReplay());
        if (resume && !await stopCurrent()) throw new Error('recordingStopUnconfirmed');
      });
      changingSource.value = false;
      if (changed && version === sourceChangeVersion && !disposed) {
        if (resumeReplay) await replayAction('start');
        if (resume) await startCurrent(previousId);
      }
      return changed;
    } finally { changingSource.value = false; }
  }
  async function reveal() {
    notice.value = '';
    try { await desktop?.revealRecording(); }
    catch { reportNotice('无法打开录像目录，请检查目录是否仍存在。', 'files'); }
  }
  watch(localActive, (value) => {
    if (timer) clearInterval(timer);
    let ticks = 0;
    if (value) timer = setInterval(() => {
      if (state.value.phase === 'recording' || state.value.phase === 'stopping') now.value = performance.now();
      // 时长每秒更新，文件状态仍低频读取；慢磁盘不能叠加未完成的查询。
      if (++ticks % 2 === 0) void refresh();
    }, 1000);
    else if (demandTrack) {
      void setNativeScreenRecordingDemand(demandTrack, false); demandTrack = undefined;
    }
  });
  watch(options.track, track => {
    if (!track || !localActive.value || track === demandTrack) return;
    const previous = demandTrack; demandTrack = track;
    if (previous) void setNativeScreenRecordingDemand(previous, false);
    void setNativeScreenRecordingDemand(track, true).catch(() => {
      if (disposed || options.track() !== track || demandTrack !== track) return;
      // 新轨道不能保证本地采集需求时，录像和回放都必须收尾，不能只停文件输出。
      void Promise.allSettled([state.value.holdingResources ? stop() : undefined,
        replayActive.value ? replayAction('stop') : undefined]).then(() => {
        if (!disposed && options.track() === track) reportNotice(messages.recordingCaptureRateUnavailable, 'settings');
      });
    });
  });
  watch(() => desktop && state.value.mediaVoices ? state.value.mediaId : null, (id, _, onCleanup) => {
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
    const cleanups = [active.value && state.value.recordingId ? desktop?.stopRecording(state.value.recordingId) : undefined,
      replayActive.value ? desktop?.stopReplay() : undefined];
    void Promise.allSettled(cleanups).finally(() => { if (track) void setNativeScreenRecordingDemand(track, false); });
  });
  return { settings, state, notice, noticeEvent, noticeTarget, active, localActive, replayActive, successNotice, busy, elapsed, load, configure, chooseDirectory,
    start: () => startCurrent(), stop, reveal, withSourceChange, configureReplay,
    startReplay: () => replayAction('start'), saveReplay: () => replayAction('save'), stopReplay: () => replayAction('stop') };
}

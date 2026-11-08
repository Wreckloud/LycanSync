import { effectScope, nextTick, shallowRef } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { setNativeScreenRecordingDemand } from '../rtc/nativeScreenVideo';
import { useRecording } from './useRecording';

vi.mock('../rtc/nativeScreenVideo', () => ({ setNativeScreenRecordingDemand: vi.fn(async () => {}) }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function fixture() {
  let id = 0;
  let status: DesktopRecordingStatus = { holdingResources: false, phase: 'idle', recordingId: null, startedAt: null, bytes: 0,
    error: null, saved: false, continuing: false, applicationAudio: false };
  let listener: (state: DesktopRecordingStatus) => void = () => {};
  const desktop = {
    getRecordingSettings: vi.fn(async () => ({ directory: 'C:/app/data/recordings', applicationAudio: false, microphone: false, friends: false,
      replaySeconds: 60, videoHeight: 1080, videoFps: 60 })),
    getRecordingStatus: vi.fn(async () => status),
    onRecordingState: (callback: typeof listener) => { listener = callback; return () => {}; },
    startRecording: vi.fn(async () => {
      status = { ...status, holdingResources: true, phase: 'recording', recordingId: `file-${++id}`, startedAt: Date.now(), saved: false };
      listener(status); return status;
    }),
    stopRecording: vi.fn(async () => { status = { ...status, holdingResources: false, phase: 'saved', saved: true }; listener(status); return status; }),
    startReplay: vi.fn(async () => {
      status = { ...status, replay: { id: 'buffer', holdingResources: true, phase: 'buffering', seconds: 60, saving: false, error: null, lastSavedId: null } };
      listener(status); return status;
    }),
    saveReplay: vi.fn(async () => {
      status = { ...status, replay: { ...status.replay!, lastSavedId: `saved-${++id}` } }; listener(status); return status;
    }),
    stopReplay: vi.fn(async () => {
      status = { ...status, replay: { ...status.replay!, id: null, holdingResources: false, phase: 'idle' } }; listener(status); return status;
    }),
  };
  vi.stubGlobal('window', { lycanDesktop: desktop });
  const track = shallowRef({ id: 'original' } as MediaStreamTrack);
  const scope = effectScope();
  const recording = scope.run(() => useRecording({ track: () => track.value, canStart: () => true, voices: () => [] }))!;
  await vi.waitFor(() => expect(recording.busy.value).toBe(false));
  return { recording, desktop, scope, track, publish: (next: DesktopRecordingStatus) => { status = next; listener(next); } };
}

it('开始与保存只在确认新状态后提示，周期快照不重复提示', async () => {
  const f = await fixture();
  try {
    expect(f.recording.successNotice.value).toBeNull();
    await f.recording.start();
    expect(f.recording.successNotice.value?.message).toBe('已开始录制');
    const started = f.recording.successNotice.value;
    f.publish({ ...f.recording.state.value, bytes: 1024 });
    expect(f.recording.successNotice.value).toBe(started);
    await f.recording.stop();
    expect(f.recording.successNotice.value?.message).toBe('录像已保存到本地录像');
    const saved = f.recording.successNotice.value;
    f.publish({ ...f.recording.state.value });
    expect(f.recording.successNotice.value).toBe(saved);
  } finally { f.scope.stop(); }
});

it('回放操作错误归回放，手动重试同一错误重新通知', async () => {
  const f = await fixture();
  try {
    f.desktop.startReplay.mockRejectedValue(new Error('replaySaveUnconfirmed'));
    await f.recording.startReplay();
    expect(f.recording.noticeTarget.value).toBe('replay');
    const first = f.recording.noticeEvent.value;
    expect(first?.message).toContain('回放保存结果尚未确认');
    await f.recording.startReplay();
    expect(f.recording.noticeEvent.value).not.toBe(first);
    expect(f.recording.noticeEvent.value?.message).toBe(first?.message);
  } finally { f.scope.stop(); }
});

it('周期快照保留故障状态但不重复弹通知，新的故障才重新提示', async () => {
  const f = await fixture();
  try {
    const failed = { ...f.recording.state.value, error: 'recordingDiskFull' };
    f.publish(failed);
    expect(f.recording.noticeTarget.value).toBe('recording');
    const event = f.recording.noticeEvent.value;
    f.publish({ ...failed });
    expect(f.recording.noticeEvent.value).toBe(event);
    f.recording.notice.value = '';
    f.publish({ ...failed });
    expect(f.recording.notice.value).toContain('录像目录可用空间不足');
    f.publish({ ...failed, error: null });
    f.publish(failed);
    expect(f.recording.noticeEvent.value).not.toBe(event);
  } finally { f.scope.stop(); }
});

it('来源选择取消不影响当前录像；确认后先保存再换源，换完再开始新段', async () => {
  const f = await fixture();
  try {
    await f.recording.start();
    await f.recording.withSourceChange(async () => false);
    expect(f.desktop.stopRecording).not.toHaveBeenCalled();
    await f.recording.withSourceChange(async before => {
      await before();
      expect(f.recording.active.value).toBe(true);
      expect(f.desktop.stopRecording).toHaveBeenCalledTimes(1);
      f.track.value = { id: 'next' } as MediaStreamTrack;
      await nextTick(); return true;
    });
    expect(f.desktop.startRecording).toHaveBeenCalledTimes(2);
    expect(f.desktop.startRecording).toHaveBeenLastCalledWith('file-1');
    expect(setNativeScreenRecordingDemand).toHaveBeenCalledWith(f.track.value, true);
  } finally { f.scope.stop(); }
});

it('回放保持采集需求，单独停止录像不降低采集，保存确认后给出短提示', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers();
    await f.recording.startReplay(); await nextTick();
    expect(f.recording.replayActive.value).toBe(true);
    expect(f.recording.localActive.value).toBe(true);
    await f.recording.start(); await nextTick();
    vi.mocked(setNativeScreenRecordingDemand).mockClear();
    await f.recording.stop(); await nextTick();
    expect(f.recording.localActive.value).toBe(true);
    expect(setNativeScreenRecordingDemand).not.toHaveBeenCalledWith(f.track.value, false);
    await f.recording.saveReplay();
    expect(f.recording.successNotice.value?.message).toBe('回放已保存到本地录像');
    const savedNotice = f.recording.successNotice.value;
    await f.recording.saveReplay();
    expect(f.recording.successNotice.value).not.toBe(savedNotice);
    expect(f.recording.successNotice.value?.message).toBe('回放已保存到本地录像');
    await f.recording.stopReplay(); await nextTick();
    expect(setNativeScreenRecordingDemand).toHaveBeenCalledWith(f.track.value, false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.scope.stop(); }
});

it('仅开回放也能保存片段，不要求普通录像或偷偷开始录像', async () => {
  const f = await fixture();
  try {
    await f.recording.startReplay();
    await f.recording.saveReplay();
    expect(f.desktop.startRecording).not.toHaveBeenCalled();
    expect(f.desktop.saveReplay).toHaveBeenCalledOnce();
    expect(f.recording.successNotice.value?.message).toBe('回放已保存到本地录像');
    expect(f.recording.active.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('回放启动尚未返回时销毁页面，迟到成功仍归还原生回放资源', async () => {
  const f = await fixture();
  let complete!: (status: DesktopRecordingStatus) => void;
  f.desktop.startReplay.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const starting = f.recording.startReplay();
  await vi.waitFor(() => expect(f.desktop.startReplay).toHaveBeenCalledOnce());
  f.scope.stop();
  complete({ ...f.recording.state.value, replay: { id: 'late', holdingResources: true, phase: 'buffering',
    seconds: 60, saving: false, error: null, lastSavedId: null } });
  await starting;
  expect(f.desktop.stopReplay).toHaveBeenCalledOnce();
  expect(setNativeScreenRecordingDemand).toHaveBeenCalledWith(f.track.value, false);
});

it('回放保存失败不假报成功，已有录像和回放状态保持，错误正文不进入界面', async () => {
  const f = await fixture();
  try {
    await f.recording.startReplay(); await f.recording.start();
    f.recording.successNotice.value = null;
    f.desktop.saveReplay.mockRejectedValueOnce(new Error('replaySaveUnconfirmed'));
    await f.recording.saveReplay();
    expect(f.recording.successNotice.value).toBeNull();
    expect(f.recording.notice.value).toContain('保存结果尚未确认');
    expect(f.recording.active.value).toBe(true);
    expect(f.recording.replayActive.value).toBe(true);
  } finally { f.scope.stop(); }
});

it('保存回放较慢仍可请求关闭，迟到保存结果不能重新显示缓存开启', async () => {
  const f = await fixture();
  try {
    await f.recording.startReplay();
    const old = f.recording.state.value;
    let complete!: (state: DesktopRecordingStatus) => void;
    f.desktop.saveReplay.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const saving = f.recording.saveReplay();
    expect(f.recording.busy.value).toBe(false);
    await f.recording.stopReplay();
    expect(f.desktop.stopReplay).toHaveBeenCalledOnce();
    expect(f.recording.replayActive.value).toBe(false);
    complete(old); await saving;
    expect(f.recording.replayActive.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('更换轨道后恢复采集失败同时停止录像和回放，停止回复不能复活另一输出', async () => {
  const f = await fixture();
  try {
    await f.recording.startReplay(); await f.recording.start();
    vi.mocked(setNativeScreenRecordingDemand).mockImplementationOnce(async () => {});
    vi.mocked(setNativeScreenRecordingDemand).mockRejectedValueOnce(new Error('native unavailable'));
    f.track.value = { id: 'replacement' } as MediaStreamTrack;
    await vi.waitFor(() => expect(f.desktop.stopReplay).toHaveBeenCalledOnce());
    expect(f.desktop.stopRecording).toHaveBeenCalledOnce();
    expect(f.recording.notice.value).toContain('所选帧率');
    expect(f.recording.localActive.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('旧轨道恢复需求的迟到失败，不停止已经替换的新轨道输出', async () => {
  const f = await fixture();
  try {
    await f.recording.startReplay(); await f.recording.start();
    let fail!: (reason: Error) => void;
    vi.mocked(setNativeScreenRecordingDemand).mockImplementationOnce(async () => {});
    vi.mocked(setNativeScreenRecordingDemand).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    f.track.value = { id: 'old-replacement' } as MediaStreamTrack; await nextTick();
    f.track.value = { id: 'current-replacement' } as MediaStreamTrack; await nextTick();
    fail(new Error('old native unavailable')); await nextTick();
    expect(f.desktop.stopReplay).not.toHaveBeenCalled();
    expect(f.desktop.stopRecording).not.toHaveBeenCalled();
    expect(f.recording.localActive.value).toBe(true);
  } finally { f.scope.stop(); }
});

it('回放继续缓存时，已经停止的录像时长不再继续增长', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers();
    let monotonic = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    await f.recording.startReplay(); await f.recording.start(); await nextTick();
    expect(f.recording.elapsed.value).toBe('00:00');
    monotonic = 15_000; await vi.advanceTimersByTimeAsync(1000);
    expect(f.recording.elapsed.value).toBe('00:05');
    await f.recording.stop();
    monotonic = 25_000; await vi.advanceTimersByTimeAsync(1000);
    expect(f.recording.elapsed.value).toBe('00:05');
    expect(f.recording.replayActive.value).toBe(true);
  } finally { f.scope.stop(); }
});

it('换源间隙主动停止，迟到的新画面不能擅自恢复录制', async () => {
  const f = await fixture();
  try {
    await f.recording.start();
    await f.recording.withSourceChange(async before => { await before(); await f.recording.stop(); return true; });
    expect(f.desktop.startRecording).toHaveBeenCalledTimes(1);
    expect(f.recording.active.value).toBe(false);
  } finally { f.scope.stop(); }
});

it('保存未确认时不执行来源替换，也不叠加新的录像', async () => {
  const f = await fixture();
  try {
    await f.recording.start();
    f.desktop.stopRecording.mockRejectedValueOnce(new Error('recordingStopUnconfirmed'));
    const change = vi.fn(async (before: () => Promise<void>) => { await before(); return true; });
    await expect(f.recording.withSourceChange(change)).rejects.toThrow('recordingStopUnconfirmed');
    expect(f.desktop.startRecording).toHaveBeenCalledTimes(1);
  } finally { f.scope.stop(); }
});

it('长时间录像显示小时，系统时间调整不改变时长，停止后移除计时器', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers();
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    await f.recording.start(); await nextTick();
    expect(f.recording.elapsed.value).toBe('00:00');
    vi.setSystemTime(Date.now() + 86_400_000);
    monotonic = 3_661_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.recording.elapsed.value).toBe('1:01:01');
    monotonic = 90_061_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.recording.elapsed.value).toBe('25:01:01');
    await f.recording.stop(); await nextTick();
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.scope.stop(); }
});

it('慢磁盘读取未返回时不叠加查询，结束后停止轮询', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers();
    await f.recording.start(); await nextTick();
    let resolve!: () => void;
    const saved = f.recording.state.value;
    f.desktop.getRecordingStatus.mockImplementationOnce(() => new Promise(done => { resolve = () => done(saved); }));
    const before = f.desktop.getRecordingStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.desktop.getRecordingStatus.mock.calls.length).toBe(before + 1);
    await f.recording.stop(); resolve(); await nextTick();
    expect(f.recording.state.value.phase).toBe('saved');
  } finally { f.scope.stop(); }
});

import { effectScope, nextTick, shallowRef } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { setNativeScreenRecordingDemand } from '../rtc/nativeScreenVideo';
import { useRecording } from './useRecording';

vi.mock('../rtc/nativeScreenVideo', () => ({ setNativeScreenRecordingDemand: vi.fn(async () => {}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function fixture() {
  let id = 0;
  let status: DesktopRecordingStatus = { holdingResources: false, phase: 'idle', recordingId: null, startedAt: null, bytes: 0,
    error: null, saved: false, continuing: false, applicationAudio: false };
  let listener: (state: DesktopRecordingStatus) => void = () => {};
  const desktop = {
    getRecordingSettings: vi.fn(async () => ({ directory: 'C:/app/data/recordings', applicationAudio: false, microphone: false, friends: false })),
    getRecordingStatus: vi.fn(async () => status),
    onRecordingState: (callback: typeof listener) => { listener = callback; return () => {}; },
    startRecording: vi.fn(async () => {
      status = { ...status, holdingResources: true, phase: 'recording', recordingId: `file-${++id}`, startedAt: Date.now(), saved: false };
      listener(status); return status;
    }),
    stopRecording: vi.fn(async () => { status = { ...status, holdingResources: false, phase: 'saved', saved: true }; listener(status); return status; }),
  };
  vi.stubGlobal('window', { lycanDesktop: desktop });
  const track = shallowRef({ id: 'original' } as MediaStreamTrack);
  const scope = effectScope();
  const recording = scope.run(() => useRecording({ track: () => track.value, canStart: () => true, voices: () => [] }))!;
  await vi.waitFor(() => expect(recording.busy.value).toBe(false));
  return { recording, desktop, scope, track };
}

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
    expect(setNativeScreenRecordingDemand).toHaveBeenCalledWith(f.track.value, true);
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

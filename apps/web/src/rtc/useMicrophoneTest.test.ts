import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, Track } from 'livekit-client';
import { useAudioPreferences } from './useAudioPreferences';
import { useMicrophoneTest } from './useMicrophoneTest';
import type { NativeMicrophoneDesktopBridge } from './nativeMicrophoneAudio';

const mocks = vi.hoisted(() => ({
  createTrack: vi.fn(), nativeStart: vi.fn(), nativeStop: vi.fn(), nativeConfigure: vi.fn(),
  playbackStart: vi.fn(), playbackStop: vi.fn(), setVolume: vi.fn(),
  nativeError: undefined as ((code: string) => void) | undefined,
  playbackStopped: undefined as (() => void) | undefined,
  processors: [] as Array<{ init: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    setInputGain: ReturnType<typeof vi.fn>; setVoiceEnhancement: ReturnType<typeof vi.fn> }>,
}));

vi.mock('livekit-client', async (original) => ({
  ...await original<typeof import('livekit-client')>(), createLocalAudioTrack: mocks.createTrack,
}));
vi.mock('./microphoneAudioProcessor', () => ({
  MicrophoneAudioProcessor: class {
    processedTrack = { readyState: 'live' };
    init = vi.fn(async () => {});
    destroy = vi.fn(async () => {});
    setInputGain = vi.fn();
    setVoiceEnhancement = vi.fn();
    constructor() { mocks.processors.push(this); }
  },
}));
vi.mock('./nativeMicrophoneAudio', () => ({
  NativeMicrophoneAudioSession: class {
    private starting?: Promise<void>;
    private stopping?: Promise<void>;
    private stopped = false;
    track = { mediaStreamTrack: { readyState: 'live' } };
    constructor(_desktop: unknown, options: { onError: (code: string) => void }) { mocks.nativeError = options.onError; }
    async start(_id: string, settings: unknown) {
      this.starting = mocks.nativeStart(settings);
      await this.starting;
      if (this.stopped) throw new Error('microphoneSessionStopped');
      return this.track;
    }
    configure(settings: unknown) { return mocks.nativeConfigure(settings); }
    stop() {
      this.stopped = true;
      this.stopping ??= Promise.resolve().then(async () => {
        try { await this.starting; } catch { return; }
        await mocks.nativeStop();
      });
      return this.stopping;
    }
  },
}));
vi.mock('./microphoneLoopback', () => ({
  MicrophoneLoopback: class {
    private stopped = false;
    private stopping?: Promise<void>;
    constructor(private options: { onStopped: () => void; onError: (error: Error) => void }) {
      mocks.playbackStopped = () => this.stop();
    }
    async start(...args: unknown[]) {
      try { await mocks.playbackStart(...args); }
      catch (error) { this.options.onError(error as Error); this.stop(); throw error; }
    }
    setVolume = mocks.setVolume;
    stop() {
      if (!this.stopped) {
        this.stopped = true;
        this.stopping = Promise.resolve().then(() => mocks.playbackStop());
        void this.stopping.catch(() => {});
        this.options.onStopped();
      }
      return this.stopping!;
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function browserTrack() {
  const settings = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const listeners = new Map<string, () => void>();
  return {
    mediaStreamTrack: { readyState: 'live' },
    stop: vi.fn(),
    getSourceTrackSettings: () => settings,
    applyConstraints: vi.fn(async (next: typeof settings) => { Object.assign(settings, next); }),
    on: vi.fn((event: string, callback: () => void) => { listeners.set(event, callback); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
    end: () => listeners.get('ended')?.(),
  };
}

function setup(desktop = false) {
  const scope = effectScope();
  const published = ref<MediaStreamTrack>();
  const available = ref(true);
  const preferences = scope.run(() => useAudioPreferences('test', { getItem: () => null, setItem: () => {} }))!;
  const test = scope.run(() => useMicrophoneTest({ preferences,
    desktop: desktop ? {} as NativeMicrophoneDesktopBridge : undefined,
    publishedTrack: () => published.value,
    canStart: () => available.value,
  }))!;
  return { scope, preferences, test, published, available };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.processors.length = 0;
  mocks.nativeStart.mockResolvedValue(undefined);
  mocks.nativeStop.mockResolvedValue(undefined);
  mocks.nativeConfigure.mockResolvedValue(undefined);
  mocks.playbackStart.mockResolvedValue(undefined);
  vi.stubGlobal('MediaStream', class { constructor(_tracks: unknown[]) {} });
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    resume = vi.fn(async () => {});
    close = vi.fn(async () => { this.state = 'closed'; });
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createAnalyser = () => ({ fftSize: 512, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25) });
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('独立麦克风测试', () => {
  it('未入房时只采集浏览器麦克风，使用同一处理器并显示本机输入等级', async () => {
    const track = browserTrack();
    mocks.createTrack.mockResolvedValue(track);
    const { test, scope } = setup();
    await test.start();
    expect(mocks.createTrack).toHaveBeenCalledWith({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(mocks.processors[0].init).toHaveBeenCalledWith(expect.objectContaining({
      kind: Track.Kind.Audio, track: track.mediaStreamTrack,
    }));
    expect(test.state.value).toBe('listening');
    vi.advanceTimersByTime(120);
    expect(test.inputLevelPercent.value).toBeGreaterThan(0);
    await test.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.processors[0].destroy).toHaveBeenCalledOnce();
    expect(test.inputLevelPercent.value).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it('桌面只走原生采集，无需房间；音量和处理设置使用当前偏好', async () => {
    const { test, scope, preferences } = setup(true);
    preferences.setInputGain(0.5);
    await test.start();
    expect(mocks.nativeStart).toHaveBeenCalledWith({ inputGain: 0.5, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true });
    expect(mocks.createTrack).not.toHaveBeenCalled();
    preferences.setInputGain(1.5);
    preferences.setProcessing('noiseSuppression', false);
    preferences.setOutputVolume(0.5);
    await nextTick();
    expect(mocks.nativeConfigure).toHaveBeenLastCalledWith({ inputGain: 1.5, noiseSuppression: false, autoGainControl: true, voiceEnhancement: true });
    expect(mocks.setVolume).toHaveBeenLastCalledWith(0.5);
    await test.stop();
    expect(mocks.nativeStop).toHaveBeenCalledOnce();
    scope.stop();
  });

  it('已开麦时借用处理后音轨，停止试听不关闭通话的麦克风', async () => {
    const source = { readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
    const { test, scope, published } = setup(true);
    published.value = source;
    await test.start();
    expect(mocks.playbackStart).toHaveBeenCalledWith(source, 1, AudioPresets.music.maxBitrate, true);
    expect(mocks.nativeStart).not.toHaveBeenCalled();
    expect(mocks.createTrack).not.toHaveBeenCalled();
    await test.stop();
    expect(source.stop).not.toHaveBeenCalled();
    expect(mocks.nativeStop).not.toHaveBeenCalled();
    scope.stop();
  });

  it('原始浏览器设备断开时停止临时采集并提示', async () => {
    const track = browserTrack();
    mocks.createTrack.mockResolvedValue(track);
    const { test, scope } = setup();
    await test.start();
    track.end();
    await test.stop();
    expect(test.notice.value).toContain('麦克风已断开');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.off).toHaveBeenCalledOnce();
    scope.stop();
  });

  it('关麦、离房或音轨替换后停止借用，不自动另开采集', async () => {
    const { test, scope, published } = setup();
    published.value = { readyState: 'live' } as MediaStreamTrack;
    await test.start();
    published.value = undefined;
    expect(test.state.value).toBe('stopping');
    await nextTick();
    await test.stop();
    expect(test.state.value).toBe('idle');
    expect(mocks.createTrack).not.toHaveBeenCalled();
    scope.stop();
  });

  it('取消等待权限的启动后，迟到的采集只释放；停止要等它释放才完成', async () => {
    const delayed = deferred<ReturnType<typeof browserTrack>>();
    mocks.createTrack.mockReturnValue(delayed.promise);
    const { test, scope } = setup();
    const starting = test.start();
    await nextTick();
    const stopped = vi.fn();
    const stopping = test.stop().then(stopped);
    expect(test.state.value).toBe('stopping');
    await test.start();
    expect(mocks.createTrack).toHaveBeenCalledOnce();
    expect(stopped).not.toHaveBeenCalled();
    const track = browserTrack();
    delayed.resolve(track);
    await starting;
    await stopping;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.processors).toHaveLength(0);
    expect(mocks.playbackStart).not.toHaveBeenCalled();
    scope.stop();
  });

  it('原生启动期间取消后，等待停止确认且不发布或回放迟到音轨', async () => {
    const delayed = deferred<void>();
    mocks.nativeStart.mockReturnValue(delayed.promise);
    const { test, scope } = setup(true);
    const starting = test.start();
    await nextTick();
    const stopping = test.stop();
    expect(test.state.value).toBe('stopping');
    delayed.resolve();
    await starting;
    await stopping;
    expect(mocks.nativeStop).toHaveBeenCalledOnce();
    expect(mocks.playbackStart).not.toHaveBeenCalled();
    scope.stop();
  });

  it('启动尚未完成时回放停止失败也先接住拒绝，迟到采集仍被回收', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const delayed = deferred<ReturnType<typeof browserTrack>>();
    mocks.createTrack.mockReturnValue(delayed.promise);
    mocks.playbackStop.mockRejectedValueOnce(new Error('playback stop failed'));
    const { test, scope } = setup();
    const starting = test.start();
    await nextTick();
    const stopping = test.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.state.value).toBe('stopping');
    const track = browserTrack();
    delayed.resolve(track);
    await starting;
    await expect(stopping).rejects.toThrow('停止未确认');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.playbackStart).not.toHaveBeenCalled();
    scope.stop();
    log.mockRestore();
  });

  it('原生失败明确提示，不退回浏览器采集', async () => {
    mocks.nativeStart.mockRejectedValue(new Error('audioDeviceUnavailable'));
    const { test, scope } = setup(true);
    await test.start();
    await test.stop();
    expect(test.notice.value).toContain('默认麦克风不可用');
    expect(mocks.createTrack).not.toHaveBeenCalled();
    scope.stop();
  });

  it('回放启动失败仍释放自有采集，保留错误并允许重试', async () => {
    const track = browserTrack();
    mocks.createTrack.mockResolvedValue(track);
    mocks.playbackStart.mockRejectedValueOnce(new Error('试听播放失败'));
    const { test, scope } = setup();
    await test.start();
    await test.stop();
    expect(test.notice.value).toBe('试听播放失败');
    expect(track.stop).toHaveBeenCalledOnce();
    await test.start();
    expect(test.state.value).toBe('listening');
    await test.stop();
    scope.stop();
  });

  it('清理失败保留错误并拒绝下一次采集，调用方不能越过停止确认', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.nativeStop.mockRejectedValueOnce(new Error('stop unconfirmed'));
    const { test, scope } = setup(true);
    await test.start();
    await expect(test.stop()).rejects.toThrow('停止未确认');
    await test.start();
    expect(test.notice.value).toContain('停止未确认');
    expect(mocks.nativeStart).toHaveBeenCalledOnce();
    await expect(test.stop()).rejects.toThrow('停止未确认');
    scope.stop();
    log.mockRestore();
  });

  it('切页销毁只停止测试资源；连接忙碌时不打开新设备', async () => {
    const { test, scope, available } = setup(true);
    available.value = false;
    await test.start();
    expect(mocks.nativeStart).not.toHaveBeenCalled();
    available.value = true;
    await test.start();
    scope.stop();
    await test.stop();
    expect(mocks.nativeStop).toHaveBeenCalledOnce();
  });
});

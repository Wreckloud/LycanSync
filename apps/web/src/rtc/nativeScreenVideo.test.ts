import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeScreenVideoSession, readNativeVideoInput, type NativeVideoDesktopBridge } from './nativeScreenVideo';

type FakeVideoFrame = VideoFrame & { close: ReturnType<typeof vi.fn> };

function createFrame(): FakeVideoFrame {
  return { close: vi.fn() } as unknown as FakeVideoFrame;
}

function installWindowMessageTarget() {
  const target = new EventTarget() as EventTarget & { postMessage?: () => void };
  target.postMessage = () => {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  return target;
}

function dispatchFrame(target: EventTarget, frame: VideoFrame, sessionId?: string) {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: target },
    data: { value: { type: 'lycan-native-screen-frame', ...(sessionId === undefined ? {} : { sessionId }), frame } },
  });
  target.dispatchEvent(event);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('NativeScreenVideoSession', () => {
  it('启动命令失败时清理轨道和监听，不遗留未处理的首帧拒绝', async () => {
    installWindowMessageTarget();
    const removeErrorListener = vi.fn();
    const removeSuspensionListener = vi.fn();
    const stopGenerator = vi.fn();
    const stopTrack = vi.fn();
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: async () => { throw new Error('obsWindowRuntimeUnavailable'); },
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: async () => ({ changed: true }),
      onNativeVideoError: () => removeErrorListener,
      onNativeVideoSuspended: () => removeSuspensionListener,
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      createGenerator: () => ({ writable: new WritableStream<VideoFrame>(), stop: stopGenerator }) as never,
      createLocalTrack: () => ({ stop: stopTrack }) as never,
    });
    await expect(session.start('window:1:0')).rejects.toThrow('obsWindowRuntimeUnavailable');
    await session.stop();
    // 跨过拒绝检查时机；Vitest 会将未观察的首帧 Promise 拒绝判为失败。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopGenerator).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(removeErrorListener).toHaveBeenCalledOnce();
    expect(removeSuspensionListener).toHaveBeenCalledOnce();
    expect(desktop.stopNativeVideo).not.toHaveBeenCalled();
  });

  it('诊断区分真实帧提交、写入背压和最小化提示，停止后撤销轨道统计', async () => {
    const target = installWindowMessageTarget();
    const writeGate = deferred<void>();
    let suspended!: (status: { sessionId: string; suspended: boolean }) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: async () => ({ sessionId: 'diagnostic-session', changed: true }),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: async () => ({ changed: true }),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: (callback) => { suspended = callback; return () => {}; },
    };
    let now = 100;
    const session = new NativeScreenVideoSession(desktop, { maxFps: 120, now: () => now,
      createGenerator: () => ({ writable: new WritableStream<VideoFrame>({ write: () => writeGate.promise }),
        stop: vi.fn() }) as never,
      createLocalTrack: (track) => ({ mediaStreamTrack: track, stop: vi.fn() }) as never,
      createSuspendedFrame: () => createFrame(),
    });
    const track = session.track.mediaStreamTrack;
    expect(readNativeVideoInput({} as MediaStreamTrack)).toBeNull();
    const ready = session.start('window:1:0');
    await Promise.resolve();
    now = 125;
    dispatchFrame(target, createFrame(), 'diagnostic-session');
    await ready;
    const dropped = createFrame();
    dispatchFrame(target, dropped, 'diagnostic-session');
    dispatchFrame(target, createFrame(), 'old-session');
    expect(readNativeVideoInput(track)).toMatchObject({ receivedFrames: 2, submittedFrames: 1,
      backpressureDroppedFrames: 1, completedWrites: 0, pendingWrite: true, firstFrameMs: 25 });
    expect(dropped.close).toHaveBeenCalledOnce();
    writeGate.resolve();
    await vi.waitFor(() => expect(readNativeVideoInput(track)?.pendingWrite).toBe(false));
    suspended({ sessionId: 'diagnostic-session', suspended: true });
    dispatchFrame(target, createFrame(), 'diagnostic-session');
    expect(readNativeVideoInput(track)).toMatchObject({ receivedFrames: 3, submittedFrames: 1,
      suspendedDroppedFrames: 1, placeholderFrames: 1, backpressureDroppedFrames: 1 });
    await session.stop();
    expect(readNativeVideoInput(track)).toBeNull();
    expect(desktop.stopNativeVideo).toHaveBeenCalledOnce();
  });

  it('uses visible dimensions through aligned textures, portrait resizing and already-correct frames', async () => {
    const target = installWindowMessageTarget();
    const frames: VideoFrame[] = [];
    const createAdjustedFrame = vi.fn((frame: VideoFrame, init: VideoFrameInit) =>
      Object.assign({}, frame, init, { close: vi.fn() }) as FakeVideoFrame);
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'resize-session', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    let now = 0;
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      now: () => now,
      createAdjustedFrame,
      createGenerator: () => ({
        writable: new WritableStream<VideoFrame>({ write: (frame) => { frames.push(frame); } }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    expect(desktop.startNativeVideo).toHaveBeenCalledWith('window:1:0', 30, { hideCursor: false, hideBorder: false });
    const sizes = [
      { width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1088 },
      { width: 800, height: 1048, displayWidth: 1920, displayHeight: 1088 },
      { width: 1200, height: 600, displayWidth: 1920, displayHeight: 1088 },
      { width: 1200, height: 600, displayWidth: 1200, displayHeight: 600 },
    ];
    for (const [index, size] of sizes.entries()) {
      now = index * 50;
      const original = Object.assign(createFrame(), {
        codedWidth: 1920, codedHeight: 1088, timestamp: now * 1000,
        displayWidth: size.displayWidth, displayHeight: size.displayHeight,
        visibleRect: { x: 0, y: 0, width: size.width, height: size.height },
      });
      dispatchFrame(target, original, 'resize-session');
      await ready;
      await vi.waitFor(() => expect(frames).toHaveLength(index + 1));
      const output = frames[index];
      expect(output.displayWidth).toBe(size.width);
      expect(output.displayHeight).toBe(size.height);
      expect(output.visibleRect).toEqual(original.visibleRect);
      expect(output.codedWidth).toBe(1920);
      expect(output.codedHeight).toBe(1088);
      expect(output.timestamp).toBe(original.timestamp);
      await vi.waitFor(() => expect(output.close).toHaveBeenCalledOnce());
      expect(original.close).toHaveBeenCalledOnce();
      if (index < 3) {
        expect(createAdjustedFrame).toHaveBeenLastCalledWith(original, {
          displayWidth: size.width, displayHeight: size.height,
        });
      } else {
        expect(output).toBe(original);
      }
    }
    expect(createAdjustedFrame).toHaveBeenCalledTimes(3);
    await session.stop();
  });

  it('releases the original frame and stops capture if display metadata adjustment fails', async () => {
    const target = installWindowMessageTarget();
    const onError = vi.fn();
    const write = vi.fn();
    const stopNativeVideo = vi.fn(async () => ({ changed: true }));
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'adjustment-fails', changed: true })),
      stopNativeVideo,
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      onError,
      createAdjustedFrame: () => { throw new Error('frame adjustment failed'); },
      createGenerator: () => ({
        writable: new WritableStream<VideoFrame>({ write }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    const rejected = expect(ready).rejects.toThrow('nativeVideoFrameAdjustmentFailed');
    await Promise.resolve();
    const original = Object.assign(createFrame(), {
      displayWidth: 1920, displayHeight: 1088,
      visibleRect: { x: 0, y: 0, width: 800, height: 1048 },
    });
    dispatchFrame(target, original, 'adjustment-fails');
    await rejected;
    await session.stop();
    expect(original.close).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('nativeVideoFrameAdjustmentFailed');
    expect(stopNativeVideo).toHaveBeenCalledWith('adjustment-fails');
  });

  it('waits for an actual VideoFrame before exposing a publishable track and releases it on stop', async () => {
    const target = installWindowMessageTarget();
    const frames: VideoFrame[] = [];
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>({ write: (frame) => { frames.push(frame); } }),
      stop: vi.fn(),
    };
    const track = { stop: vi.fn() };
    const started = vi.fn(async () => ({ sessionId: 'session-1', changed: true }));
    const stopped = vi.fn(async () => ({ changed: true }));
    let helperError: ((failure: { sessionId: string; code: string }) => void) | undefined;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: started,
      stopNativeVideo: stopped,
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: (callback) => {
        helperError = callback;
        return () => { helperError = undefined; };
      },
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      createGenerator: () => generator as never,
      createLocalTrack: () => track as never,
    });

    const ready = session.start('monitor:1:0');
    await Promise.resolve();
    const frame = createFrame();
    dispatchFrame(target, frame, 'session-1');
    expect(await ready).toBe(track);
    expect(started).toHaveBeenCalledWith('monitor:1:0', 30, { hideCursor: false, hideBorder: false });
    expect(frames).toEqual([frame]);
    expect(frame.close).toHaveBeenCalledOnce();

    await session.stop();
    await session.stop();
    expect(generator.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('session-1');
    expect(helperError).toBeUndefined();
  });

  it('accepts only the matching session frame, including a frame received before start resolves', async () => {
    const target = installWindowMessageTarget();
    let finishStart!: (value: { sessionId: string; changed: boolean }) => void;
    const frames: VideoFrame[] = [];
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>({ write: (frame) => { frames.push(frame); } }),
      stop: vi.fn(),
    };
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: () => new Promise((resolve) => { finishStart = resolve; }),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      createGenerator: () => generator as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('monitor:1:0');
    await Promise.resolve();

    const oldFrame = createFrame();
    const missingIdFrame = createFrame();
    dispatchFrame(target, oldFrame, 'older-session');
    dispatchFrame(target, missingIdFrame);
    expect(missingIdFrame.close).toHaveBeenCalledOnce();

    const firstFrame = createFrame();
    dispatchFrame(target, firstFrame, 'new-session');
    expect(oldFrame.close).toHaveBeenCalledOnce();
    expect(firstFrame.close).not.toHaveBeenCalled();
    finishStart({ sessionId: 'new-session', changed: true });
    await vi.waitFor(() => expect(session.captureSessionId).toBe('new-session'));
    const lateOldFrame = createFrame();
    dispatchFrame(target, lateOldFrame, 'older-session');
    expect(lateOldFrame.close).toHaveBeenCalledOnce();
    await expect(ready).resolves.toBeTruthy();
    await vi.waitFor(() => expect(frames).toEqual([firstFrame]));
    await session.stop();
  });

  it('stops local resources immediately and keeps a rejected native stop visible on repeated calls', async () => {
    const target = installWindowMessageTarget();
    const nativeStop = deferred<{ changed: boolean }>();
    const stopNativeVideo = vi.fn(() => nativeStop.promise);
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>(),
      stop: vi.fn(),
    };
    const track = { stop: vi.fn() };
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'stop-fails', changed: true })),
      stopNativeVideo,
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      createGenerator: () => generator as never,
      createLocalTrack: () => track as never,
    });
    const ready = session.start('monitor:1:0');
    await Promise.resolve();
    const first = createFrame();
    dispatchFrame(target, first, 'stop-fails');
    await ready;

    const stopping = session.stop();
    expect(generator.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(stopNativeVideo).toHaveBeenCalledWith('stop-fails'));
    const lateFrame = createFrame();
    dispatchFrame(target, lateFrame, 'stop-fails');
    expect(lateFrame.close).toHaveBeenCalledOnce();

    nativeStop.reject(new Error('videoStopFailed'));
    await expect(stopping).rejects.toThrow('videoStopFailed');
    await expect(session.stop()).rejects.toThrow('videoStopFailed');
    expect(stopNativeVideo).toHaveBeenCalledOnce();
    const laterFrame = createFrame();
    dispatchFrame(target, laterFrame, 'stop-fails');
    expect(laterFrame.close).toHaveBeenCalledOnce();
  });

  it('drops frames only while a write is in flight, without applying a second FPS cap', async () => {
    const target = installWindowMessageTarget();
    let finishWrite!: () => void;
    const writes: VideoFrame[] = [];
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>({
        write: (frame) => {
          writes.push(frame);
          return new Promise<void>((resolve) => { finishWrite = resolve; });
        },
      }),
      stop: vi.fn(),
    };
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-2', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    let now = 0;
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      now: () => now,
      createGenerator: () => generator as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();

    const first = createFrame();
    dispatchFrame(target, first, 'session-2');
    const inFlight = createFrame();
    dispatchFrame(target, inFlight, 'session-2');
    expect(inFlight.close).toHaveBeenCalledOnce();
    expect(writes).toEqual([first]);

    await ready;
    expect(first.close).not.toHaveBeenCalled();
    finishWrite();
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    now = 5;
    const next = createFrame();
    dispatchFrame(target, next, 'session-2');
    await vi.waitFor(() => expect(writes).toEqual([first, next]));
    finishWrite();
    await session.stop();
  });

  it('scales a 120 fps input to the requested resolution without changing its aspect ratio', async () => {
    const target = installWindowMessageTarget();
    const writes: VideoFrame[] = [];
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'quality-session', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 120, resolution: { width: 1280, height: 720 },
      createAdjustedFrame: (frame, init) => Object.assign({}, frame, init, { close: vi.fn() }),
      createGenerator: () => ({ writable: new WritableStream<VideoFrame>({ write: (frame) => { writes.push(frame); } }), stop: vi.fn() }) as never,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    const frame = Object.assign(createFrame(), {
      displayWidth: 1920, displayHeight: 1080, timestamp: 1,
      visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    dispatchFrame(target, frame, 'quality-session');
    await ready;
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(desktop.startNativeVideo).toHaveBeenCalledWith('window:1:0', 120, { hideCursor: false, hideBorder: false });
    expect(writes[0].displayWidth).toBe(1280);
    expect(writes[0].displayHeight).toBe(720);
    expect(frame.close).toHaveBeenCalledOnce();
    await session.stop();
  });

  it('stops the helper when it reports an output failure', async () => {
    installWindowMessageTarget();
    const stopNativeVideo = vi.fn(async () => ({ changed: true }));
    let reportError!: (failure: { sessionId: string; code: string }) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-3', changed: true })),
      stopNativeVideo,
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: (callback) => {
        reportError = callback;
        return () => {};
      },
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>(),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('monitor:1:0');
    await Promise.resolve();
    reportError({ sessionId: 'session-3', code: 'sharedTextureImportFailed' });
    await expect(ready).rejects.toThrow('sharedTextureImportFailed');
    await session.stop();
    expect(stopNativeVideo).toHaveBeenCalledWith('session-3');
  });

  it('ignores a late window-close event from an older capture session', async () => {
    const target = installWindowMessageTarget();
    const onError = vi.fn();
    let reportError!: (failure: { sessionId: string; code: string }) => void;
    const stopNativeVideo = vi.fn(async () => ({ changed: true }));
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'current-session', changed: true })),
      stopNativeVideo,
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: (callback) => {
        reportError = callback;
        return () => {};
      },
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      onError,
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>(),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    dispatchFrame(target, createFrame(), 'current-session');
    await ready;

    reportError({ sessionId: 'old-session', code: 'captureTargetClosed' });
    expect(onError).not.toHaveBeenCalled();
    expect(stopNativeVideo).not.toHaveBeenCalled();

    reportError({ sessionId: 'current-session', code: 'captureTargetClosed' });
    expect(onError).toHaveBeenCalledWith('captureTargetClosed');
    await session.stop();
    expect(stopNativeVideo).toHaveBeenCalledWith('current-session');
  });

  it('repeats monotonic pause hints on the live track and stops them on resume', async () => {
    vi.useFakeTimers();
    const target = installWindowMessageTarget();
    const frames: VideoFrame[] = [];
    const pauseFrames: VideoFrame[] = [];
    const adjustedFrames: VideoFrame[] = [];
    const onError = vi.fn();
    let reportSuspension!: (status: { sessionId: string; suspended: boolean }) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'window-session', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: (callback) => {
        reportSuspension = callback;
        return () => {};
      },
    };
    let now = 0;
    const createSuspendedFrame = vi.fn((_width: number, _height: number, timestamp: number) => {
      const frame = Object.assign(createFrame(), { timestamp });
      pauseFrames.push(frame);
      return frame;
    });
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      now: () => now,
      onError,
      createSuspendedFrame,
      createAdjustedFrame: (_frame, init) => {
        const adjusted = Object.assign(createFrame(), init);
        adjustedFrames.push(adjusted);
        return adjusted;
      },
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>({ write: (frame) => { frames.push(frame); } }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    dispatchFrame(target, Object.assign(createFrame(), { displayWidth: 800, displayHeight: 500, timestamp: 100_000 }), 'window-session');
    await ready;

    reportSuspension({ sessionId: 'old-session', suspended: true });
    expect(createSuspendedFrame).not.toHaveBeenCalled();
    reportSuspension({ sessionId: 'window-session', suspended: true });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(createSuspendedFrame).toHaveBeenCalledWith(800, 500, 1_100_000);
    await vi.waitFor(() => expect(pauseFrames[0].close).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toHaveLength(4);
    expect(pauseFrames.map((frame) => frame.timestamp)).toEqual([1_100_000, 2_100_000, 3_100_000]);
    expect(pauseFrames[1].timestamp).toBeGreaterThan(pauseFrames[0].timestamp!);
    expect(pauseFrames[2].timestamp).toBeGreaterThan(pauseFrames[1].timestamp!);
    const staleFrame = createFrame();
    dispatchFrame(target, staleFrame, 'window-session');
    expect(staleFrame.close).toHaveBeenCalledOnce();

    reportSuspension({ sessionId: 'window-session', suspended: false });
    now = 100;
    const resumedFrame = Object.assign(createFrame(), {
      timestamp: 200_000, displayWidth: 1280, displayHeight: 720,
      visibleRect: { x: 0, y: 0, width: 800, height: 500 },
    });
    dispatchFrame(target, resumedFrame, 'window-session');
    await vi.waitFor(() => expect(frames).toHaveLength(5));
    expect(resumedFrame.close).toHaveBeenCalledOnce();
    expect(frames[4]).toBe(adjustedFrames[0]);
    expect(adjustedFrames[0].timestamp).toBe(pauseFrames[2].timestamp! + 1);
    expect(adjustedFrames[0].displayWidth).toBe(800);
    expect(adjustedFrames[0].displayHeight).toBe(500);
    expect(adjustedFrames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toHaveLength(5);
    expect(onError).not.toHaveBeenCalled();
    await session.stop();
  });

  it('does not queue pause hints behind a blocked writer and clears the timer on stop', async () => {
    vi.useFakeTimers();
    const target = installWindowMessageTarget();
    let rejectHint!: (error: Error) => void;
    const writes: VideoFrame[] = [];
    let reportSuspension!: (status: { sessionId: string; suspended: boolean }) => void;
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>({
        write: (frame) => {
          writes.push(frame);
          return writes.length === 2
            ? new Promise<void>((_resolve, reject) => { rejectHint = reject; })
            : undefined;
        },
      }),
      stop: vi.fn(() => rejectHint?.(new Error('stopped'))),
    };
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'busy-session', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: (callback) => { reportSuspension = callback; return () => {}; },
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      createSuspendedFrame: (_width, _height, timestamp) => Object.assign(createFrame(), { timestamp }),
      createGenerator: () => generator as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    dispatchFrame(target, Object.assign(createFrame(), { timestamp: 100_000 }), 'busy-session');
    await ready;
    reportSuspension({ sessionId: 'busy-session', suspended: true });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toHaveLength(2);
    await session.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveLength(2);
    expect(desktop.stopNativeVideo).toHaveBeenCalledWith('busy-session');
  });

  it('can publish a pause frame when minimization precedes the first captured frame', async () => {
    installWindowMessageTarget();
    let finishStart!: (value: { sessionId: string; changed: boolean }) => void;
    let reportSuspension!: (status: { sessionId: string; suspended: boolean }) => void;
    const pauseFrame = Object.assign(createFrame(), { timestamp: 1 });
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: () => new Promise((resolve) => { finishStart = resolve; }),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: (callback) => {
        reportSuspension = callback;
        return () => {};
      },
    };
    const track = { stop: vi.fn() };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      createSuspendedFrame: () => pauseFrame,
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>({ write: () => {} }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => track as never,
    });
    const ready = session.start('window:1:0');
    reportSuspension({ sessionId: 'early-session', suspended: true });
    finishStart({ sessionId: 'early-session', changed: true });
    expect(await ready).toBe(track);
    await session.stop();
  });

  it('keeps a writer interruption caused by an explicit stop quiet', async () => {
    const target = installWindowMessageTarget();
    let interruptWrite!: (error: Error) => void;
    const onError = vi.fn();
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-stop', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const generator = {
      contentHint: '',
      writable: new WritableStream<VideoFrame>({
        write: () => new Promise<void>((_resolve, reject) => { interruptWrite = reject; }),
      }),
      stop: vi.fn(() => interruptWrite(new Error('track stopped'))),
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      onError,
      createGenerator: () => generator as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('monitor:1:0');
    await Promise.resolve();
    dispatchFrame(target, createFrame(), 'session-stop');
    await ready;

    await session.stop();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    expect(desktop.stopNativeVideo).toHaveBeenCalledWith('session-stop');
  });

  it('reports a genuine writer failure while the session is running', async () => {
    const target = installWindowMessageTarget();
    const onError = vi.fn();
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-write-error', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      configureNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: () => () => {},
    };
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 60,
      onError,
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>({ write: () => Promise.reject(new Error('real write failure')) }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    dispatchFrame(target, createFrame(), 'session-write-error');
    await ready;
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('nativeVideoTrackWriteFailed');
    expect(session.readDiagnostics().writeFailures).toBe(1);
    await session.stop();
  });
});

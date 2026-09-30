import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeScreenVideoSession, type NativeVideoDesktopBridge } from './nativeScreenVideo';

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

function dispatchFrame(target: EventTarget, frame: VideoFrame) {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: target },
    data: { value: { type: 'lycan-native-screen-frame', frame } },
  });
  target.dispatchEvent(event);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('NativeScreenVideoSession', () => {
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
    dispatchFrame(target, frame);
    expect(await ready).toBe(track);
    expect(started).toHaveBeenCalledWith('monitor:1:0', 30);
    expect(frames).toEqual([frame]);
    expect(frame.close).toHaveBeenCalledOnce();

    await session.stop();
    await session.stop();
    expect(generator.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('session-1');
    expect(helperError).toBeUndefined();
  });

  it('drops frames while a write is in flight and closes frames rejected by the FPS cap', async () => {
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
    dispatchFrame(target, first);
    const inFlight = createFrame();
    dispatchFrame(target, inFlight);
    expect(inFlight.close).toHaveBeenCalledOnce();
    expect(writes).toEqual([first]);

    await ready;
    expect(first.close).not.toHaveBeenCalled();
    finishWrite();
    await Promise.resolve();
    now = 5;
    const fpsDropped = createFrame();
    dispatchFrame(target, fpsDropped);
    expect(fpsDropped.close).toHaveBeenCalledOnce();
    await session.stop();
  });

  it('stops the helper when it reports an output failure', async () => {
    installWindowMessageTarget();
    const stopNativeVideo = vi.fn(async () => ({ changed: true }));
    let reportError!: (failure: { sessionId: string; code: string }) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-3', changed: true })),
      stopNativeVideo,
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
    dispatchFrame(target, createFrame());
    await ready;

    reportError({ sessionId: 'old-session', code: 'captureTargetClosed' });
    expect(onError).not.toHaveBeenCalled();
    expect(stopNativeVideo).not.toHaveBeenCalled();

    reportError({ sessionId: 'current-session', code: 'captureTargetClosed' });
    expect(onError).toHaveBeenCalledWith('captureTargetClosed');
    await session.stop();
    expect(stopNativeVideo).toHaveBeenCalledWith('current-session');
  });

  it('replaces a minimized window with a pause frame and resumes real frames', async () => {
    const target = installWindowMessageTarget();
    const frames: VideoFrame[] = [];
    const pauseFrame = Object.assign(createFrame(), { timestamp: 100_001 });
    const onError = vi.fn();
    let reportSuspension!: (status: { sessionId: string; suspended: boolean }) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'window-session', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
      onNativeVideoSuspended: (callback) => {
        reportSuspension = callback;
        return () => {};
      },
    };
    let now = 0;
    const createSuspendedFrame = vi.fn(() => pauseFrame);
    const session = new NativeScreenVideoSession(desktop, {
      maxFps: 30,
      now: () => now,
      onError,
      createSuspendedFrame,
      createGenerator: () => ({
        contentHint: '',
        writable: new WritableStream<VideoFrame>({ write: (frame) => { frames.push(frame); } }),
        stop: vi.fn(),
      }) as never,
      createLocalTrack: () => ({ stop: vi.fn() } as never),
    });
    const ready = session.start('window:1:0');
    await Promise.resolve();
    dispatchFrame(target, Object.assign(createFrame(), { displayWidth: 800, displayHeight: 500, timestamp: 100_000 }));
    await ready;

    reportSuspension({ sessionId: 'old-session', suspended: true });
    expect(createSuspendedFrame).not.toHaveBeenCalled();
    reportSuspension({ sessionId: 'window-session', suspended: true });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(createSuspendedFrame).toHaveBeenCalledWith(800, 500, 100_001);
    expect(frames[1]).toBe(pauseFrame);
    await vi.waitFor(() => expect(pauseFrame.close).toHaveBeenCalledOnce());
    const staleFrame = createFrame();
    dispatchFrame(target, staleFrame);
    expect(staleFrame.close).toHaveBeenCalledOnce();

    reportSuspension({ sessionId: 'window-session', suspended: false });
    now = 100;
    const resumedFrame = Object.assign(createFrame(), { timestamp: 200_000 });
    dispatchFrame(target, resumedFrame);
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toBe(resumedFrame);
    expect(onError).not.toHaveBeenCalled();
    await session.stop();
  });

  it('can publish a pause frame when minimization precedes the first captured frame', async () => {
    installWindowMessageTarget();
    let finishStart!: (value: { sessionId: string; changed: boolean }) => void;
    let reportSuspension!: (status: { sessionId: string; suspended: boolean }) => void;
    const pauseFrame = Object.assign(createFrame(), { timestamp: 1 });
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: () => new Promise((resolve) => { finishStart = resolve; }),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
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
    dispatchFrame(target, createFrame());
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
    dispatchFrame(target, createFrame());
    await ready;
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('nativeVideoTrackWriteFailed');
    await session.stop();
  });
});

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
    let helperError: ((code: string) => void) | undefined;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: started,
      stopNativeVideo: stopped,
      onNativeVideoError: (callback) => {
        helperError = callback;
        return () => { helperError = undefined; };
      },
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
    let reportError!: (code: string) => void;
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-3', changed: true })),
      stopNativeVideo,
      onNativeVideoError: (callback) => {
        reportError = callback;
        return () => {};
      },
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
    reportError('sharedTextureImportFailed');
    await expect(ready).rejects.toThrow('sharedTextureImportFailed');
    await session.stop();
    expect(stopNativeVideo).toHaveBeenCalledWith('session-3');
  });

  it('keeps a writer interruption caused by an explicit stop quiet', async () => {
    const target = installWindowMessageTarget();
    let interruptWrite!: (error: Error) => void;
    const onError = vi.fn();
    const desktop: NativeVideoDesktopBridge = {
      startNativeVideo: vi.fn(async () => ({ sessionId: 'session-stop', changed: true })),
      stopNativeVideo: vi.fn(async () => ({ changed: true })),
      onNativeVideoError: () => () => {},
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

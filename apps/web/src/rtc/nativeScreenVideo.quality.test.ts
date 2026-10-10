import { afterEach, expect, it, vi } from 'vitest';
import { NativeScreenVideoSession, type NativeVideoDesktopBridge } from './nativeScreenVideo';

afterEach(() => vi.unstubAllGlobals());

async function createSession() {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  let parameters = { encodings: [{ active: true, maxBitrate: 12_000_000, maxFramerate: 60 }] };
  const sender = {
    getParameters: () => structuredClone(parameters),
    setParameters: vi.fn(async (next) => { parameters = structuredClone(next); }),
  };
  const desktop: NativeVideoDesktopBridge = {
    startNativeVideo: vi.fn(async () => ({ sessionId: 'quality-session', changed: true })),
    stopNativeVideo: vi.fn(async () => ({ changed: true })),
    configureNativeVideo: vi.fn(async () => ({ changed: true })),
    onNativeVideoError: () => () => {}, onNativeVideoSuspended: () => () => {},
  };
  const onError = vi.fn();
  const writes: VideoFrame[] = [];
  const track = { sender, stop: vi.fn(), publishOptions: { videoEncoding: { maxBitrate: 12_000_000, maxFramerate: 60 } } };
  const session = new NativeScreenVideoSession(desktop, {
    maxFps: 60, onError,
    createAdjustedFrame: (frame, init) => Object.assign({}, frame, init, { close: vi.fn() }),
    createGenerator: () => ({ writable: new WritableStream<VideoFrame>({ write: (frame) => { writes.push(frame); } }), stop: vi.fn() }) as never,
    createLocalTrack: () => track as never,
  });
  const sendFrame = async () => {
    const count = writes.length;
    const frame = { close: vi.fn(), timestamp: count + 1, displayWidth: 1920, displayHeight: 1080,
      visibleRect: { x: 0, y: 0, width: 1920, height: 1080 } };
    const event = new Event('message');
    Object.defineProperties(event, { source: { value: target }, data: { value: {
      type: 'lycan-native-screen-frame', sessionId: 'quality-session', frame,
    } } });
    target.dispatchEvent(event);
    await vi.waitFor(() => expect(writes).toHaveLength(count + 1));
    await vi.waitFor(() => expect(writes[count].close).toHaveBeenCalledOnce());
  };
  const ready = session.start('window:1:0');
  await Promise.resolve();
  await sendFrame();
  await ready;
  return { session, desktop, sender, track, onError, writes, sendFrame };
}

it('updates capture and encoder without replacing the track or session, and scales the next frame', async () => {
  const { session, desktop, sender, track, writes, sendFrame } = await createSession();
  try {
    await session.configureQuality('economy');
    expect(desktop.configureNativeVideo).toHaveBeenCalledWith('quality-session', 30);
    expect(sender.getParameters().encodings[0]).toEqual({ active: true, maxBitrate: 3_000_000, maxFramerate: 30 });
    expect(track.publishOptions.videoEncoding.maxBitrate).toBe(3_000_000);
    expect(session.track).toBe(track);
    expect(session.captureSessionId).toBe('quality-session');
    expect(desktop.startNativeVideo).toHaveBeenCalledOnce();
    expect(desktop.stopNativeVideo).not.toHaveBeenCalled();
    await sendFrame();
    expect(writes.at(-1)?.displayWidth).toBe(1280);
    expect(writes.at(-1)?.displayHeight).toBe(720);
  } finally { await session.stop(); }
});

it('restores encoder and native limits when the native update fails after the sender changed', async () => {
  const { session, desktop, sender, track, sendFrame, writes } = await createSession();
  try {
    vi.mocked(desktop.configureNativeVideo).mockRejectedValueOnce(new Error('configure failed'));
    await expect(session.configureQuality('economy')).rejects.toThrow('configure failed');
    expect(sender.getParameters().encodings[0]).toEqual({ active: true, maxBitrate: 12_000_000, maxFramerate: 60 });
    expect(desktop.configureNativeVideo).toHaveBeenLastCalledWith('quality-session', 60);
    expect(track.publishOptions.videoEncoding.maxBitrate).toBe(12_000_000);
    await sendFrame();
    expect(writes.at(-1)?.displayWidth).toBe(1920);
  } finally { await session.stop(); }
});

it('reports rollback failure as a stopped share', async () => {
  const { session, desktop, onError } = await createSession();
  vi.mocked(desktop.configureNativeVideo).mockRejectedValue(new Error('native unavailable'));
  await expect(session.configureQuality('text')).rejects.toThrow('nativeVideoConfigurationRollbackFailed');
  expect(onError).toHaveBeenCalledWith('nativeVideoConfigurationRollbackFailed');
  await vi.waitFor(() => expect(desktop.stopNativeVideo).toHaveBeenCalledWith('quality-session'));
  await session.stop();
});

it('restores sender limits without requesting native changes when encoder configuration fails', async () => {
  const { session, desktop, sender } = await createSession();
  try {
    sender.setParameters.mockRejectedValueOnce(new Error('encoder unavailable'));
    await expect(session.configureQuality('economy')).rejects.toThrow('encoder unavailable');
    expect(desktop.configureNativeVideo).not.toHaveBeenCalled();
    expect(sender.getParameters().encodings[0]).toEqual({ active: true, maxBitrate: 12_000_000, maxFramerate: 60 });
    expect(desktop.stopNativeVideo).not.toHaveBeenCalled();
  } finally { await session.stop(); }
});

it('preserves the latest SDK active state when restoring limits', async () => {
  const { session, desktop, sender } = await createSession();
  try {
    vi.mocked(desktop.configureNativeVideo).mockImplementationOnce(async () => {
      const parameters = sender.getParameters();
      parameters.encodings[0].active = false;
      await sender.setParameters(parameters);
      throw new Error('native rejected');
    });
    await expect(session.configureQuality('economy')).rejects.toThrow('native rejected');
    expect(sender.getParameters().encodings[0]).toEqual({ active: false, maxBitrate: 12_000_000, maxFramerate: 60 });
  } finally { await session.stop(); }
});

it('does not apply or roll back a late native update after the capture was stopped', async () => {
  const { session, desktop, track } = await createSession();
  let complete!: (value: { changed: boolean }) => void;
  vi.mocked(desktop.configureNativeVideo).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const changing = session.configureQuality('highFrameRate');
  const rejected = expect(changing).rejects.toThrow('nativeVideoSessionStopped');
  await vi.waitFor(() => expect(desktop.configureNativeVideo).toHaveBeenCalledOnce());
  await session.stop();
  complete({ changed: true });
  await rejected;
  expect(desktop.configureNativeVideo).toHaveBeenCalledOnce();
  expect(track.publishOptions.videoEncoding.maxFramerate).toBe(60);
});

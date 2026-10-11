import { afterEach, expect, it, vi } from 'vitest';
import { LocalParticipant } from 'livekit-client';
import { NativeScreenVideoSession, type NativeVideoDesktopBridge } from './nativeScreenVideo';

afterEach(() => vi.unstubAllGlobals());

async function createSession(dualLayer = false) {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  let parameters: RTCRtpSendParameters = {
    transactionId: 'quality-test', codecs: [], headerExtensions: [], rtcp: {},
    degradationPreference: 'maintain-framerate',
    encodings: dualLayer ? [
      { rid: 'q', active: true, maxBitrate: 1_000_000, maxFramerate: 30, scaleResolutionDownBy: 3 },
      { rid: 'h', active: true, maxBitrate: 12_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
    ] : [{ active: true, maxBitrate: 12_000_000, maxFramerate: 60 }],
  };
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
  const track = { sender, stop: vi.fn(), publishOptions: {
    screenShareEncoding: { maxBitrate: 12_000_000, maxFramerate: 60 },
    degradationPreference: 'maintain-framerate' as RTCDegradationPreference,
  } };
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
    expect(track.publishOptions.screenShareEncoding.maxBitrate).toBe(3_000_000);
    expect(sender.getParameters().degradationPreference).toBe('balanced');
    expect(track.publishOptions.degradationPreference).toBe('balanced');
    expect(session.track).toBe(track);
    expect(session.captureSessionId).toBe('quality-session');
    expect(desktop.startNativeVideo).toHaveBeenCalledOnce();
    expect(desktop.stopNativeVideo).not.toHaveBeenCalled();
    await sendFrame();
    expect(writes.at(-1)?.displayWidth).toBe(1280);
    expect(writes.at(-1)?.displayHeight).toBe(720);
  } finally { await session.stop(); }
});

it('双层切换同时更新主层与缩略层，保持 RID、暂停状态和采集会话', async () => {
  const { session, sender, desktop, track } = await createSession(true);
  try {
    const parameters = sender.getParameters();
    parameters.encodings[0].active = false;
    await sender.setParameters(parameters);
    await session.configureQuality('economy');
    expect(sender.getParameters().encodings).toEqual([
      { rid: 'q', active: false, maxBitrate: 1_000_000, maxFramerate: 30, scaleResolutionDownBy: 2 },
      { rid: 'h', active: true, maxBitrate: 3_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
    ]);
    await session.configureQuality('highFrameRate');
    expect(sender.getParameters().encodings).toEqual([
      { rid: 'q', active: false, maxBitrate: 1_000_000, maxFramerate: 30, scaleResolutionDownBy: 3 },
      { rid: 'h', active: true, maxBitrate: 20_000_000, maxFramerate: 120, scaleResolutionDownBy: 1 },
    ]);
    expect(track.publishOptions.screenShareEncoding.maxFramerate).toBe(120);
    expect(desktop.startNativeVideo).toHaveBeenCalledOnce();
    expect(desktop.stopNativeVideo).not.toHaveBeenCalled();
  } finally { await session.stop(); }
});

it('双层失败回滚恢复每层码率、帧率和缩放，保留最新 dynacast 状态', async () => {
  const { session, sender, desktop, track } = await createSession(true);
  try {
    vi.mocked(desktop.configureNativeVideo).mockImplementationOnce(async () => {
      const parameters = sender.getParameters();
      parameters.encodings[1].active = false;
      await sender.setParameters(parameters);
      throw new Error('native rejected');
    });
    await expect(session.configureQuality('economy')).rejects.toThrow('native rejected');
    expect(sender.getParameters().encodings).toEqual([
      { rid: 'q', active: true, maxBitrate: 1_000_000, maxFramerate: 30, scaleResolutionDownBy: 3 },
      { rid: 'h', active: false, maxBitrate: 12_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
    ]);
    expect(track.publishOptions.screenShareEncoding.maxFramerate).toBe(60);
    expect(desktop.configureNativeVideo).toHaveBeenLastCalledWith('quality-session', 60);
  } finally { await session.stop(); }
});

it('restores encoder and native limits when the native update fails after the sender changed', async () => {
  const { session, desktop, sender, track, sendFrame, writes } = await createSession();
  try {
    vi.mocked(desktop.configureNativeVideo).mockRejectedValueOnce(new Error('configure failed'));
    await expect(session.configureQuality('economy')).rejects.toThrow('configure failed');
    expect(sender.getParameters().encodings[0]).toEqual({ active: true, maxBitrate: 12_000_000, maxFramerate: 60 });
    expect(desktop.configureNativeVideo).toHaveBeenLastCalledWith('quality-session', 60);
    expect(track.publishOptions.screenShareEncoding.maxBitrate).toBe(12_000_000);
    expect(sender.getParameters().degradationPreference).toBe('maintain-framerate');
    expect(track.publishOptions.degradationPreference).toBe('maintain-framerate');
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
  expect(track.publishOptions.screenShareEncoding.maxFramerate).toBe(60);
});

it('SDK 重发布读取更新后的屏幕编码和降级策略，不恢复初始预设', async () => {
  const { session, track } = await createSession();
  // SDK 发布时让 publication.options 与 track.publishOptions 引用同一配置对象。
  const publication = { track, options: track.publishOptions };
  const participant = {
    trackPublications: new Map([['share-sid', publication]]),
    unpublishTrack: vi.fn(async () => {}),
    publishOrRepublishTrack: vi.fn(async () => {}),
  };
  try {
    await session.configureQuality('text');
    await LocalParticipant.prototype.republishAllTracks.call(participant as never, undefined, false);
    expect(participant.unpublishTrack).toHaveBeenCalledWith(track, false);
    expect(participant.publishOrRepublishTrack).toHaveBeenCalledWith(track, expect.objectContaining({
      screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 30, priority: 'high' },
      degradationPreference: 'maintain-resolution',
    }), true);
    expect(publication.options).not.toHaveProperty('videoEncoding');
  } finally { await session.stop(); }
});

it('SDK 重发布期间 sender 被替换时，不把旧画质更新登记到新 sender', async () => {
  const { session, desktop, sender, track } = await createSession();
  let complete!: (value: { changed: boolean }) => void;
  vi.mocked(desktop.configureNativeVideo).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  try {
    const changing = session.configureQuality('text');
    const rejected = expect(changing).rejects.toThrow('nativeVideoSessionStopped');
    await vi.waitFor(() => expect(desktop.configureNativeVideo).toHaveBeenCalledOnce());
    track.sender = { ...sender, setParameters: vi.fn(async () => {}) };
    complete({ changed: true });
    await rejected;
    expect(track.sender.setParameters).not.toHaveBeenCalled();
    expect(desktop.configureNativeVideo).toHaveBeenLastCalledWith('quality-session', 60);
    expect(track.publishOptions.screenShareEncoding.maxFramerate).toBe(60);
    expect(track.publishOptions.degradationPreference).toBe('maintain-framerate');
  } finally { await session.stop(); }
});

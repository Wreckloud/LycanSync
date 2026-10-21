import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeScreenAudioSession, type NativeScreenAudioDesktopBridge } from './nativeScreenAudio';

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  dispatch(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

function createFakes() {
  const port = new FakePort();
  const node = { port, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48000,
    state: 'running',
    audioWorklet: { addModule: vi.fn(async (_url: string) => {}) },
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => { context.state = 'closed'; }),
  };
  return { context: context as unknown as AudioContext, node: node as unknown as AudioWorkletNode, port,
    close: context.close, addModule: context.audioWorklet.addModule, connect: node.connect, disconnect: node.disconnect };
}

afterEach(() => vi.restoreAllMocks());

describe('NativeScreenAudioSession', () => {
  it('passes bounded PCM chunks to the worklet, acknowledges them, and releases on stop', async () => {
    const fakes = createFakes();
    const started = vi.fn(async () => ({ sampleRate: 48000, channels: 2 as const,
      bitsPerSample: 32 as const, nominalChunkMs: 10 as const, pluginLoadMs: 12, captureReadyMs: 340 }));
    const stopped = vi.fn(async () => ({ changed: true }));
    const acknowledge = vi.fn();
    let receiveChunk: ((chunk: { sessionId: string; sequence: number; frames: number; sampleRate: number;
      channels: 2; pcm: Uint8Array }) => void) | undefined;
    const desktop: NativeScreenAudioDesktopBridge = {
      startNativeScreenAudio: started,
      stopNativeScreenAudio: stopped,
      onNativeScreenAudioChunk: (callback) => { receiveChunk = callback; return () => { receiveChunk = undefined; }; },
      acknowledgeNativeScreenAudioChunk: acknowledge,
      onNativeScreenAudioError: () => () => {},
    };
    const track = { stop: vi.fn() };
    const session = new NativeScreenAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => track as never,
    });

    expect(await session.start('window:1:0', 'video-session')).toBe(track);
    expect(started).toHaveBeenCalledWith('window:1:0', 'video-session');
    expect(fakes.addModule).toHaveBeenCalledWith(expect.stringContaining('nativeScreenAudio.worklet.js'));
    expect(fakes.addModule.mock.calls[0][0]).not.toMatch(/^(blob:|data:)/);
    expect(fakes.connect).toHaveBeenCalledOnce();
    receiveChunk?.({ sessionId: 'old-video-session', sequence: 1, frames: 480, sampleRate: 48000,
      channels: 2, pcm: new Uint8Array(480 * 8) });
    expect(fakes.port.postMessage).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    receiveChunk?.({ sessionId: 'video-session', sequence: 1, frames: 480, sampleRate: 48000,
      channels: 2, pcm: new Uint8Array(480 * 8) });
    expect(fakes.port.postMessage).toHaveBeenCalledOnce();
    const [message, transfer] = fakes.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({ type: 'chunk', sequence: 1 });
    expect((message as { pcm: ArrayBuffer }).pcm.byteLength).toBe(480 * 8);
    expect(transfer).toHaveLength(1);
    fakes.port.dispatch({ type: 'accepted', sequence: 1, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledWith('video-session', 1, 0);

    await session.stop();
    await session.stop();
    fakes.port.dispatch({ type: 'accepted', sequence: 1, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.disconnect).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('video-session');
    expect(receiveChunk).toBeUndefined();
  });

  it('stops capture and reports a trusted helper error once', async () => {
    const fakes = createFakes();
    const stopped = vi.fn(async () => ({ changed: true }));
    let reportError: ((failure: { sessionId: string; code: string }) => void) | undefined;
    const onError = vi.fn();
    const desktop: NativeScreenAudioDesktopBridge = {
      startNativeScreenAudio: vi.fn(async () => ({ sampleRate: 48000, channels: 2 as const,
        bitsPerSample: 32 as const, nominalChunkMs: 10 as const, pluginLoadMs: 12, captureReadyMs: 340 })),
      stopNativeScreenAudio: stopped,
      onNativeScreenAudioChunk: () => () => {},
      acknowledgeNativeScreenAudioChunk: () => {},
      onNativeScreenAudioError: (callback) => { reportError = callback; return () => { reportError = undefined; }; },
    };
    const session = new NativeScreenAudioSession(desktop, {
      onError,
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    await session.start('monitor:1:0', 'video-session');

    reportError?.({ sessionId: 'old-video-session', code: 'oldSessionFailure' });
    expect(onError).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    reportError?.({ sessionId: 'video-session', code: 'screenShareAudioDeviceLost' });
    reportError?.({ sessionId: 'video-session', code: 'screenShareAudioDeviceLost' });
    await session.stop();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('screenShareAudioDeviceLost');
    expect(stopped).toHaveBeenCalledOnce();
  });
});

function cleanupHarness() {
  const fakes = createFakes();
  const format = { sampleRate: 48000 as const, channels: 2 as const,
    bitsPerSample: 32 as const, nominalChunkMs: 10 as const, pluginLoadMs: 12, captureReadyMs: 340 };
  const started = vi.fn(async () => format);
  const stopped = vi.fn(async () => ({ changed: true }));
  const removeChunks = vi.fn();
  const removeErrors = vi.fn();
  const track = { stop: vi.fn() };
  const onError = vi.fn();
  let reportError!: () => void;
  const desktop: NativeScreenAudioDesktopBridge = {
    startNativeScreenAudio: started,
    stopNativeScreenAudio: stopped,
    onNativeScreenAudioChunk: () => removeChunks,
    acknowledgeNativeScreenAudioChunk: vi.fn(),
    onNativeScreenAudioError: (callback) => {
      reportError = () => callback({ sessionId: 'session', code: 'screenShareAudioFailed' });
      return removeErrors;
    },
  };
  const session = new NativeScreenAudioSession(desktop, { onError,
    createContext: () => fakes.context, createWorkletNode: () => fakes.node,
    createLocalTrack: () => track as never });
  return { ...fakes, format, started, stopped, removeChunks, removeErrors, track, onError, session,
    start: () => session.start('window:1:0', 'session'), reportError: () => reportError() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('NativeScreenAudioSession cleanup failures', () => {
  it('separates native startup from graph preparation without creating another capture or timer', async () => {
    const harness = cleanupHarness();
    const moduleReady = deferred<void>();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    harness.started.mockImplementation(async () => { now = 352; return harness.format; });
    harness.addModule.mockImplementation(() => moduleReady.promise);
    const starting = harness.start();
    await vi.waitFor(() => expect(harness.addModule).toHaveBeenCalledOnce());
    expect(harness.session.startupTiming).toEqual({ pluginLoadMs: 12, captureReadyMs: 340 });
    now = 372;
    moduleReady.resolve();
    await starting;
    expect(harness.session.startupTiming).toEqual({ pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: 20 });
    expect(harness.started).toHaveBeenCalledOnce();
    expect(await harness.start()).toBe(harness.track);
    expect(harness.session.startupTiming?.graphReadyMs).toBe(20);
    await harness.session.stop();
  });

  it('keeps completed native timings but does not claim graph readiness after module loading fails', async () => {
    const harness = cleanupHarness();
    harness.addModule.mockRejectedValue(new Error('module unavailable'));
    await expect(harness.start()).rejects.toThrow('module unavailable');
    expect(harness.session.startupTiming).toEqual({ pluginLoadMs: 12, captureReadyMs: 340 });
    expect(harness.stopped).toHaveBeenCalledOnce();
  });

  it.each(['context', 'native', 'both'] as const)('attempts every cleanup when %s fails and shares the failed stop promise', async (failure) => {
    const harness = cleanupHarness();
    await harness.start();
    const contextError = new Error('context close failed');
    const nativeError = new Error('native stop failed');
    if (failure !== 'native') harness.close.mockRejectedValue(contextError);
    if (failure !== 'context') harness.stopped.mockRejectedValue(nativeError);
    const stopping = harness.session.stop();
    expect(harness.session.stop()).toBe(stopping);
    if (failure === 'both') {
      await expect(stopping).rejects.toMatchObject({ name: 'AggregateError', errors: [contextError, nativeError] });
    } else await expect(stopping).rejects.toBe(failure === 'context' ? contextError : nativeError);
    expect(harness.removeChunks).toHaveBeenCalledOnce();
    expect(harness.removeErrors).toHaveBeenCalledOnce();
    expect(harness.port.close).toHaveBeenCalledOnce();
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.stopped).toHaveBeenCalledOnce();
    expect(harness.onError).not.toHaveBeenCalled();
    await expect(harness.session.stop()).rejects.toBeDefined();
    expect(harness.stopped).toHaveBeenCalledOnce();
  });

  it('continues cleanup after a synchronous Worklet port close failure', async () => {
    const harness = cleanupHarness();
    await harness.start();
    const error = new Error('port close failed');
    harness.port.close.mockImplementation(() => { throw error; });
    await expect(harness.session.stop()).rejects.toBe(error);
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.stopped).toHaveBeenCalledOnce();
  });

  it('requests stop before pending startup completes and waits for real cleanup', async () => {
    const harness = cleanupHarness();
    const nativeReady = deferred<typeof harness.format>();
    const startRequested = deferred<void>();
    const stopRequested = deferred<void>();
    const stopAcknowledged = deferred<{ changed: boolean }>();
    harness.started.mockImplementation(() => { startRequested.resolve(); return nativeReady.promise; });
    harness.stopped.mockImplementation(() => { stopRequested.resolve(); return stopAcknowledged.promise; });
    const starting = harness.start();
    const startResult = starting.catch((error: unknown) => error);
    await startRequested.promise;
    const stopping = harness.session.stop();
    let finished = false;
    void stopping.then(() => { finished = true; });
    await stopRequested.promise;
    expect(harness.addModule).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    expect(harness.session.stop()).toBe(stopping);
    stopAcknowledged.resolve({ changed: true });
    await stopping;
    nativeReady.resolve(harness.format);
    expect(await startResult).toMatchObject({ message: 'screenAudioSessionStopped' });
    expect(harness.stopped).toHaveBeenCalledOnce();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it('preserves startup and cleanup errors together', async () => {
    const harness = cleanupHarness();
    const startupError = new Error('worklet initialization failed');
    const cleanupError = new Error('context close failed');
    harness.addModule.mockRejectedValue(startupError);
    harness.close.mockRejectedValue(cleanupError);
    await expect(harness.start()).rejects.toMatchObject({ name: 'AggregateError', errors: [startupError, cleanupError] });
    expect(harness.removeChunks).toHaveBeenCalledOnce();
    expect(harness.removeErrors).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.stopped).toHaveBeenCalledOnce();
  });

  it('observes failed cleanup after a capture error without reporting an intentional stop as a new capture fault', async () => {
    const harness = cleanupHarness();
    await harness.start();
    const logged = deferred<void>();
    const log = vi.spyOn(console, 'error').mockImplementation(() => { logged.resolve(); });
    const error = new Error('native stop failed');
    harness.stopped.mockRejectedValue(error);
    harness.reportError();
    await logged.promise;
    await expect(harness.session.stop()).rejects.toBe(error);
    harness.reportError();
    expect(harness.onError).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.any(String), error);
    expect(harness.stopped).toHaveBeenCalledOnce();
  });
});

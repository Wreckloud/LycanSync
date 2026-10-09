import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeMicrophoneAudioSession, type NativeMicrophoneDesktopBridge } from './nativeMicrophoneAudio';

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
    sampleRate: 48_000,
    state: 'running',
    audioWorklet: { addModule: vi.fn(async (_url: string) => {}) },
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => { context.state = 'closed'; }),
  };
  return { context: context as unknown as AudioContext, node: node as unknown as AudioWorkletNode,
    port, addModule: context.audioWorklet.addModule, close: context.close, connect: node.connect, disconnect: node.disconnect };
}

afterEach(() => vi.restoreAllMocks());

describe('NativeMicrophoneAudioSession', () => {
  it('sends bounded mono PCM to the worklet and releases the capture session', async () => {
    const fakes = createFakes();
    const settings = { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true };
    const started = vi.fn(async () => ({ sampleRate: 48_000 as const, channels: 1 as const,
      bitsPerSample: 32 as const, nominalChunkMs: 10 as const }));
    const stopped = vi.fn(async () => ({ changed: true }));
    const configured = vi.fn(async () => ({ changed: true }));
    const acknowledge = vi.fn();
    let receiveChunk: Parameters<NativeMicrophoneDesktopBridge['onNativeMicrophoneChunk']>[0] | undefined;
    const desktop: NativeMicrophoneDesktopBridge = {
      startNativeMicrophone: started,
      configureNativeMicrophone: configured,
      stopNativeMicrophone: stopped,
      onNativeMicrophoneChunk: (callback) => { receiveChunk = callback; return () => { receiveChunk = undefined; }; },
      acknowledgeNativeMicrophoneChunk: acknowledge,
      onNativeMicrophoneError: () => () => {},
    };
    const track = { stop: vi.fn() };
    const session = new NativeMicrophoneAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => track as never,
    });

    expect(await session.start('microphone-session', settings)).toBe(track);
    expect(fakes.addModule).toHaveBeenCalledWith(expect.stringContaining('nativeMicrophoneAudio.worklet.js'));
    expect(fakes.addModule.mock.calls[0][0]).not.toMatch(/^(blob:|data:)/);
    await session.configure({ ...settings, inputGain: 0.75 });
    receiveChunk?.({ sessionId: 'microphone-session', sequence: 3, frames: 480, sampleRate: 48_000,
      channels: 1, pcm: new Uint8Array(480 * 4) });
    expect(fakes.port.postMessage).toHaveBeenCalledOnce();
    const [message, transfer] = fakes.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({ type: 'chunk', sequence: 3 });
    expect((message as { pcm: ArrayBuffer }).pcm.byteLength).toBe(480 * 4);
    expect(transfer).toHaveLength(1);
    fakes.port.dispatch({ type: 'accepted', sequence: 3, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledWith('microphone-session', 3, 0);

    await session.stop();
    await session.stop();
    fakes.port.dispatch({ type: 'accepted', sequence: 3, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledWith('microphone-session', settings);
    expect(configured).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('microphone-session');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.disconnect).toHaveBeenCalledOnce();
    expect(receiveChunk).toBeUndefined();
  });

  it('does not send malformed audio chunks to the renderer track', async () => {
    const fakes = createFakes();
    let receiveChunk: Parameters<NativeMicrophoneDesktopBridge['onNativeMicrophoneChunk']>[0] | undefined;
    const acknowledge = vi.fn();
    const desktop: NativeMicrophoneDesktopBridge = {
      startNativeMicrophone: vi.fn(async () => ({ sampleRate: 48_000 as const, channels: 1 as const,
        bitsPerSample: 32 as const, nominalChunkMs: 10 as const })),
      configureNativeMicrophone: vi.fn(async () => ({ changed: true })),
      stopNativeMicrophone: vi.fn(async () => ({ changed: true })),
      onNativeMicrophoneChunk: (callback) => { receiveChunk = callback; return () => { receiveChunk = undefined; }; },
      acknowledgeNativeMicrophoneChunk: acknowledge,
      onNativeMicrophoneError: () => () => {},
    };
    const session = new NativeMicrophoneAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    await session.start('microphone-session', { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true });
    receiveChunk?.({ sessionId: 'microphone-session', sequence: 4, frames: 479, sampleRate: 48_000,
      channels: 1, pcm: new Uint8Array(479 * 4) });
    expect(fakes.port.postMessage).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith('microphone-session', 4, 1);
    await session.stop();
  });

  it('ignores late PCM from a stopped session while a new session is active', async () => {
    const fakes = createFakes();
    let receiveChunk: Parameters<NativeMicrophoneDesktopBridge['onNativeMicrophoneChunk']>[0] | undefined;
    const acknowledge = vi.fn();
    const desktop: NativeMicrophoneDesktopBridge = {
      startNativeMicrophone: vi.fn(async () => ({ sampleRate: 48_000 as const, channels: 1 as const,
        bitsPerSample: 32 as const, nominalChunkMs: 10 as const })),
      configureNativeMicrophone: vi.fn(async () => ({ changed: true })),
      stopNativeMicrophone: vi.fn(async () => ({ changed: true })),
      onNativeMicrophoneChunk: (callback) => { receiveChunk = callback; return () => { receiveChunk = undefined; }; },
      acknowledgeNativeMicrophoneChunk: acknowledge,
      onNativeMicrophoneError: () => () => {},
    };
    const session = new NativeMicrophoneAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    await session.start('session-b', { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true });

    receiveChunk?.({ sessionId: 'session-a', sequence: 1, frames: 480, sampleRate: 48_000,
      channels: 1, pcm: new Uint8Array(480 * 4) });
    expect(fakes.port.postMessage).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();

    receiveChunk?.({ sessionId: 'session-b', sequence: 1, frames: 480, sampleRate: 48_000,
      channels: 1, pcm: new Uint8Array(480 * 4) });
    expect(fakes.port.postMessage).toHaveBeenCalledOnce();
    fakes.port.dispatch({ type: 'accepted', sequence: 1, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledWith('session-b', 1, 0);
    await session.stop();
  });
});

function cleanupHarness() {
  const fakes = createFakes();
  const format = { sampleRate: 48000 as const, channels: 1 as const,
    bitsPerSample: 32 as const, nominalChunkMs: 10 as const };
  const started = vi.fn(async () => format);
  const stopped = vi.fn(async () => ({ changed: true }));
  const removeChunks = vi.fn();
  const removeErrors = vi.fn();
  const track = { stop: vi.fn() };
  const onError = vi.fn();
  let reportError!: () => void;
  const desktop: NativeMicrophoneDesktopBridge = {
    startNativeMicrophone: started,
    stopNativeMicrophone: stopped,
    configureNativeMicrophone: vi.fn(async () => ({ changed: true })),
    onNativeMicrophoneChunk: () => removeChunks,
    acknowledgeNativeMicrophoneChunk: vi.fn(),
    onNativeMicrophoneError: (callback) => { reportError = () => callback({ sessionId: 'session', code: 'audioDeviceUnavailable' }); return removeErrors; },
  };
  const session = new NativeMicrophoneAudioSession(desktop, { onError,
    createContext: () => fakes.context, createWorkletNode: () => fakes.node,
    createLocalTrack: () => track as never });
  return { ...fakes, format, started, stopped, removeChunks, removeErrors, track, onError, session,
    start: () => session.start('session', { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true }), reportError: () => reportError() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('NativeMicrophoneAudioSession cleanup failures', () => {
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

  it('waits for late startup and its native stop acknowledgement after cancellation', async () => {
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
    nativeReady.resolve(harness.format);
    await stopRequested.promise;
    expect(finished).toBe(false);
    expect(harness.session.stop()).toBe(stopping);
    stopAcknowledged.resolve({ changed: true });
    await stopping;
    expect(await startResult).toMatchObject({ message: 'microphoneSessionStopped' });
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
    expect(harness.started).not.toHaveBeenCalled();
    expect(harness.stopped).not.toHaveBeenCalled();
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

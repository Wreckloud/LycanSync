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
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => { context.state = 'closed'; }),
  };
  return { context: context as unknown as AudioContext, node: node as unknown as AudioWorkletNode,
    port, close: context.close, connect: node.connect, disconnect: node.disconnect };
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
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:microphone-worklet');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const session = new NativeMicrophoneAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => track as never,
    });

    expect(await session.start('microphone-session', settings)).toBe(track);
    await session.configure({ ...settings, inputGain: 0.75 });
    receiveChunk?.({ sequence: 3, frames: 480, sampleRate: 48_000, channels: 1, pcm: new Uint8Array(480 * 4) });
    expect(fakes.port.postMessage).toHaveBeenCalledOnce();
    const [message, transfer] = fakes.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({ type: 'chunk', sequence: 3 });
    expect((message as { pcm: ArrayBuffer }).pcm.byteLength).toBe(480 * 4);
    expect(transfer).toHaveLength(1);
    fakes.port.dispatch({ type: 'accepted', sequence: 3, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledWith(3, 0);

    await session.stop();
    await session.stop();
    expect(started).toHaveBeenCalledWith('microphone-session', settings);
    expect(configured).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('microphone-session');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.disconnect).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
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
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:microphone-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const session = new NativeMicrophoneAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    await session.start('microphone-session', { inputGain: 1, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true });
    receiveChunk?.({ sequence: 4, frames: 479, sampleRate: 48_000, channels: 1, pcm: new Uint8Array(479 * 4) });
    expect(fakes.port.postMessage).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith(4, 1);
    await session.stop();
  });
});

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
    audioWorklet: { addModule: vi.fn(async () => {}) },
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
      bitsPerSample: 32 as const, nominalChunkMs: 10 as const }));
    const stopped = vi.fn(async () => ({ changed: true }));
    const acknowledge = vi.fn();
    let receiveChunk: ((chunk: { sequence: number; frames: number; sampleRate: number;
      channels: 2; pcm: Uint8Array }) => void) | undefined;
    const desktop: NativeScreenAudioDesktopBridge = {
      startNativeScreenAudio: started,
      stopNativeScreenAudio: stopped,
      onNativeScreenAudioChunk: (callback) => { receiveChunk = callback; return () => { receiveChunk = undefined; }; },
      acknowledgeNativeScreenAudioChunk: acknowledge,
      onNativeScreenAudioError: () => () => {},
    };
    const track = { stop: vi.fn() };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-audio-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const session = new NativeScreenAudioSession(desktop, {
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => track as never,
    });

    expect(await session.start('window:1:0', 'video-session')).toBe(track);
    expect(started).toHaveBeenCalledWith('window:1:0', 'video-session');
    expect(fakes.addModule).toHaveBeenCalledOnce();
    expect(fakes.connect).toHaveBeenCalledOnce();
    receiveChunk?.({ sequence: 1, frames: 480, sampleRate: 48000, channels: 2, pcm: new Uint8Array(480 * 8) });
    expect(fakes.port.postMessage).toHaveBeenCalledOnce();
    const [message, transfer] = fakes.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({ type: 'chunk', sequence: 1 });
    expect((message as { pcm: ArrayBuffer }).pcm.byteLength).toBe(480 * 8);
    expect(transfer).toHaveLength(1);
    fakes.port.dispatch({ type: 'accepted', sequence: 1, droppedChunks: 0 });
    expect(acknowledge).toHaveBeenCalledWith(1, 0);

    await session.stop();
    await session.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.disconnect).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('video-session');
    expect(receiveChunk).toBeUndefined();
  });

  it('stops capture and reports a trusted helper error once', async () => {
    const fakes = createFakes();
    const stopped = vi.fn(async () => ({ changed: true }));
    let reportError: ((code: string) => void) | undefined;
    const onError = vi.fn();
    const desktop: NativeScreenAudioDesktopBridge = {
      startNativeScreenAudio: vi.fn(async () => ({ sampleRate: 48000, channels: 2 as const,
        bitsPerSample: 32 as const, nominalChunkMs: 10 as const })),
      stopNativeScreenAudio: stopped,
      onNativeScreenAudioChunk: () => () => {},
      acknowledgeNativeScreenAudioChunk: () => {},
      onNativeScreenAudioError: (callback) => { reportError = callback; return () => { reportError = undefined; }; },
    };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-audio-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const session = new NativeScreenAudioSession(desktop, {
      onError,
      createContext: () => fakes.context,
      createWorkletNode: () => fakes.node,
      createLocalTrack: () => ({ stop: vi.fn() }) as never,
    });
    await session.start('monitor:1:0', 'video-session');

    reportError?.('screenShareAudioDeviceLost');
    reportError?.('screenShareAudioDeviceLost');
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('screenShareAudioDeviceLost');
    expect(stopped).toHaveBeenCalledOnce();
  });
});

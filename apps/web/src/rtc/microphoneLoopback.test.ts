import { describe, expect, it, vi } from 'vitest';
import { MicrophoneLoopback } from './microphoneLoopback';

function createFakes() {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop: vi.fn(), clone: vi.fn() });
  const gain = { gain: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { state: 'running', currentTime: 2, destination: {}, createGain: () => gain,
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  return { track, gain, context };
}

describe('MicrophoneLoopback', () => {
  it('cancels during startup without stopping the published microphone', async () => {
    const { track, gain, context } = createFakes();
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve; }));
    const stopped = vi.fn();
    const createPeer = vi.fn();
    const loopback = new MicrophoneLoopback({ createContext: () => context as unknown as AudioContext,
      createPeer, onStopped: stopped });
    const starting = loopback.start(track as unknown as MediaStreamTrack, 0.75, 64000, true);
    loopback.setVolume(0.5);
    loopback.stop();
    loopback.stop();
    resume();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 2);
    expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(createPeer).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('stops audition when the published source ends', async () => {
    const { track, context } = createFakes();
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve; }));
    const stopped = vi.fn();
    const loopback = new MicrophoneLoopback({ createContext: () => context as unknown as AudioContext, onStopped: stopped });
    const starting = loopback.start(track as unknown as MediaStreamTrack, 1, 64000, true);
    track.dispatchEvent(new Event('ended'));
    resume();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(stopped).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('releases the audio context on playback initialization failure', async () => {
    const { track, context } = createFakes();
    context.resume.mockRejectedValue(new Error('output unavailable'));
    const loopback = new MicrophoneLoopback({ createContext: () => context as unknown as AudioContext });
    await expect(loopback.start(track as unknown as MediaStreamTrack, 1, 64000, true)).rejects.toThrow('output unavailable');
    expect(context.close).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('rejects a stopped microphone before allocating resources', async () => {
    const { track } = createFakes();
    track.readyState = 'ended';
    const createContext = vi.fn();
    const loopback = new MicrophoneLoopback({ createContext });
    await expect(loopback.start(track as unknown as MediaStreamTrack, 1, 64000, true)).rejects.toThrow('麦克风音轨已停止');
    expect(createContext).not.toHaveBeenCalled();
  });
});

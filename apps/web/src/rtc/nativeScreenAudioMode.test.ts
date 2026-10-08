import { describe, expect, it } from 'vitest';
import { canSelectNativeSource, nativeScreenAudioMode, shouldDefaultShareAudio,
  resolveNativeScreenAudioCapability, shouldShareAudioInNativeSelection } from './nativeScreenAudioMode';

describe('native screen audio mode', () => {
  it('defaults process loopback on for the Windows 10 19041+ process capability', () => {
    const mode = nativeScreenAudioMode({ available: true, reason: 'windowsApplicationLoopbackProcessTree' });
    expect(mode).toBe('process');
    expect(shouldDefaultShareAudio(mode)).toBe(true);
  });

  it('requires explicit opt-in for default-output system mix', () => {
    const mode = nativeScreenAudioMode({ available: true, reason: 'windowsSystemMixLoopback' });
    expect(mode).toBe('systemMix');
    expect(shouldDefaultShareAudio(mode)).toBe(false);
  });

  it('does not enable unknown or unavailable capture capabilities', () => {
    for (const capability of [
      undefined,
      { available: false, reason: 'windowsEventDrivenLoopbackRequiresBuild15063' },
      { available: true, reason: 'unimplementedGenericAudioCapture' },
    ]) {
      const mode = nativeScreenAudioMode(capability);
      expect(mode).toBe('unavailable');
      expect(shouldDefaultShareAudio(mode)).toBe(false);
    }
  });

  it('blocks a source that arrives before audio capability and keeps legacy audio opt-in', async () => {
    let resolveCapability!: (capability: { available: boolean; reason: string }) => void;
    const capabilityRequest = new Promise<{ available: boolean; reason: string }>((resolve) => {
      resolveCapability = resolve;
    });
    const sources = await Promise.resolve([{ id: 'window:1:0' }]);
    let capabilityReady = false;
    let mode = nativeScreenAudioMode(undefined);
    let shareAudioChecked = false;
    const chooseSource = () => {
      if (!canSelectNativeSource(capabilityReady)) return null;
      return {
        sourceId: sources[0].id,
        shareAudio: shouldShareAudioInNativeSelection(capabilityReady, mode, shareAudioChecked),
      };
    };

    expect(sources).toHaveLength(1);
    expect(canSelectNativeSource(capabilityReady)).toBe(false);
    expect(chooseSource()).toBeNull();

    resolveCapability({ available: true, reason: 'windowsSystemMixLoopback' });
    mode = nativeScreenAudioMode(await capabilityRequest);
    shareAudioChecked = shouldDefaultShareAudio(mode);
    capabilityReady = true;

    expect(canSelectNativeSource(capabilityReady)).toBe(true);
    expect(chooseSource()).toEqual({ sourceId: 'window:1:0', shareAudio: false });
  });

  it('keeps source selection blocked and marks capability failure when lookup rejects', async () => {
    let rejectCapability!: (reason: Error) => void;
    const capabilityRequest = new Promise<{ available: boolean; reason: string }>((_resolve, reject) => {
      rejectCapability = reject;
    });
    const resolvedCapability = resolveNativeScreenAudioCapability(capabilityRequest.then((capability) => ({
      screenShareAudioCapture: capability,
    })));
    const sources = await Promise.resolve([{ id: 'window:1:0' }]);
    let capabilityReady = false;
    let capabilityFailed = false;
    const chooseSource = () => canSelectNativeSource(capabilityReady, capabilityFailed)
      ? { sourceId: sources[0].id }
      : null;

    expect(chooseSource()).toBeNull();
    rejectCapability(new Error('capabilityUnavailable'));
    const state = await resolvedCapability;
    expect(state).toEqual({ mode: 'unavailable', available: false, failed: true });
    capabilityReady = true;
    capabilityFailed = state.failed;

    expect(canSelectNativeSource(capabilityReady, capabilityFailed)).toBe(false);
    expect(chooseSource()).toBeNull();
  });
});

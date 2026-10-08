export type NativeScreenAudioMode = 'process' | 'systemMix' | 'unavailable';
export interface NativeScreenAudioCapabilityState {
  mode: NativeScreenAudioMode;
  available: boolean;
  failed: boolean;
}

export async function resolveNativeScreenAudioCapability(
  capabilities: Promise<Record<string, { available: boolean; reason: string }>>,
): Promise<NativeScreenAudioCapabilityState> {
  try {
    const mode = nativeScreenAudioMode((await capabilities).screenShareAudioCapture);
    return { mode, available: mode !== 'unavailable', failed: false };
  } catch {
    return { mode: 'unavailable', available: false, failed: true };
  }
}

export function nativeScreenAudioMode(
  capability: { available: boolean; reason: string } | undefined,
): NativeScreenAudioMode {
  if (!capability?.available) return 'unavailable';
  if (capability.reason === 'windowsApplicationLoopbackProcessTree') return 'process';
  if (capability.reason === 'windowsSystemMixLoopback') return 'systemMix';
  return 'unavailable';
}

export function shouldDefaultShareAudio(mode: NativeScreenAudioMode): boolean {
  return mode === 'process';
}

export function canSelectNativeSource(audioCapabilityReady: boolean, audioCapabilityFailed = false): boolean {
  return audioCapabilityReady && !audioCapabilityFailed;
}

export function shouldShareAudioInNativeSelection(
  audioCapabilityReady: boolean,
  mode: NativeScreenAudioMode,
  shareAudioChecked: boolean,
): boolean {
  return audioCapabilityReady && mode !== 'unavailable' && shareAudioChecked;
}

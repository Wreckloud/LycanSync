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

export function readScreenShareAudioPreference(mode: NativeScreenAudioMode): boolean {
  if (mode === 'unavailable') return false;
  const stored = localStorage.getItem(`lycansync.screen-share-audio.${mode}`);
  return stored === 'true' || (stored !== 'false' && shouldDefaultShareAudio(mode));
}

export function saveScreenShareAudioPreference(mode: NativeScreenAudioMode, enabled: boolean) {
  if (mode === 'unavailable') throw new Error('screenShareAudioUnavailable');
  // 应用声音与全部系统声音分开记忆，换设备能力时不能扩大原先的共享范围。
  localStorage.setItem(`lycansync.screen-share-audio.${mode}`, String(enabled));
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

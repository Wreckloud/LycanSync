import { onScopeDispose, watch, type Ref } from 'vue';
import type { AudioOutputBinding, AudioOutputRouting } from './useAudioOutput';
import { ENTRANCE_SOUND_MAX_DURATION_SECONDS } from './entranceSound';
import { normalizeAudioVolume } from './audioPreferences';
import type { CallSoundEvent, useCallSoundPreferences } from '../settings/useCallSoundPreferences';

const DEFAULT_ENTRANCE_DELAY_MS = 700;
const EVENT_SOUNDS: Record<CallSoundEvent, { file: string; channel: string }> = {
  joined: { file: 'navigation_forward-selection', channel: 'connection' },
  left: { file: 'navigation_backward-selection', channel: 'connection' },
  participantJoined: { file: 'navigation_forward-selection', channel: 'participant' },
  participantLeft: { file: 'navigation_backward-selection', channel: 'participant' },
  microphoneOn: { file: 'navigation_forward-selection-minimal', channel: 'microphone' },
  microphoneOff: { file: 'navigation_backward-selection-minimal', channel: 'microphone' },
  screenShareStarted: { file: 'navigation_selection-complete-celebration', channel: 'sharing' },
  screenShareStopped: { file: 'alert_error-02', channel: 'sharing' },
  recordingStarted: { file: 'notification_simple-01', channel: 'recording' },
  recordingStopped: { file: 'navigation-cancel', channel: 'recording' },
};

/** 提示音随应用离线交付，按需解码并在当前会话复用，沿用所选的本机输出设备。 */
export function useCallSounds(outputVolume: Ref<number>, preferences: ReturnType<typeof useCallSoundPreferences>, output?: AudioOutputRouting) {
  const pendingEntrances = new Map<string, ReturnType<typeof setTimeout>>();
  const activeSounds = new Map<AudioScheduledSourceNode, { gain: GainNode; preview: boolean }>();
  const buffers = new Map<string, Promise<{ buffer: AudioBuffer; gain: number }>>();
  const requests = new Map<string, symbol>();
  const loading = new AbortController();
  let context: AudioContext | null = null;
  let outputBinding: AudioOutputBinding | undefined;
  let disposed = false;
  let previewVersion = 0;

  function volume() { return normalizeAudioVolume(outputVolume.value) * preferences.volume.value; }
  function canPlay(event: CallSoundEvent, preview = false) {
    return !disposed && (output?.available.value ?? true) && volume() > 0 && (preview || preferences.enabled[event]);
  }
  function track(source: AudioScheduledSourceNode, gain: GainNode, preview: boolean) {
    activeSounds.set(source, { gain, preview });
    source.onended = () => { source.disconnect(); gain.disconnect(); activeSounds.delete(source); };
  }
  function stopPreview() {
    previewVersion++;
    for (const [source, sound] of activeSounds) {
      if (!sound.preview) continue;
      source.stop(); source.disconnect(); sound.gain.disconnect(); activeSounds.delete(source);
    }
  }

  async function audioContext() {
    if (!context) {
      context = new AudioContext();
      outputBinding = output?.bindContext(context);
    }
    const current = context;
    const resumed = current.state === 'suspended' ? current.resume() : undefined;
    if (outputBinding) await Promise.all([outputBinding.ready, resumed]);
    else if (resumed) await resumed;
    return current;
  }

  function soundBuffer(file: string, currentContext: AudioContext) {
    const cached = buffers.get(file);
    if (cached) return cached;
    const decoded = (async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}sounds/material/${file}.ogg`, { signal: loading.signal });
      if (!response.ok) throw new Error(`soundAssetUnavailable:${response.status}`);
      const bytes = await response.arrayBuffer();
      if (disposed) throw new Error('soundPlaybackDisposed');
      const buffer = await currentContext.decodeAudioData(bytes);
      let peak = 0;
      let energy = 0;
      let samples = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
      }
      if (peak < 0.000001) throw new Error('soundAssetSilent');
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const value of buffer.getChannelData(channel)) {
          if (Math.abs(value) <= peak * 0.01) continue;
          energy += value * value; samples++;
        }
      }
      // 与试听页相同的有效声音均方根增益；保留音色与尾音，并限制最大峰值。
      const gain = Math.min(4, 10 ** (-24 / 20) / Math.sqrt(energy / samples), 0.5 / peak);
      return { buffer, gain };
    })().catch(error => { buffers.delete(file); throw error; });
    buffers.set(file, decoded);
    return decoded;
  }

  async function playEvent(event: CallSoundEvent, preview = false, identity = '') {
    const clip = EVENT_SOUNDS[event];
    const key = preview ? 'preview' : `${clip.channel}:${identity}`;
    const request = Symbol();
    requests.set(key, request);
    const version = previewVersion;
    try {
      if (!canPlay(event, preview)) return false;
      const currentContext = await audioContext();
      if (!canPlay(event, preview) || requests.get(key) !== request || (preview && version !== previewVersion)) return false;
      const prepared = await soundBuffer(clip.file, currentContext);
      if (!canPlay(event, preview) || requests.get(key) !== request || (preview && version !== previewVersion)) return false;
      const source = currentContext.createBufferSource();
      const gain = currentContext.createGain();
      source.buffer = prepared.buffer;
      gain.gain.value = prepared.gain * volume();
      source.connect(gain).connect(currentContext.destination);
      track(source, gain, preview);
      source.start();
      return true;
    } catch (error) {
      // 提示音失败不打断通话；设置页试听仍明确返回失败，资源问题留诊断线索。
      if (!disposed) console.warn('[call-sounds] playback failed', event, error);
      return false;
    } finally {
      if (requests.get(key) === request) requests.delete(key);
    }
  }

  async function playCustomEntrance(bytes: Uint8Array) {
    if (!canPlay('participantJoined') || !preferences.customEntrances.value) return false;
    try {
      const currentContext = await audioContext();
      if (!canPlay('participantJoined') || !preferences.customEntrances.value) return false;
      const audioBuffer = await currentContext.decodeAudioData(bytes.slice().buffer);
      if (!canPlay('participantJoined') || !preferences.customEntrances.value) return false;
      if (audioBuffer.duration > ENTRANCE_SOUND_MAX_DURATION_SECONDS + 0.05) return false;
      const source = currentContext.createBufferSource();
      const gain = currentContext.createGain();
      source.buffer = audioBuffer;
      gain.gain.value = 0.5 * volume();
      source.connect(gain).connect(currentContext.destination);
      source.start();
      track(source, gain, false);
      return true;
    } catch {
      return false;
    }
  }

  function clearPendingEntrance(identity: string) {
    const timer = pendingEntrances.get(identity);
    if (timer !== undefined) clearTimeout(timer);
    pendingEntrances.delete(identity);
  }

  function participantJoined(identity: string) {
    clearPendingEntrance(identity);
    pendingEntrances.set(identity, setTimeout(() => {
      pendingEntrances.delete(identity);
      void playEvent('participantJoined', false, identity);
    }, DEFAULT_ENTRANCE_DELAY_MS));
  }

  function participantEntrancePending(identity: string) {
    clearPendingEntrance(identity);
  }

  function participantEntranceFailed(identity: string) {
    participantJoined(identity);
  }

  function participantLeft(identity: string) {
    clearPendingEntrance(identity);
    void playEvent('participantLeft', false, identity);
  }

  async function participantEntranceSound(identity: string, bytes: Uint8Array) {
    clearPendingEntrance(identity);
    if (!await playCustomEntrance(bytes)) await playEvent('participantJoined', false, identity);
  }

  watch(() => output?.available.value ?? true, (available) => {
    if (available) return;
    previewVersion++;
    requests.clear();
    for (const [source, sound] of activeSounds) { source.stop(); source.disconnect(); sound.gain.disconnect(); }
    activeSounds.clear();
  }, { flush: 'sync' });

  onScopeDispose(() => {
    disposed = true;
    loading.abort(); buffers.clear(); requests.clear();
    pendingEntrances.forEach(clearTimeout);
    pendingEntrances.clear();
    for (const [source, sound] of activeSounds) { source.stop(); source.disconnect(); sound.gain.disconnect(); }
    activeSounds.clear();
    outputBinding?.release();
    if (context) void context.close();
    context = null;
  });

  return {
    joined: () => playEvent('joined'),
    left: () => playEvent('left'),
    screenShareStarted: () => playEvent('screenShareStarted'),
    screenShareStopped: () => playEvent('screenShareStopped'),
    microphoneChanged: (enabled: boolean) => playEvent(enabled ? 'microphoneOn' : 'microphoneOff'),
    recordingStarted: () => playEvent('recordingStarted'),
    recordingStopped: () => playEvent('recordingStopped'),
    preview: (event: CallSoundEvent) => { stopPreview(); return playEvent(event, true); },
    stopPreview,
    participantJoined,
    participantLeft,
    participantEntrancePending,
    participantEntranceFailed,
    participantEntranceSound,
  };
}

import { onScopeDispose, type Ref } from 'vue';
import { ENTRANCE_SOUND_MAX_DURATION_SECONDS } from './entranceSound';
import { normalizeAudioVolume } from './audioPreferences';
import type { CallSoundEvent, useCallSoundPreferences } from '../settings/useCallSoundPreferences';

type Tone = Readonly<{ frequency: number; offset: number; duration: number }>;

const DEFAULT_ENTRANCE_DELAY_MS = 700;
const JOIN_TONES: Tone[] = [
  { frequency: 520, offset: 0, duration: 0.09 },
  { frequency: 700, offset: 0.08, duration: 0.12 },
];
const LEAVE_TONES: Tone[] = [
  { frequency: 650, offset: 0, duration: 0.09 },
  { frequency: 430, offset: 0.08, duration: 0.14 },
];
const SCREEN_SHARE_TONES: Tone[] = [
  { frequency: 440, offset: 0, duration: 0.07 },
  { frequency: 660, offset: 0.06, duration: 0.08 },
  { frequency: 880, offset: 0.13, duration: 0.12 },
];
const SCREEN_SHARE_STOP_TONES: Tone[] = [
  { frequency: 880, offset: 0, duration: 0.07 },
  { frequency: 620, offset: 0.06, duration: 0.08 },
  { frequency: 440, offset: 0.13, duration: 0.12 },
];

/** 播放通话状态提示；默认音效由振荡器生成，不增加静态资源和网络请求。 */
export function useCallSounds(outputVolume: Ref<number>, preferences: ReturnType<typeof useCallSoundPreferences>) {
  const pendingEntrances = new Map<string, ReturnType<typeof setTimeout>>();
  const activeSounds = new Map<AudioScheduledSourceNode, { gain: GainNode; preview: boolean }>();
  let context: AudioContext | null = null;
  let disposed = false;
  let previewVersion = 0;
  const eventTones: Record<CallSoundEvent, Tone[]> = {
    joined: JOIN_TONES, left: LEAVE_TONES, participantJoined: JOIN_TONES, participantLeft: LEAVE_TONES,
    screenShareStarted: SCREEN_SHARE_TONES, screenShareStopped: SCREEN_SHARE_STOP_TONES,
    microphoneOn: [{ frequency: 620, offset: 0, duration: 0.1 }],
    microphoneOff: [{ frequency: 420, offset: 0, duration: 0.1 }],
    listeningOn: [{ frequency: 760, offset: 0, duration: 0.1 }],
    listeningOff: [{ frequency: 340, offset: 0, duration: 0.1 }],
  };

  function volume() { return normalizeAudioVolume(outputVolume.value) * preferences.volume.value; }
  function canPlay(event: CallSoundEvent, preview = false) {
    return !disposed && volume() > 0 && (preview || preferences.enabled[event]);
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
    context ??= new AudioContext();
    if (context.state === 'suspended') await context.resume();
    return context;
  }

  async function playEvent(event: CallSoundEvent, preview = false) {
    if (!canPlay(event, preview)) return false;
    const version = previewVersion;
    try {
      const currentContext = await audioContext();
      if (!canPlay(event, preview) || (preview && version !== previewVersion)) return false;
      const start = currentContext.currentTime;
      for (const tone of eventTones[event]) {
        const oscillator = currentContext.createOscillator();
        const gain = currentContext.createGain();
        const beginsAt = start + tone.offset;
        const endsAt = beginsAt + tone.duration;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(tone.frequency, beginsAt);
        gain.gain.setValueAtTime(0.0001, beginsAt);
        gain.gain.exponentialRampToValueAtTime(0.12 * volume(), beginsAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
        oscillator.connect(gain).connect(currentContext.destination);
        oscillator.start(beginsAt);
        oscillator.stop(endsAt + 0.01);
        track(oscillator, gain, preview);
      }
      return true;
    } catch {
      // 浏览器禁止自动播放时保持静默；加入语音后的“允许播放声音”仍由 LiveKit 处理。
      return false;
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
      void playEvent('participantJoined');
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
    void playEvent('participantLeft');
  }

  async function participantEntranceSound(identity: string, bytes: Uint8Array) {
    clearPendingEntrance(identity);
    if (!await playCustomEntrance(bytes)) void playEvent('participantJoined');
  }

  onScopeDispose(() => {
    disposed = true;
    pendingEntrances.forEach(clearTimeout);
    pendingEntrances.clear();
    for (const [source, sound] of activeSounds) { source.stop(); source.disconnect(); sound.gain.disconnect(); }
    activeSounds.clear();
    if (context) void context.close();
    context = null;
  });

  return {
    joined: () => playEvent('joined'),
    left: () => playEvent('left'),
    screenShareStarted: () => playEvent('screenShareStarted'),
    screenShareStopped: () => playEvent('screenShareStopped'),
    microphoneChanged: (enabled: boolean) => playEvent(enabled ? 'microphoneOn' : 'microphoneOff'),
    listeningChanged: (enabled: boolean) => playEvent(enabled ? 'listeningOn' : 'listeningOff'),
    preview: (event: CallSoundEvent) => { stopPreview(); return playEvent(event, true); },
    stopPreview,
    participantJoined,
    participantLeft,
    participantEntrancePending,
    participantEntranceFailed,
    participantEntranceSound,
  };
}

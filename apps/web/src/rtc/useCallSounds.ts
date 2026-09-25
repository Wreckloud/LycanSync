import { onScopeDispose, type Ref } from 'vue';
import { ENTRANCE_SOUND_MAX_DURATION_SECONDS } from './entranceSound';
import { normalizeAudioVolume } from './audioPreferences';

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
export function useCallSounds(outputVolume: Ref<number>) {
  const pendingEntrances = new Map<string, ReturnType<typeof setTimeout>>();
  let context: AudioContext | null = null;

  async function audioContext() {
    context ??= new AudioContext();
    if (context.state === 'suspended') await context.resume();
    return context;
  }

  async function playTones(tones: Tone[]) {
    if (outputVolume.value <= 0) return;
    try {
      const currentContext = await audioContext();
      const start = currentContext.currentTime;
      for (const tone of tones) {
        const oscillator = currentContext.createOscillator();
        const gain = currentContext.createGain();
        const beginsAt = start + tone.offset;
        const endsAt = beginsAt + tone.duration;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(tone.frequency, beginsAt);
        gain.gain.setValueAtTime(0.0001, beginsAt);
        gain.gain.exponentialRampToValueAtTime(0.12 * normalizeAudioVolume(outputVolume.value), beginsAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
        oscillator.connect(gain).connect(currentContext.destination);
        oscillator.start(beginsAt);
        oscillator.stop(endsAt + 0.01);
      }
    } catch {
      // 浏览器禁止自动播放时保持静默；加入语音后的“允许播放声音”仍由 LiveKit 处理。
    }
  }

  async function playCustomEntrance(bytes: Uint8Array) {
    if (outputVolume.value <= 0) return false;
    try {
      const currentContext = await audioContext();
      const audioBuffer = await currentContext.decodeAudioData(bytes.slice().buffer);
      if (audioBuffer.duration > ENTRANCE_SOUND_MAX_DURATION_SECONDS + 0.05) return false;
      const source = currentContext.createBufferSource();
      const gain = currentContext.createGain();
      source.buffer = audioBuffer;
      gain.gain.value = 0.5 * normalizeAudioVolume(outputVolume.value);
      source.connect(gain).connect(currentContext.destination);
      source.start();
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
      void playTones(JOIN_TONES);
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
    void playTones(LEAVE_TONES);
  }

  async function participantEntranceSound(identity: string, bytes: Uint8Array) {
    clearPendingEntrance(identity);
    if (!await playCustomEntrance(bytes)) void playTones(JOIN_TONES);
  }

  onScopeDispose(() => {
    pendingEntrances.forEach(clearTimeout);
    pendingEntrances.clear();
    if (context) void context.close();
    context = null;
  });

  return {
    joined: () => playTones(JOIN_TONES),
    left: () => playTones(LEAVE_TONES),
    screenShareStarted: () => playTones(SCREEN_SHARE_TONES),
    screenShareStopped: () => playTones(SCREEN_SHARE_STOP_TONES),
    participantJoined,
    participantLeft,
    participantEntrancePending,
    participantEntranceFailed,
    participantEntranceSound,
  };
}

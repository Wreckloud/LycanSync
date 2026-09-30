import { onScopeDispose, reactive, ref } from 'vue';
import { loadAudioPreferences, normalizeAudioVolume, saveAudioPreferences,
  type AudioPreferences, type AudioProcessingSettings } from './audioPreferences';

const SAVE_DELAY_MS = 150;

export type AudioVolumeChange = Readonly<{
  previous: number;
  current: number;
}>;

/** 管理当前账号的本机音量偏好；高频拖动只在停止操作后合并写入一次。 */
export function useAudioPreferences(userId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const stored = loadAudioPreferences(userId, storage);
  const inputGain = ref(stored.inputGain);
  const outputVolume = ref(stored.outputVolume);
  const screenShareVolume = ref(stored.screenShareVolume);
  const processing = reactive<AudioProcessingSettings>({
    echoCancellation: stored.echoCancellation,
    noiseSuppression: stored.noiseSuppression,
    autoGainControl: stored.autoGainControl,
    voiceEnhancement: stored.voiceEnhancement,
  });
  const participantVolumes = reactive(new Map(Object.entries(stored.participantVolumes)));
  const participantLastAudibleVolumes = new Map(Object.entries(stored.participantLastAudibleVolumes));
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  function snapshot(): AudioPreferences {
    return {
      inputGain: inputGain.value,
      outputVolume: outputVolume.value,
      screenShareVolume: screenShareVolume.value,
      ...processing,
      participantVolumes: Object.fromEntries(participantVolumes),
      participantLastAudibleVolumes: Object.fromEntries(participantLastAudibleVolumes),
    };
  }

  function saveNow() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return;
    if (saveAudioPreferences(userId, snapshot(), storage)) dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function participantVolume(identity: string) {
    return participantVolumes.get(identity) ?? 1;
  }

  function mutedParticipantIdentities() {
    return [...participantVolumes.entries()]
      .filter(([, volume]) => volume === 0)
      .map(([identity]) => identity);
  }

  function setParticipantVolume(identity: string, value: number): AudioVolumeChange | null {
    const previous = participantVolume(identity);
    const current = normalizeAudioVolume(value);
    if (current === previous) return null;
    participantVolumes.set(identity, current);
    if (current > 0) participantLastAudibleVolumes.set(identity, current);
    scheduleSave();
    return { previous, current };
  }

  function toggleParticipantVolume(identity: string): AudioVolumeChange | null {
    const previous = participantVolume(identity);
    if (previous > 0) participantLastAudibleVolumes.set(identity, previous);
    return setParticipantVolume(identity,
      previous > 0 ? 0 : participantLastAudibleVolumes.get(identity) ?? 1);
  }

  function setInputGain(value: number) {
    const next = normalizeAudioVolume(value);
    if (next === inputGain.value) return false;
    inputGain.value = next;
    scheduleSave();
    return true;
  }

  function setOutputVolume(value: number) {
    const next = normalizeAudioVolume(value);
    if (next === outputVolume.value) return false;
    outputVolume.value = next;
    scheduleSave();
    return true;
  }

  function setScreenShareVolume(value: number) {
    const next = normalizeAudioVolume(value);
    if (next === screenShareVolume.value) return false;
    screenShareVolume.value = next;
    scheduleSave();
    return true;
  }

  function setProcessing(setting: keyof AudioProcessingSettings, enabled: boolean) {
    if (processing[setting] === enabled) return false;
    processing[setting] = enabled;
    scheduleSave();
    return true;
  }

  onScopeDispose(saveNow);

  return {
    inputGain,
    outputVolume,
    screenShareVolume,
    processing,
    participantVolume,
    mutedParticipantIdentities,
    setParticipantVolume,
    toggleParticipantVolume,
    setInputGain,
    setOutputVolume,
    setScreenShareVolume,
    setProcessing,
  };
}

export interface AudioProcessingSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceEnhancement: boolean;
}

export interface AudioPreferences extends AudioProcessingSettings {
  inputGain: number;
  outputVolume: number;
  screenShareVolume: number;
  voiceVolumeBalance: boolean;
  participantVolumes: Record<string, number>;
  participantLastAudibleVolumes: Record<string, number>;
}

export const AUDIO_VOLUME_MAX = 2;
export const AUDIO_VOLUME_STEP = 0.05;
const AUDIO_VOLUME_SCALE = 1 / AUDIO_VOLUME_STEP;

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  inputGain: 1,
  outputVolume: 1,
  screenShareVolume: 1,
  voiceVolumeBalance: true,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceEnhancement: true,
  participantVolumes: {},
  participantLastAudibleVolumes: {},
};

const STORAGE_PREFIX = 'lycansync.audio-preferences.v1.';

export function normalizeAudioVolume(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(AUDIO_VOLUME_MAX, Math.max(0, Math.round(value * AUDIO_VOLUME_SCALE) / AUDIO_VOLUME_SCALE));
}

export function unappliedCaptureProcessing(settings: AudioProcessingSettings, applied: MediaTrackSettings) {
  const keys = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
  return keys.filter((key) => typeof applied[key] === 'boolean' && applied[key] !== settings[key]);
}

function defaultAudioPreferences(): AudioPreferences {
  return {
    ...DEFAULT_AUDIO_PREFERENCES,
    participantVolumes: {},
    participantLastAudibleVolumes: {},
  };
}

function readVolumeMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .map(([identity, volume]) => [identity, normalizeAudioVolume(volume)]));
}

export function loadAudioPreferences(userId: string, storage: Pick<Storage, 'getItem'> = localStorage): AudioPreferences {
  try {
    const value = storage.getItem(STORAGE_PREFIX + userId);
    if (!value) return defaultAudioPreferences();
    const stored = JSON.parse(value) as Partial<AudioPreferences>;
    return {
      inputGain: normalizeAudioVolume(stored.inputGain ?? 1),
      outputVolume: normalizeAudioVolume(stored.outputVolume ?? 1),
      screenShareVolume: normalizeAudioVolume(stored.screenShareVolume ?? 1),
      voiceVolumeBalance: stored.voiceVolumeBalance !== false,
      echoCancellation: stored.echoCancellation !== false,
      noiseSuppression: stored.noiseSuppression !== false,
      autoGainControl: stored.autoGainControl !== false,
      voiceEnhancement: stored.voiceEnhancement !== false,
      participantVolumes: readVolumeMap(stored.participantVolumes),
      participantLastAudibleVolumes: readVolumeMap(stored.participantLastAudibleVolumes),
    };
  } catch {
    return defaultAudioPreferences();
  }
}

export function saveAudioPreferences(userId: string, preferences: AudioPreferences,
  storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(STORAGE_PREFIX + userId, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

const VOICE_LEVEL_FLOOR = 0.02;

export function normalizeVoiceLevel(level: number) {
  if (!Number.isFinite(level) || level <= VOICE_LEVEL_FLOOR) return 0;
  return Math.min(1, Math.sqrt((level - VOICE_LEVEL_FLOOR) / (1 - VOICE_LEVEL_FLOOR)));
}

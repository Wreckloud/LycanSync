const VOICE_LEVEL_FLOOR_DB = -50;
const VOICE_LEVEL_FULL_DB = -12;

export function normalizeVoiceLevel(level: number) {
  if (!Number.isFinite(level) || level <= 0) return 0;
  // 人声按对数刻度展示；满格表示较强输入，不要求声音达到削波边界。
  const decibels = 20 * Math.log10(level);
  return Math.max(0, Math.min(1,
    (decibels - VOICE_LEVEL_FLOOR_DB) / (VOICE_LEVEL_FULL_DB - VOICE_LEVEL_FLOOR_DB)));
}

export function quantizeVoiceLevel(level: number, steps: number) {
  const normalized = normalizeVoiceLevel(level);
  if (normalized === 0) return 0;
  const safeSteps = Math.max(1, Math.floor(steps));
  return Math.ceil(normalized * safeSteps) / safeSteps;
}

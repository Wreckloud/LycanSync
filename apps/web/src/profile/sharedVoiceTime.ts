export function formatSharedVoiceTime(seconds: number, own = false): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  if (seconds < 60) return own ? '已经在语音里待了不到 1 分钟' : '一起开黑的时间还不到 1 分钟';
  const duration = seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时`;
  return own ? `已经在语音里待了 ${duration}` : `一起开黑的时间已经有 ${duration}了`;
}

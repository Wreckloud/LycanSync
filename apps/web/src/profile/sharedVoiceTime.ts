export function formatSharedVoiceTime(seconds: number): string {
  if (seconds === 0) return '还没有记录下共同开黑的时间呢。';
  if (seconds < 60) return '一起开黑的时间，还不到 1 分钟。';
  const duration = seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时`;
  return `一起开黑的时间，已经有 ${duration}了。`;
}

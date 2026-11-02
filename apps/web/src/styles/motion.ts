export function motionDurationMs(value: string): number {
  const time = value.trim();
  const duration = time.endsWith('ms') ? Number.parseFloat(time)
    : time.endsWith('s') ? Number.parseFloat(time) * 1000 : 0;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

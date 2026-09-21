const MESSAGE_POLL_DELAYS_MS = [2_000, 4_000, 8_000] as const;

export function messagePollDelay(consecutiveEmptyPolls: number) {
  const index = Math.min(Math.max(0, consecutiveEmptyPolls), MESSAGE_POLL_DELAYS_MS.length - 1);
  return MESSAGE_POLL_DELAYS_MS[index];
}

import type { RecentGame } from '../group/groupApi';

export function formatPresenceAgo(value: string | null | undefined, now: number): string {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp) || timestamp > now) return '';
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 30) return `${minutes}分钟前`;
  if (minutes < 60) return '半小时前';
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  const days = Math.floor(minutes / 1440);
  if (days < 7) return `${days}天前`;
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat('zh-CN', {
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}), month: 'long', day: 'numeric',
  }).format(date);
}

export function formatRecentGame(game: RecentGame | null | undefined, now: number): string {
  if (!game?.name?.trim() || !Number.isFinite(game.playedSeconds) || game.playedSeconds <= 0) return '';
  const ago = formatPresenceAgo(game.endedAt, now);
  if (!ago) return '';
  const minutes = Math.floor(game.playedSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const duration = minutes < 1 ? '不到1分钟'
    : hours ? `约${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}` : `约${minutes}分钟`;
  return `${ago} · 玩了${duration}《${game.name}》`;
}

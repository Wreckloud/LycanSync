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
  if (!game?.name?.trim() || !Number.isFinite(now) || !Number.isFinite(game.playedSeconds) || game.playedSeconds <= 0) return '';
  const ago = formatGameEndTime(game.endedAt, now);
  if (!ago) return '';
  return `${ago}玩了${formatGameDuration(game.playedSeconds)}的 ${game.name.trim()}`;
}

function formatGameEndTime(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return '';
  const elapsed = now - timestamp;
  if (elapsed < 5 * 60_000) return '刚刚';
  if (elapsed < 60 * 60_000) return '不久前';
  if (elapsed < 3 * 3600_000) return '几小时前';
  const date = new Date(timestamp), today = new Date(now);
  // 使用本地日历日，跨午夜或夏令时不能按经过多少个24小时判断昨天。
  const days = (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000;
  if (days === 2) return '前天';
  if (days >= 3) return days < 7 ? '前几天' : '更早之前';
  const hour = date.getHours();
  const period = hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 13 ? '中午'
    : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜';
  return `${days === 0 ? '今天' : '昨天'}${period}`;
}

function formatGameDuration(seconds: number): string {
  if (seconds < 60) return '一小会儿';
  if (seconds < 10 * 60) return '几分钟';
  if (seconds < 20 * 60) return '十来分钟';
  if (seconds < 40 * 60) return '半个小时左右';
  if (seconds < 3600) return '大半个小时';
  if (seconds < 2 * 3600) return '一个多小时';
  if (seconds < 3 * 3600) return '两三个小时';
  if (seconds < 5 * 3600) return '好几个小时';
  return '很久';
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const fullFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function localDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatMessageDate(value: string, now: Date) {
  const date = new Date(value);
  // 按本地日历日比较，跨午夜及夏令时切换不能用相差 24 小时判断。
  const days = (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000;
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  const weekday = weekdayFormatter.format(date);
  if (days > 1 && days < 7) return weekday;
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${monthDay} ${weekday}`;
}

export function formatMessageTime(value: string, now: Date) {
  return `${formatMessageDate(value, now)} ${timeFormatter.format(new Date(value))}`;
}

export function formatMessageDateDivider(value: string) {
  return dateFormatter.format(new Date(value));
}

export function formatFullMessageTime(value: string) {
  return fullFormatter.format(new Date(value));
}

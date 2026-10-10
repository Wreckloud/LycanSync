export interface AccessLinkRecord {
  id: string;
  kind: 'INVITE' | 'RECOVERY' | 'ACTIVATE';
  targetId: string | null;
  note: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  resultUserId: string | null;
  lastFailure: string | null;
}

export interface AccessPreview { kind: string; status: string; serverName: string }
export interface AccessOffer { server: string; token: string }

export function accessLinkStatus(link: AccessLinkRecord, now: number) {
  if (link.consumedAt) return '已完成';
  if (link.revokedAt) return '已撤销';
  if (new Date(link.expiresAt).getTime() <= now) return '已过期';
  return '待使用';
}

export function redemptionKey(token: string) {
  const storageKey = `lycan:redeem:${token}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  sessionStorage.setItem(storageKey, key);
  return key;
}

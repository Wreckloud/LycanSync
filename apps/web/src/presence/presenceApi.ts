import { authenticatedFetch } from '../auth/authApi';

export type UserPresenceStatus = 'ONLINE' | 'AWAY' | 'OFFLINE';
export const PRESENCE_STATUS_LABELS: Record<UserPresenceStatus, string> = {
  ONLINE: '在线', AWAY: '离开', OFFLINE: '离线',
};
export type UserActivityType = 'GAME' | 'MUSIC';

export interface UserActivity {
  type: UserActivityType;
  name: string;
}

export interface PresenceHeartbeatRequest {
  status: UserPresenceStatus;
  activity: UserActivity | null;
  showActivity?: boolean;
  showLastOnline?: boolean;
}

export async function sendPresenceHeartbeat(
  status: UserPresenceStatus, activity: UserActivity | null, signal?: AbortSignal,
  visibility?: Pick<PresenceHeartbeatRequest, 'showActivity' | 'showLastOnline'> & { acceptDiagnosticRequest?: boolean },
): Promise<true | void> {
  const { acceptDiagnosticRequest, ...publicVisibility } = visibility ?? {};
  const path = '/api/presence/heartbeat' + (acceptDiagnosticRequest ? '?acceptDiagnosticRequest=true' : '');
  const response = await authenticatedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ status, activity, ...publicVisibility } satisfies PresenceHeartbeatRequest),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error('在线状态更新失败。');
  }
  if (acceptDiagnosticRequest && response.status === 200 && await response.json() === true) return true;
}

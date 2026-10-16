import { authenticatedFetch } from '../auth/authApi';

export type UserPresenceStatus = 'ONLINE' | 'AWAY' | 'OFFLINE';
export type UserActivityType = 'GAME' | 'MUSIC';

export interface UserActivity {
  type: UserActivityType;
  name: string;
}

export interface PresenceHeartbeatRequest {
  status: UserPresenceStatus;
  activity: UserActivity | null;
}

export async function sendPresenceHeartbeat(
  status: UserPresenceStatus, activity: UserActivity | null, signal?: AbortSignal,
): Promise<void> {
  const response = await authenticatedFetch('/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ status, activity } satisfies PresenceHeartbeatRequest),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`心跳上报失败（HTTP ${response.status}）`);
  }
}

import { authenticatedFetch, readApiError } from '../auth/authApi';
import type { UserActivityType, UserPresenceStatus } from '../presence/presenceApi';

export type GroupRole = 'OWNER' | 'MEMBER';

export interface GroupSummary {
  id: string;
  name: string;
  description: string;
  avatar: string;
  role: GroupRole;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  userId: string;
  nickname: string;
  avatar: string;
  role: GroupRole;
  joinedAt: string;
}

export interface GroupPresence {
  userId: string;
  status: UserPresenceStatus;
  lastSeenAt: string | null;
  activityType: UserActivityType | null;
  activityName: string | null;
  activityStartedAt: string | null;
}

export interface GroupPresenceChangeCursor {
  serverInstanceId: string;
  version: number;
  changed: boolean;
}

const PRESENCE_CLIENT_ID_KEY = 'lycan-sync-presence-client-id';
const PRESENCE_REQUEST_SEQUENCE_KEY = 'lycan-sync-presence-request-sequence';
const presenceClientId = (() => {
  try {
    const existing = sessionStorage.getItem(PRESENCE_CLIENT_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(PRESENCE_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();
let presenceRequestSequence = (() => {
  try { return Number(sessionStorage.getItem(PRESENCE_REQUEST_SEQUENCE_KEY)) || 0; }
  catch { return 0; }
})();

export function nextPresenceWaitRequest() {
  presenceRequestSequence++;
  try { sessionStorage.setItem(PRESENCE_REQUEST_SEQUENCE_KEY, String(presenceRequestSequence)); }
  catch { /* The in-memory sequence still orders requests during this page lifetime. */ }
  return { clientId: presenceClientId, requestId: presenceRequestSequence };
}

export interface GroupDetail extends GroupSummary {
  members: GroupMember[];
}

async function groupRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch('/api/groups' + path, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<T>;
}

export const findGroups = (signal?: AbortSignal) => groupRequest<GroupSummary[]>('', 'GET', undefined, signal);
export const findGroup = (groupId: string, signal?: AbortSignal) =>
  groupRequest<GroupDetail>('/' + encodeURIComponent(groupId), 'GET', undefined, signal);
export const findGroupPresences = (groupId: string, signal?: AbortSignal) =>
  groupRequest<GroupPresence[]>('/' + encodeURIComponent(groupId) + '/presences', 'GET', undefined, signal);
export async function waitForGroupPresenceChanges(
  groupId: string, clientId: string, requestId: number,
  cursor: Pick<GroupPresenceChangeCursor, 'serverInstanceId' | 'version'> | null,
  signal: AbortSignal,
): Promise<GroupPresenceChangeCursor> {
  const query = new URLSearchParams({ clientId, requestId: String(requestId) });
  if (cursor) {
    query.set('serverInstanceId', cursor.serverInstanceId);
    query.set('version', String(cursor.version));
  }
  const response = await authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/presence-changes?${query}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<GroupPresenceChangeCursor>;
}
export const createGroup = (name: string, description: string, avatar: string) =>
  groupRequest<GroupDetail>('', 'POST', { name, description, avatar });

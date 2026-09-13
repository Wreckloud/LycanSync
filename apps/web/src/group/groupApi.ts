import { ApiRequestError, authenticatedFetch } from '../auth/authApi';

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
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new ApiRequestError(response.status,
      typeof problem?.code === 'string' ? problem.code : 'UNKNOWN_ERROR',
      typeof problem?.detail === 'string' ? problem.detail : `请求失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const findGroups = (signal?: AbortSignal) => groupRequest<GroupSummary[]>('', 'GET', undefined, signal);
export const findGroup = (groupId: string, signal?: AbortSignal) =>
  groupRequest<GroupDetail>('/' + encodeURIComponent(groupId), 'GET', undefined, signal);
export const createGroup = (name: string, description: string, avatar: string) =>
  groupRequest<GroupDetail>('', 'POST', { name, description, avatar });

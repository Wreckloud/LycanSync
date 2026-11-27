import { authRequest, type AuthUser } from '../auth/authApi';

export async function loadServerMembers(search: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({ search, offset: String(offset) });
  const members = await authRequest<AuthUser[]>(`access/members?${query}`, 'GET', undefined, signal);
  return { members: members.map(member => ({ userId: member.id, nickname: member.nickname, avatar: member.avatar })), hasMore: members.length === 100 };
}

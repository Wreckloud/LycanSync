import { authenticatedFetch } from '../auth/authApi';

export interface RtcRoomSummary {
  participantCount: number;
  participants: { participantIdentity: string; displayName: string }[];
}

export interface RtcRoomOccupancy {
  groupId: string;
  participantCount: number;
}

export class RoomSummaryRequestError extends Error {}

function isRoomSummary(value: unknown): value is RtcRoomSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return Number.isInteger(summary.participantCount)
    && Number(summary.participantCount) >= 0
    && Array.isArray(summary.participants)
    && summary.participants.length === summary.participantCount
    && summary.participants.every((participant) => participant
      && typeof participant.participantIdentity === 'string' && participant.participantIdentity.length > 0
      && typeof participant.displayName === 'string');
}

/** 查询房间外可见的成员人数和昵称，不连接 LiveKit，也不请求任何媒体权限。 */
export async function requestRoomSummary(groupId: string, signal: AbortSignal): Promise<RtcRoomSummary> {
  const query = new URLSearchParams({ groupId });
  const response = await authenticatedFetch(`/api/rtc/room-summary?${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    // 切群可立即取消，慢请求也必须结束，避免下一轮状态刷新一直等不到执行。
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    throw new RoomSummaryRequestError(`查询语音成员失败（HTTP ${response.status}）`);
  }

  let summary: unknown;
  try {
    summary = await response.json();
  } catch {
    throw new RoomSummaryRequestError('语音成员摘要不是有效 JSON');
  }
  if (!isRoomSummary(summary)) {
    throw new RoomSummaryRequestError('语音成员摘要缺少必要字段');
  }
  return summary;
}

/** 一次查询所有可访问群组的语音人数，供左侧群组栏展示占用徽标。 */
export async function requestRoomOccupancies(signal: AbortSignal): Promise<RtcRoomOccupancy[]> {
  const response = await authenticatedFetch('/api/rtc/room-occupancies', {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new RoomSummaryRequestError(`查询群组语音人数失败（HTTP ${response.status}）`);
  const result: unknown = await response.json().catch(() => null);
  if (!Array.isArray(result) || !result.every((item) => item && typeof item === 'object'
    && typeof item.groupId === 'string' && item.groupId.length > 0
    && Number.isInteger(item.participantCount) && Number(item.participantCount) >= 0)) {
    throw new RoomSummaryRequestError('群组语音人数不是有效 JSON');
  }
  return result as RtcRoomOccupancy[];
}

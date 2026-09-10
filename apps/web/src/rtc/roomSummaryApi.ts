import { authenticatedFetch } from '../auth/authApi';

export interface RtcRoomSummary {
  participantCount: number;
  participantNames: string[];
}

export class RoomSummaryRequestError extends Error {}

function isRoomSummary(value: unknown): value is RtcRoomSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return Number.isInteger(summary.participantCount)
    && Number(summary.participantCount) >= 0
    && Array.isArray(summary.participantNames)
    && summary.participantNames.length === summary.participantCount
    && summary.participantNames.every((name) => typeof name === 'string' && name.length > 0);
}

/** 查询房间外可见的成员人数和昵称，不连接 LiveKit，也不请求任何媒体权限。 */
export async function requestRoomSummary(groupId: string, signal: AbortSignal): Promise<RtcRoomSummary> {
  const query = new URLSearchParams({ groupId });
  const response = await authenticatedFetch(`/api/rtc/room-summary?${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    signal,
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

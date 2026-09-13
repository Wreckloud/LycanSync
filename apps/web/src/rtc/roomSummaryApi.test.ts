import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestRoomSummary } from './roomSummaryApi';

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';

afterEach(() => vi.unstubAllGlobals());

describe('查询房间外语音成员摘要', () => {
  it('只发送群组标识并接受人数、身份和昵称', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      participantCount: 2,
      participants: [{ participantIdentity: 'user-a', displayName: '小北' }, { participantIdentity: 'user-b', displayName: '阿澈' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await expect(requestRoomSummary(groupId, signal)).resolves.toEqual({
      participantCount: 2,
      participants: [{ participantIdentity: 'user-a', displayName: '小北' }, { participantIdentity: 'user-b', displayName: '阿澈' }],
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/rtc/room-summary?groupId=' + groupId, expect.objectContaining({
      method: 'GET', cache: 'no-store', credentials: 'omit', signal,
    }));
  });

  it.each([
    { participantCount: 1, participants: [] },
    { participantCount: 1, participants: [{ participantIdentity: '', displayName: '小北' }] },
    { participantCount: -1, participants: [] },
  ])('拒绝不一致的成功响应 %j', async (summary) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(summary)));
    await expect(requestRoomSummary(groupId, new AbortController().signal))
      .rejects.toThrow('缺少必要字段');
  });
});

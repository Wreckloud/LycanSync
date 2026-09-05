import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestRoomSummary } from './roomSummaryApi';

afterEach(() => vi.unstubAllGlobals());

describe('查询房间外语音成员摘要', () => {
  it('只发送群组标识并接受人数和昵称', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      participantCount: 2,
      participantNames: ['小北', '阿澈'],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await expect(requestRoomSummary('pack', signal)).resolves.toEqual({
      participantCount: 2,
      participantNames: ['小北', '阿澈'],
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/rtc/room-summary?groupId=pack', expect.objectContaining({
      method: 'GET', cache: 'no-store', credentials: 'omit', signal,
    }));
  });

  it.each([
    { participantCount: 1, participantNames: [] },
    { participantCount: 1, participantNames: [''] },
    { participantCount: -1, participantNames: [] },
  ])('拒绝不一致的成功响应 %j', async (summary) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(summary)));
    await expect(requestRoomSummary('pack', new AbortController().signal))
      .rejects.toThrow('缺少必要字段');
  });
});

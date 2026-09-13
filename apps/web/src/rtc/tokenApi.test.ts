import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestRtcToken } from './tokenApi';

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';

const credential = {
  serverUrl: 'ws://127.0.0.1:7880', roomName: 'lycan-sync-group-' + groupId,
  participantIdentity: 'dev-test', token: 'test-token', expiresAt: '2026-09-03T12:00:00Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('申请 RTC 入房凭证', () => {
  it('通过同源 POST 请求凭证，不缓存或携带 cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(credential));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await expect(requestRtcToken(groupId, signal)).resolves.toEqual(credential);
    expect(fetchMock).toHaveBeenCalledWith('/api/rtc/token', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ groupId }), cache: 'no-store', credentials: 'omit', signal,
    }));
  });

  it.each([
    [400, '入房参数无效'], [404, 'rtc-local'], [503, 'HTTP 503'],
  ])('HTTP %s 明确失败，不返回默认凭证', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: Number(status) })));
    await expect(requestRtcToken(groupId, new AbortController().signal)).rejects.toThrow(String(message));
  });

  it('拒绝开发代理返回的 HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy</html>')));
    await expect(requestRtcToken(groupId, new AbortController().signal)).rejects.toThrow('有效 JSON');
  });

  it.each([
    {}, null, { ...credential, token: '' }, { ...credential, expiresAt: 'invalid' },
  ])('拒绝无效的成功响应 %j', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));
    await expect(requestRtcToken(groupId, new AbortController().signal)).rejects.toThrow('缺少必要字段');
  });

  it('保留取消请求的异常，交给会话逻辑判断是否仍需提示', async () => {
    const aborted = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(requestRtcToken(groupId, new AbortController().signal)).rejects.toBe(aborted);
  });
});

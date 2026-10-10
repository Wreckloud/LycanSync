import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiRequestError, authRequest, authenticatedFetch, setBrowserSession } from './authApi';

describe('authRequest', () => {
  afterEach(() => {
    setBrowserSession(null);
    vi.unstubAllGlobals();
  });

  test('保留后端错误状态与业务代码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'AUTH_RATE_LIMITED',
      detail: '登录请求过于频繁，请一分钟后重试',
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/problem+json' },
    })));

    const request = authRequest('access/preview', 'POST', { token: 'a'.repeat(43) });
    await expect(request).rejects.toBeInstanceOf(ApiRequestError);
    await expect(request).rejects.toMatchObject({
      status: 429,
      code: 'AUTH_RATE_LIMITED',
      message: '登录请求过于频繁，请一分钟后重试',
    });
  });

  test('旧会话请求的延迟 401 不会清除新会话', async () => {
    const oldSession = 'a'.repeat(43);
    const newSession = 'b'.repeat(43);
    let resolveOldResponse!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOldResponse = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { dispatchEvent });
    setBrowserSession(oldSession);

    const delayedRequest = authenticatedFetch('/api/groups');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe(`Bearer ${oldSession}`);
    setBrowserSession(newSession);
    resolveOldResponse(new Response('{}', { status: 401 }));

    expect((await delayedRequest).status).toBe(401);
    expect(dispatchEvent).not.toHaveBeenCalled();
    await authenticatedFetch('/api/groups');
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe(`Bearer ${newSession}`);
  });

  test('当前会话返回 401 时清除会话并通知退出', async () => {
    const session = 'c'.repeat(43);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { dispatchEvent });
    setBrowserSession(session);

    expect((await authenticatedFetch('/api/groups')).status).toBe(401);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    await authenticatedFetch('/api/groups');
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('Authorization')).toBe(false);
  });

  test('网络错误、超时和 5xx 不会触发 401 退出', async () => {
    const session = 'd'.repeat(43);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockRejectedValueOnce(new DOMException('request timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { dispatchEvent });
    setBrowserSession(session);

    await expect(authenticatedFetch('/api/groups')).rejects.toThrow('network unavailable');
    await expect(authenticatedFetch('/api/groups')).rejects.toHaveProperty('name', 'TimeoutError');
    expect((await authenticatedFetch('/api/groups')).status).toBe(503);
    expect(dispatchEvent).not.toHaveBeenCalled();
    await authenticatedFetch('/api/groups');
    expect(new Headers(fetchMock.mock.calls[3][1].headers).get('Authorization')).toBe(`Bearer ${session}`);
  });
});

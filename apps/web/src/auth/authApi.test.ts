import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiRequestError, authRequest } from './authApi';

describe('authRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('保留后端错误状态与业务代码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'AUTH_RATE_LIMITED',
      detail: '登录请求过于频繁，请一分钟后重试',
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/problem+json' },
    })));

    const request = authRequest('local/login', 'POST', { username: 'tester', password: 'abc123' });
    await expect(request).rejects.toBeInstanceOf(ApiRequestError);
    await expect(request).rejects.toMatchObject({
      status: 429,
      code: 'AUTH_RATE_LIMITED',
      message: '登录请求过于频繁，请一分钟后重试',
    });
  });
});

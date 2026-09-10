export interface AuthUser {
  id: string;
  nickname: string;
  avatar: string;
  administrator: boolean;
}

let browserSession: string | null = null;

const publicApiPaths = new Set([
  '/api/system/initialization',
  '/api/auth/local/register',
  '/api/auth/local/login',
]);

export function setBrowserSession(token: string | null) {
  if (token !== null && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('登录响应缺少有效会话');
  browserSession = token;
}

// 浏览器开发仅在内存保留会话；桌面凭据由主进程保存并只附加到允许转发的接口。
export async function authenticatedFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (browserSession) headers.set('Authorization', 'Bearer ' + browserSession);
  const response = await fetch(input, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  const path = new URL(input, 'http://localhost').pathname;
  if (response.status === 401 && !publicApiPaths.has(path)) {
    browserSession = null;
    window.dispatchEvent(new Event('lycan:unauthorized'));
  }
  return response;
}

export async function authRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch('/api/auth/' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.detail || problem?.message || `请求失败（HTTP ${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

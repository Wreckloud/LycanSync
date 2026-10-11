export interface AuthUser {
  id: string;
  nickname: string;
  avatar: string;
  administrator: boolean;
  signature?: string;
  createdAt?: string;
}

export interface ProfileUpdate {
  nickname: string;
  avatar: string;
  signature?: string;
}

export interface AuthSessionStatus {
  id: string;
  nickname: string;
  administrator: boolean;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let browserSession: string | null = null;

const requestErrorMessages: Record<number, string> = {
  400: '提交内容不符合要求，请检查后重试。',
  401: '登录已失效，请重新登录。',
  403: '没有权限执行此操作。',
  404: '请求的内容不存在或已被移除。',
  409: '当前状态无法完成此操作，请刷新后重试。',
  413: '提交内容过大，请缩小图片或减少内容后重试。',
  429: '操作过于频繁，请稍后重试。',
};

// 桌面代理和反向代理可能返回空正文或 HTML；保留状态与业务代码，不把它们当作成功。
export async function readApiError(response: Response): Promise<ApiRequestError> {
  const problem = await response.json().catch(() => null);
  const detail = typeof problem?.detail === 'string' ? problem.detail.trim() : '';
  const message = typeof problem?.message === 'string' ? problem.message.trim() : '';
  const fallback = requestErrorMessages[response.status]
    ?? (response.status >= 500 ? '服务暂时不可用，请稍后重试。' : '请求未完成，请稍后重试。');
  return new ApiRequestError(response.status,
    typeof problem?.code === 'string' ? problem.code : response.status === 413 ? 'REQUEST_TOO_LARGE' : 'UNKNOWN_ERROR',
    detail || message || fallback);
}

const publicApiPaths = new Set([
  '/api/auth/options',
  '/api/auth/access/preview',
  '/api/auth/access/redeem',
  '/api/system/initialization',
]);

export function setBrowserSession(token: string | null) {
  if (token !== null && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('登录响应缺少有效会话');
  browserSession = token;
}

// 浏览器开发仅在内存保留会话；桌面凭据由主进程保存并只附加到允许转发的接口。
export async function authenticatedFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const requestSession = browserSession;
  if (requestSession) headers.set('Authorization', 'Bearer ' + requestSession);
  const response = await fetch(input, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  const path = new URL(input, 'http://localhost').pathname;
  if (response.status === 401 && !publicApiPaths.has(path)) {
    if (window.lycanDesktop) {
      if (response.headers.get('X-Lycan-Session-Expired') === 'true') {
        window.dispatchEvent(new Event('lycan:unauthorized'));
      }
    } else if (browserSession === requestSession) {
      browserSession = null;
      window.dispatchEvent(new Event('lycan:unauthorized'));
    }
  }
  return response;
}

export async function authRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch('/api/auth/' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) throw await readApiError(response);
  if (response.status === 204) return undefined as T;
  return response.json();
}

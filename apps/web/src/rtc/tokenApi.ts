import { authenticatedFetch } from '../auth/authApi';

export interface RtcTokenResponse {
  serverUrl: string;
  roomName: string;
  participantIdentity: string;
  token: string;
  expiresAt: string;
}

export class TokenRequestError extends Error {}

function isRtcTokenResponse(value: unknown): value is RtcTokenResponse {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Record<string, unknown>;
  return ['serverUrl', 'roomName', 'participantIdentity', 'token', 'expiresAt'].every(
    (field) => typeof credential[field] === 'string' && credential[field].length > 0,
  ) && Number.isFinite(Date.parse(credential.expiresAt as string));
}

export async function requestRtcToken(
  groupId: string,
  signal: AbortSignal,
): Promise<RtcTokenResponse> {
  // 1. 向同源开发代理申请凭证，不在前端保存 LiveKit API secret。
  const response = await authenticatedFetch('/api/rtc/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    body: JSON.stringify({ groupId }),
    signal,
  });

  // 2. 明确区分启动配置与输入错误，不把代理错误页当作成功凭证。
  if (response.status === 404) {
    const problem = await response.json().catch(() => null);
    throw new TokenRequestError(problem?.code === 'GROUP_NOT_FOUND'
      ? '群组不存在或你不是群组成员。'
      : '服务器尚未开启语音功能，请联系服主。');
  }
  if (response.status === 400) {
    throw new TokenRequestError('无法加入此群组的语音。');
  }
  if (!response.ok) {
    throw new TokenRequestError('无法连接语音服务。');
  }

  // 3. TypeScript 类型不会校验网络数据，使用凭证前检查响应结构。
  let credential: unknown;
  try {
    credential = await response.json();
  } catch {
    throw new TokenRequestError('语音服务返回异常。');
  }
  if (!isRtcTokenResponse(credential)) {
    throw new TokenRequestError('无法取得加入语音所需的信息。');
  }
  return credential;
}

import { ApiRequestError, authenticatedFetch } from '../auth/authApi';

export type ChatMessageType = 'TEXT' | 'IMAGE';

export interface ChatAttachment {
  id: string;
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  byteSize: number;
}

export interface ChatMessage {
  id: string;
  senderUserId: string;
  senderNickname: string;
  type: ChatMessageType;
  content: string;
  createdAt: string;
  attachment: ChatAttachment | null;
}

export interface ChatMessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

function messagePath(groupId: string) {
  return '/api/groups/' + encodeURIComponent(groupId) + '/messages';
}

async function readError(response: Response): Promise<never> {
  const problem = await response.json().catch(() => null);
  throw new ApiRequestError(response.status,
    typeof problem?.code === 'string' ? problem.code : 'UNKNOWN_ERROR',
    typeof problem?.detail === 'string' ? problem.detail : `请求失败（HTTP ${response.status}）`);
}

export async function findMessages(groupId: string, afterMessageId?: string, signal?: AbortSignal): Promise<ChatMessagePage> {
  const search = afterMessageId ? '?afterMessageId=' + encodeURIComponent(afterMessageId) : '';
  const response = await authenticatedFetch(messagePath(groupId) + search, {
    headers: { Accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) return readError(response);
  return response.json() as Promise<ChatMessagePage>;
}

export async function sendMessage(groupId: string, content: string, image?: File): Promise<ChatMessage> {
  const body = new FormData();
  if (content) body.append('content', content);
  if (image) body.append('image', image, image.name);
  const response = await authenticatedFetch(messagePath(groupId), {
    method: 'POST', headers: { Accept: 'application/json' }, body, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return readError(response);
  return response.json() as Promise<ChatMessage>;
}

export async function fetchAttachment(groupId: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/attachments/' + encodeURIComponent(attachmentId),
    { headers: { Accept: 'image/png,image/jpeg' }, signal: signal ?? AbortSignal.timeout(30000) },
  );
  if (!response.ok) return readError(response);
  return response.blob();
}

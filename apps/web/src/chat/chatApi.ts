import { authenticatedFetch, readApiError } from '../auth/authApi';
import { nextPresenceWaitRequest } from '../group/groupApi';

export type ChatMessageType = 'TEXT' | 'IMAGE' | 'FILE';

export interface ChatAttachment {
  id: string;
  contentType: string;
  width?: number;
  height?: number;
  byteSize: number;
  fileName?: string;
  transferStatus?: 'PENDING' | 'FAILED';
}

export interface ChatMessage {
  id: string;
  senderUserId: string;
  senderNickname: string;
  senderAvatar?: string;
  senderDeletedAt?: string | null;
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

export async function findMessages(groupId: string,
  cursor?: { beforeMessageId: string; afterMessageId?: never } | { afterMessageId: string; beforeMessageId?: never },
  signal?: AbortSignal, wait = false): Promise<ChatMessagePage> {
  const search = cursor?.beforeMessageId ? '?beforeMessageId=' + encodeURIComponent(cursor.beforeMessageId)
    : cursor?.afterMessageId ? '?afterMessageId=' + encodeURIComponent(cursor.afterMessageId) : '';
  const waiter = wait ? nextPresenceWaitRequest() : null;
  const waiting = waiter ? new URLSearchParams({ wait: 'true', clientId: waiter.clientId, requestId: String(waiter.requestId) }) : null;
  const response = await authenticatedFetch(messagePath(groupId) + search + (waiting ? (search ? '&' : '?') + waiting : ''), {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(wait ? 35_000 : 15_000)]) : AbortSignal.timeout(wait ? 35_000 : 15_000),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<ChatMessagePage>;
}

export async function sendMessage(groupId: string, content: string, image?: File, signal?: AbortSignal,
  messageId?: string): Promise<ChatMessage> {
  const body = new FormData();
  if (content) body.append('content', content);
  if (image) body.append('image', image, image.name);
  if (messageId) body.append('messageId', messageId);
  const response = await authenticatedFetch(messagePath(groupId), {
    method: 'POST', headers: { Accept: 'application/json' }, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<ChatMessage>;
}

export interface UploadLimits { maxFileBytes: number; maxStorageBytes: number }

export async function uploadLimits(signal?: AbortSignal, limits?: UploadLimits): Promise<UploadLimits> {
  const response = await authenticatedFetch('/api/chat/upload-limits', {
    method: limits ? 'PUT' : 'GET', headers: limits ? { 'Content-Type': 'application/json' } : {},
    body: limits ? JSON.stringify(limits) : undefined, cache: 'no-store',
    signal: timedRequest(signal),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json();
}

function timedRequest(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function transferPath(groupId: string) {
  return '/api/groups/' + encodeURIComponent(groupId) + '/files/transfers';
}

function headerText(value: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function declareFile(groupId: string, id: string, attemptId: string, file: Pick<File, 'name' | 'size'>,
  content: string, signal: AbortSignal): Promise<ChatMessage> {
  const response = await authenticatedFetch(transferPath(groupId) + '/' + id, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: timedRequest(signal),
    body: JSON.stringify({ attemptId, encodedName: headerText(file.name), byteSize: file.size, content }),
  });
  if (!response.ok) throw await readApiError(response);
  return response.json();
}

export async function stopFile(groupId: string, id: string, attemptId: string, signal: AbortSignal) {
  const response = await authenticatedFetch(transferPath(groupId) + '/' + id + '/' + attemptId, {
    method: 'DELETE', signal: timedRequest(signal),
  });
  if (!response.ok) throw await readApiError(response);
}

export async function fileStates(groupId: string, ids: string[], signal: AbortSignal): Promise<ChatMessage[]> {
  const response = await authenticatedFetch(transferPath(groupId) + '?ids=' + ids.join(','), { signal: timedRequest(signal), cache: 'no-store' });
  if (!response.ok) throw await readApiError(response);
  return response.json();
}

export async function sendFile(groupId: string, file: Pick<File, 'name' | 'size' | 'stream'>, content: string, uploadId: string, signal: AbortSignal,
  onProgress: (loadedBytes: number) => void, messageId: string): Promise<ChatMessage> {
  const reader = file.stream().getReader();
  let loadedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loadedBytes += value.byteLength;
        onProgress(loadedBytes);
        controller.enqueue(value);
      } catch (reason) {
        controller.error(reason);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const response = await authenticatedFetch('/api/groups/' + encodeURIComponent(groupId) + '/files', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-File-Message': messageId,
      'X-File-Name': headerText(file.name),
      'X-File-Size': String(file.size),
      'X-Upload-Id': uploadId,
      'X-Message-Content': headerText(content),
    },
    body,
    duplex: 'half',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<ChatMessage>;
}

interface WritableFileHandle {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}

interface FilePickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<WritableFileHandle>;
}

export async function downloadFile(groupId: string, attachment: ChatAttachment, signal: AbortSignal,
  onProgress: (loadedBytes: number) => void): Promise<void> {
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('当前客户端不支持保存这类大文件。');
  signal.throwIfAborted();
  const handle = await picker.call(window, { suggestedName: attachment.fileName ?? 'download' });
  // 系统保存对话框不能强制关闭，但取消后的迟到选择不得创建写入或发起下载。
  signal.throwIfAborted();
  const writer = await handle.createWritable();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await authenticatedFetch(
      '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachment.id),
      { headers: { Accept: 'application/octet-stream' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) },
    );
    if (!response.ok) throw await readApiError(response);
    if (!response.body) throw new Error('服务器未返回文件内容');
    reader = response.body.getReader();
    let loadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      await writer.write(value);
      signal.throwIfAborted();
      loadedBytes += value.byteLength;
      onProgress(loadedBytes);
    }
    signal.throwIfAborted();
    if (loadedBytes !== attachment.byteSize) throw new Error('文件未能完整下载，请重试。');
    await writer.close();
  } catch (reason) {
    await reader?.cancel(reason).catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw reason;
  }
}

export async function fetchAttachment(groupId: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/attachments/' + encodeURIComponent(attachmentId),
    { headers: { Accept: 'image/png,image/jpeg' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw await readApiError(response);
  return response.blob();
}

export async function fetchFilePreview(groupId: string, attachmentId: string, signal: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachmentId),
    { headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) },
  );
  if (!response.ok) throw await readApiError(response);
  return response.blob();
}

export async function fetchVideoThumbnail(groupId: string, attachmentId: string, signal: AbortSignal): Promise<Blob | null> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachmentId) + '/thumbnail',
    { headers: { Accept: 'image/jpeg' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
  );
  if (!response.ok) throw await readApiError(response);
  return response.status === 204 ? null : response.blob();
}

export function desktopMediaUrl(groupId: string, attachmentId: string, compatible = false): string | null {
  // 桌面协议代理为每次 Range 请求附加会话；浏览器不能在 video.src 上附加 Bearer。
  return window.lycanDesktop
    ? '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachmentId) + (compatible ? '/preview/media' : '/media')
    : null;
}

export interface VideoPreviewStatus { status: 'absent' | 'processing' | 'ready' | 'failed'; message: string | null }

export async function videoPreviewStatus(groupId: string, attachmentId: string, start: boolean, signal: AbortSignal): Promise<VideoPreviewStatus> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachmentId) + '/preview',
    { method: start ? 'POST' : 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
  );
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<VideoPreviewStatus>;
}

export async function fetchCompatibleVideo(groupId: string, attachmentId: string, signal: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(
    '/api/groups/' + encodeURIComponent(groupId) + '/files/' + encodeURIComponent(attachmentId) + '/preview/media',
    { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) },
  );
  if (!response.ok) throw await readApiError(response);
  return response.blob();
}

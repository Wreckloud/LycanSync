import { authenticatedFetch, readApiError } from '../auth/authApi';

export type ChatMessageType = 'TEXT' | 'IMAGE' | 'FILE';

export interface ChatAttachment {
  id: string;
  contentType: string;
  width?: number;
  height?: number;
  byteSize: number;
  fileName?: string;
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

export async function findMessages(groupId: string,
  cursor?: { beforeMessageId: string; afterMessageId?: never } | { afterMessageId: string; beforeMessageId?: never },
  signal?: AbortSignal): Promise<ChatMessagePage> {
  const search = cursor?.beforeMessageId ? '?beforeMessageId=' + encodeURIComponent(cursor.beforeMessageId)
    : cursor?.afterMessageId ? '?afterMessageId=' + encodeURIComponent(cursor.afterMessageId) : '';
  const response = await authenticatedFetch(messagePath(groupId) + search, {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
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

export async function findFileUpload(groupId: string, uploadId: string, signal?: AbortSignal): Promise<ChatMessage | null> {
  const response = await authenticatedFetch('/api/groups/' + encodeURIComponent(groupId) + '/files/requests/'
    + encodeURIComponent(uploadId), {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<ChatMessage>;
}

export async function sendFile(groupId: string, file: File, content: string, uploadId: string, signal: AbortSignal,
  onProgress: (loadedBytes: number) => void): Promise<ChatMessage> {
  const previous = await findFileUpload(groupId, uploadId, signal);
  if (previous) return previous;
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
  const encodedName = btoa(String.fromCharCode(...new TextEncoder().encode(file.name)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const encodedContent = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const response = await authenticatedFetch('/api/groups/' + encodeURIComponent(groupId) + '/files', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodedName,
      'X-File-Size': String(file.size),
      'X-Upload-Id': uploadId,
      'X-Message-Content': encodedContent,
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
  if (!picker) throw new Error('当前客户端不支持大文件流式保存');
  const handle = await picker.call(window, { suggestedName: attachment.fileName ?? 'download' });
  const writer = await handle.createWritable();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
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
      if (done) break;
      await writer.write(value);
      loadedBytes += value.byteLength;
      onProgress(loadedBytes);
    }
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

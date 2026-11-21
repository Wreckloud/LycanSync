import { shallowReactive, type InjectionKey } from 'vue';
import { declareFile, downloadFile, sendFile, sendMessage, stopFile, type ChatAttachment, type ChatMessage } from './chatApi';
import { cachedRecordingJpeg } from '../recording/recordingThumbnails';
import type { AuthUser } from '../auth/authApi';

export type DraftAttachment = { id: string; previewUrl: string; optimizeVideo?: boolean } & (
  | { kind: 'IMAGE' | 'FILE'; file: File; recordingId?: never }
  | { kind: 'FILE'; file: Pick<File, 'name' | 'size'>; recordingId: string }
);

export interface Outgoing {
  groupId: string;
  message: ChatMessage;
  item?: DraftAttachment;
  progress: number;
  error: string;
  controller: AbortController;
  attemptId: string;
  state: 'queued' | 'sending' | 'failed';
}

function recordingFile(item: DraftAttachment, signal: AbortSignal): Pick<File, 'name' | 'size' | 'stream'> {
  return { name: item.file.name, size: item.file.size, stream: () => {
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      async start() {
        const response = await fetch(item.previewUrl, { signal });
        if (!response.ok || !response.body) throw new Error('无法读取录像，原片可能已移动或删除。');
        reader = response.body.getReader();
      },
      async pull(controller) {
        const chunk = await reader!.read();
        if (chunk.done) { reader!.releaseLock(); controller.close(); }
        else controller.enqueue(chunk.value);
      },
      cancel: reason => reader?.cancel(reason),
    });
  } };
}
export const CHAT_TRANSFERS: InjectionKey<ReturnType<typeof createChatTransfers>> = Symbol('chat transfers');

export function createChatTransfers(user: AuthUser, onSent: (groupId: string) => void) {
  const outgoing = shallowReactive(new Map<string, Outgoing>());
  const downloads = shallowReactive(new Map<string, { controller?: AbortController; loaded: number; error: string }>());
  const listeners = new Set<(groupId: string, message: ChatMessage) => void>();
  const declarations = new Map<string, Promise<void>>();
  const session = new AbortController();
  const waiting: Array<() => void> = [];
  let uploading = 0;

  function forget(job: Outgoing) {
    outgoing.delete(job.message.id);
    if (job.item?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(job.item.previewUrl);
  }

  function notify(groupId: string, message: ChatMessage) {
    for (const listener of listeners) listener(groupId, message);
  }

  function acknowledge(job: Outgoing) {
    if (outgoing.get(job.message.id) !== job) return;
    onSent(job.groupId);
    forget(job);
  }

  function complete(job: Outgoing, message: ChatMessage) {
    if (session.signal.aborted || !outgoing.has(job.message.id)) return;
    notify(job.groupId, message);
    acknowledge(job);
  }

  async function failed(job: Outgoing, reason: unknown) {
    if (session.signal.aborted) return;
    job.error = job.controller.signal.aborted ? '已取消上传' : reason instanceof Error ? reason.message : '发送失败';
    if (job.item?.kind === 'FILE') {
      try { await stopFile(job.groupId, job.message.id, job.attemptId, session.signal); }
      catch { /* 断线时服务端会让本次登记过期，重试前再确认。 */ }
    }
    job.state = 'failed';
  }

  async function transfer(job: Outgoing, registeredAt: number) {
    const item = job.item!;
    const controller = job.controller;
    try {
      job.controller.signal.throwIfAborted();
      // 排队时间计入登记租期，长队列开始读取原文件前重新核验。
      if (Date.now() - registeredAt > 4 * 60_000) {
        const registered = await declareFile(job.groupId, job.message.id, job.attemptId, item.file, job.message.content, session.signal);
        if (!registered.attachment?.transferStatus) { complete(job, registered); return; }
        job.controller.signal.throwIfAborted();
      }
      job.state = 'sending';
      const file = item.recordingId !== undefined ? recordingFile(item, job.controller.signal) : item.file;
      const message = await sendFile(job.groupId, file, job.message.content, job.attemptId,
        job.controller.signal, loaded => { job.progress = loaded; }, job.message.id, item.optimizeVideo);
      complete(job, message);
    } catch (reason) {
      await failed(job, reason);
    } finally {
      controller.abort();
      uploading--;
      waiting.shift()?.();
    }
  }

  function schedule(job: Outgoing) {
    const { groupId, message, item } = job;
    // 只串行登记，以点击顺序分配服务端序号。大文件流独立运行。
    const registration = (declarations.get(groupId) ?? Promise.resolve()).then(async () => {
      try {
        job.controller.signal.throwIfAborted();
        if (item?.kind !== 'FILE') {
          job.state = 'sending';
          complete(job, await sendMessage(groupId, message.content, item?.file, job.controller.signal, message.id,
            bytes => { job.progress = bytes; }));
          return;
        }
        const registered = await declareFile(groupId, message.id, job.attemptId, item.file, message.content, session.signal,
          cachedRecordingJpeg(item.previewUrl));
        if (!registered.attachment?.transferStatus) { complete(job, registered); return; }
        if (session.signal.aborted) return;
        notify(groupId, registered);
        job.controller.signal.throwIfAborted();
        const registeredAt = Date.now();
        const cancelQueued = () => {
          const index = waiting.indexOf(start);
          if (index >= 0) waiting.splice(index, 1);
          void failed(job, job.controller.signal.reason);
        };
        const start = () => {
          job.controller.signal.removeEventListener('abort', cancelQueued);
          uploading++;
          void transfer(job, registeredAt);
        };
        if (uploading < 2) start();
        else {
          waiting.push(start);
          job.controller.signal.addEventListener('abort', cancelQueued, { once: true });
        }
      } catch (reason) { await failed(job, reason); }
    });
    declarations.set(groupId, registration);
    void registration.finally(() => { if (declarations.get(groupId) === registration) declarations.delete(groupId); });
  }

  function enqueue(groupId: string, content: string, item?: DraftAttachment) {
    const id = item?.id ?? crypto.randomUUID();
    const message: ChatMessage = { id, senderUserId: user.id, senderNickname: user.nickname,
      type: item?.kind ?? 'TEXT', content, createdAt: new Date().toISOString(), attachment: item ? {
        id, fileName: item.file.name, byteSize: item.file.size, contentType: 'application/octet-stream', transferStatus: 'PENDING',
      } : null };
    const job = shallowReactive<Outgoing>({ groupId, message, item, progress: 0, error: '', attemptId: crypto.randomUUID(),
      state: 'queued', controller: new AbortController() });
    outgoing.set(id, job);
    schedule(job);
  }

  async function retry(job: Outgoing) {
    if (job.state !== 'failed' || outgoing.get(job.message.id) !== job) return;
    const controller = job.controller = new AbortController();
    job.state = 'queued';
    job.error = '';
    job.progress = 0;
    try {
      // 先确认旧登记已停止，期间取消只放弃这次重试。
      if (job.item?.kind === 'FILE') await stopFile(job.groupId, job.message.id, job.attemptId, session.signal);
      controller.signal.throwIfAborted();
    } catch (reason) {
      if (outgoing.get(job.message.id) !== job) return;
      job.state = 'failed';
      job.error = controller.signal.aborted ? '已取消上传' : reason instanceof Error ? reason.message : '无法重试';
      return;
    }
    if (outgoing.get(job.message.id) !== job) return;
    job.attemptId = crypto.randomUUID();
    schedule(job);
  }

  async function download(groupId: string, attachment: ChatAttachment) {
    if (downloads.get(attachment.id)?.controller) return;
    const controller = new AbortController();
    const job = shallowReactive({ controller: controller as AbortController | undefined, loaded: 0, error: '' });
    downloads.set(attachment.id, job);
    try {
      await downloadFile(groupId, attachment, controller.signal, loaded => { job.loaded = loaded; });
    } catch (reason) {
      if (!controller.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError')) {
        job.error = reason instanceof Error ? reason.message : '文件下载失败';
      }
    } finally {
      job.controller = undefined;
      if (!job.error) downloads.delete(attachment.id);
    }
  }

  function dispose() {
    session.abort();
    waiting.length = 0;
    for (const job of outgoing.values()) { job.controller.abort(); forget(job); }
    for (const job of downloads.values()) job.controller?.abort();
    downloads.clear();
    listeners.clear();
  }

  return { outgoing, downloads, enqueue, retry, forget, acknowledge, download, listeners, dispose };
}

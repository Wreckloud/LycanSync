import { onScopeDispose, ref, shallowRef, type InjectionKey } from 'vue';
import { sendFile } from '../chat/chatApi';

export const RECORDING_SHARE: InjectionKey<ReturnType<typeof useRecordingShare>> = Symbol('recording-share');

// 任务跟随登录后的主界面，关闭设置或查看器不会中断已确认的上传。
export function useRecordingShare(notify: (message: string) => void, defaultGroup: () => string) {
  const entry = shallowRef<RecordingLibraryEntry | null>(null);
  const visible = ref(false);
  const busy = ref(false);
  const progress = ref(0);
  const error = ref('');
  const groupId = ref('');
  const content = ref('');
  let uploadId = '';
  let request: AbortController | undefined;
  let disposed = false;

  function select(value: RecordingLibraryEntry) {
    if (!busy.value && entry.value?.id !== value.id) {
      entry.value = value; groupId.value = defaultGroup(); content.value = ''; error.value = ''; uploadId = '';
    }
    visible.value = true;
  }
  async function send() {
    const file = entry.value;
    if (!file || !groupId.value || busy.value || !file.bytes) return;
    const target = groupId.value;
    uploadId ||= crypto.randomUUID();
    const current = request = new AbortController();
    busy.value = true; progress.value = 0; error.value = '';
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    try {
      await sendFile(target, {
        name: file.fileName || `录像-${file.id}.mkv`, size: file.bytes,
        stream: () => new ReadableStream<Uint8Array<ArrayBuffer>>({
          async start() {
            const response = await fetch(`lycan://app/recordings/${encodeURIComponent(file.id)}`, { signal: current.signal });
            if (!response.ok || !response.body) throw new Error('无法读取录像，文件可能已移动或正在使用。');
            reader = response.body.getReader();
          },
          async pull(controller) {
            const chunk = await reader!.read();
            if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
          },
          cancel: reason => reader?.cancel(reason),
        }),
      }, content.value, uploadId, current.signal, bytes => { progress.value = Math.min(100, Math.floor(bytes * 100 / file.bytes!)); });
      if (!disposed) { visible.value = false; entry.value = null; uploadId = ''; notify('录像已发送到群聊。'); }
    } catch (reason) {
      if (!disposed) error.value = current.signal.aborted ? '已取消上传。' : reason instanceof Error ? reason.message : '录像发送失败，请重试。';
    } finally {
      current.abort();
      await reader?.cancel().catch(() => {});
      if (!disposed) busy.value = false;
    }
  }
  function cancel() { request?.abort(); }
  function resetUpload() { if (!busy.value) uploadId = ''; }
  onScopeDispose(() => { disposed = true; request?.abort(); });
  return { entry, visible, busy, progress, error, groupId, content, select, send, cancel, resetUpload };
}

// 仅缓存 240×136 以内的像素，32 张最多约 4 MiB；不持有视频、GPU 纹理或原片。
const durations = new WeakMap<ImageData, number>();
export function recordingThumbnailDuration(cover: ImageData) { return durations.get(cover); }

const covers = new Map<string, ImageData>();
const pending = new Set<{ source: string; signal: AbortSignal; resolve: (cover: ImageData) => void; reject: (error: unknown) => void; abort: () => void }>();
let decoding = 0;

// 只附带已解码的缩略图，立即发送时不因读取原片而阻塞群消息登记。
export function cachedRecordingJpeg(source: string): string | undefined {
  const pixels = covers.get(source);
  if (!pixels) return;
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width; canvas.height = pixels.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.putImageData(pixels, 0, 0);
  const jpeg = canvas.toDataURL('image/jpeg', 0.65).split(',')[1];
  return jpeg && jpeg.length <= Math.floor(16384 / 3) * 4 ? jpeg : undefined;
}

export function forgetRecordingThumbnail(id: string) {
  covers.delete(`lycan://app/recordings/${encodeURIComponent(id)}`);
}

export function loadRecordingThumbnail(source: string, signal: AbortSignal): Promise<ImageData> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const cached = covers.get(source);
  if (cached) {
    covers.delete(source); covers.set(source, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const task = { source, signal, resolve, reject, abort: () => {
      if (pending.delete(task)) reject(signal.reason);
    } };
    pending.add(task);
    signal.addEventListener('abort', task.abort, { once: true });
    drain();
  });
}

function drain() {
  while (decoding < 2 && pending.size) {
    const task = pending.values().next().value!;
    pending.delete(task);
    task.signal.removeEventListener('abort', task.abort);
    const cached = covers.get(task.source);
    if (cached) {
      covers.delete(task.source); covers.set(task.source, cached);
      task.resolve(cached); continue;
    }
    decoding++;
    void decode(task.source, task.signal).then(cover => {
      if (task.signal.aborted) { task.reject(task.signal.reason); return; }
      covers.delete(task.source); covers.set(task.source, cover);
      if (covers.size > 32) covers.delete(covers.keys().next().value!);
      task.resolve(cover);
    }, task.reject).finally(() => { decoding--; drain(); });
  }
}

function decode(source: string, signal: AbortSignal): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    let frameRequest: number | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
      video.onloadedmetadata = null; video.onseeked = null; video.onerror = null;
      video.pause(); video.removeAttribute('src'); video.load();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const abort = () => fail(signal.reason);
    const timeout = setTimeout(() => fail(new Error('recordingThumbnailTimedOut')), 8000);
    signal.addEventListener('abort', abort, { once: true });
    video.muted = true; video.preload = 'auto';
    video.onloadedmetadata = () => {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0;
    };
    const capture = async () => {
      if (settled) return;
      video.pause();
      let bitmap: ImageBitmap | undefined;
      try {
        if (!video.videoWidth || !video.videoHeight) throw new Error('recordingThumbnailUnavailable');
        const scale = Math.min(240 / video.videoWidth, 136 / video.videoHeight);
        bitmap = await createImageBitmap(video, { resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
          resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)) });
        if (settled) return;
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('thumbnailCanvasUnavailable');
        context.drawImage(bitmap, 0, 0);
        const cover = context.getImageData(0, 0, bitmap.width, bitmap.height);
        if (Number.isFinite(video.duration) && video.duration > 0) durations.set(cover, Math.round(video.duration * 1000));
        settled = true; cleanup(); resolve(cover);
      } catch (error) { fail(error); }
      finally { bitmap?.close(); }
    };
    video.onseeked = () => {
      if (settled) return;
      frameRequest = video.requestVideoFrameCallback(() => { void capture(); });
      void video.play().catch(fail);
    };
    video.onerror = () => fail(new Error('recordingThumbnailUnavailable'));
    if (signal.aborted) abort(); else video.src = source;
  });
}

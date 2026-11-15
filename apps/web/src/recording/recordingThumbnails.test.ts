import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture() {
  vi.resetModules();
  const videos: Array<ReturnType<typeof createVideo>> = [];
  function createVideo() {
    const video = { src: '', videoWidth: 1920, videoHeight: 1080, duration: 10, currentTime: 0,
      onloadedmetadata: null as (() => void) | null, onseeked: null as (() => void) | null, onerror: null as (() => void) | null,
      frame: () => {}, pause: vi.fn(), play: vi.fn(async () => {}), load: vi.fn(), removeAttribute: vi.fn(),
      requestVideoFrameCallback(callback: () => void) { video.frame = callback; return 1; }, cancelVideoFrameCallback: vi.fn() };
    return video;
  }
  const cover = { width: 240, height: 135, data: new Uint8ClampedArray(240 * 135 * 4) } as ImageData;
  const bitmap = { width: 240, height: 135, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('document', { createElement: (kind: string) => {
    if (kind === 'video') { const video = createVideo(); videos.push(video); return video; }
    return { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => cover }) };
  } });
  const loader = await import('./recordingThumbnails');
  const finish = async (index: number) => {
    const video = videos[index]!; video.onloadedmetadata!(); video.onseeked!(); video.frame();
    await vi.waitFor(() => expect(video.removeAttribute).toHaveBeenCalledWith('src'));
  };
  return { ...loader, videos, finish, cover, bitmap };
}

it('最多两路解码，排队取消不创建播放器，缓存命中不再解码', async () => {
  const f = await fixture();
  const first = f.loadRecordingThumbnail('first', new AbortController().signal);
  const second = f.loadRecordingThumbnail('second', new AbortController().signal);
  const cancelled = new AbortController();
  const third = f.loadRecordingThumbnail('third', cancelled.signal).catch(() => 'cancelled');
  const fourth = f.loadRecordingThumbnail('fourth', new AbortController().signal);
  expect(f.videos).toHaveLength(2); cancelled.abort(); expect(await third).toBe('cancelled');
  await f.finish(0); await first; expect(f.videos).toHaveLength(3);
  await f.finish(1); await second; await f.finish(2); await fourth;
  expect(await f.loadRecordingThumbnail('first', new AbortController().signal)).toBe(f.cover);
  expect(f.videos).toHaveLength(3); expect(f.bitmap.close).toHaveBeenCalledTimes(3);
});

it('活动任务取消释放视频，迟到帧不缓存；再次请求可以成功', async () => {
  const f = await fixture(); const controller = new AbortController();
  const pending = f.loadRecordingThumbnail('cancel', controller.signal).catch(() => 'cancelled');
  f.videos[0]!.onseeked!(); const late = f.videos[0]!.frame;
  controller.abort(); expect(await pending).toBe('cancelled'); late();
  expect(f.videos[0]!.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  const retry = f.loadRecordingThumbnail('cancel', new AbortController().signal);
  await f.finish(1); await retry; expect(f.videos).toHaveLength(2);
});

it('缓存只留32张，重新关联后丢弃旧封面；失败不缓存', async () => {
  const f = await fixture();
  for (let index = 0; index < 33; index++) {
    const pending = f.loadRecordingThumbnail(`lycan://app/recordings/${index}`, new AbortController().signal);
    await f.finish(index); await pending;
  }
  const evicted = f.loadRecordingThumbnail('lycan://app/recordings/0', new AbortController().signal);
  await f.finish(33); await evicted;
  f.forgetRecordingThumbnail('0');
  const invalidated = f.loadRecordingThumbnail('lycan://app/recordings/0', new AbortController().signal).catch(() => 'failed');
  f.videos[34]!.onerror!(); expect(await invalidated).toBe('failed');
  const retried = f.loadRecordingThumbnail('lycan://app/recordings/0', new AbortController().signal);
  await f.finish(35); await retried; expect(f.videos).toHaveLength(36);
});

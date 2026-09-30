import { LocalVideoTrack } from 'livekit-client';

export interface NativeVideoDesktopBridge {
  startNativeVideo(sourceId: string, maxFps: number): Promise<{ sessionId: string; changed: boolean }>;
  stopNativeVideo(sessionId?: string): Promise<{ changed: boolean }>;
  onNativeVideoError(callback: (code: string) => void): () => void;
}

type GeneratedVideoTrack = MediaStreamTrack & {
  writable: WritableStream<VideoFrame>;
  stop(): void;
};

interface NativeScreenVideoOptions {
  maxFps: number;
  firstFrameTimeoutMs?: number;
  createGenerator?: () => GeneratedVideoTrack;
  createLocalTrack?: (track: MediaStreamTrack) => LocalVideoTrack;
  onError?: (code: string) => void;
  now?: () => number;
}

const FIRST_FRAME_TIMEOUT_MS = 8_000;

/** Owns the renderer-side VideoFrame queue and one helper video session. */
export class NativeScreenVideoSession {
  readonly track: LocalVideoTrack;

  get captureSessionId() { return this.sessionId; }

  private readonly generator: GeneratedVideoTrack;
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private readonly intervalMs: number;
  private readonly firstFrameTimeoutMs: number;
  private readonly now: () => number;
  private readonly onError?: (code: string) => void;
  private removeHelperErrorListener?: () => void;
  private sessionId?: string;
  private startCommand?: Promise<{ sessionId: string; changed: boolean }>;
  private startPromise?: Promise<LocalVideoTrack>;
  private stopPromise?: Promise<void>;
  private firstFrameResolve?: () => void;
  private firstFrameReject?: (error: Error) => void;
  private writePromise?: Promise<void>;
  private pendingFrame?: VideoFrame;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;
  private writing = false;
  private stopped = false;

  constructor(
    private readonly desktop: NativeVideoDesktopBridge,
    options: NativeScreenVideoOptions,
  ) {
    if (!Number.isInteger(options.maxFps) || options.maxFps < 1 || options.maxFps > 60) {
      throw new Error('invalidNativeVideoFrameRate');
    }
    this.intervalMs = 1_000 / options.maxFps;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
    this.onError = options.onError;
    this.generator = (options.createGenerator ?? createVideoGenerator)();
    this.generator.contentHint = 'motion';
    this.writer = this.generator.writable.getWriter();
    this.track = (options.createLocalTrack ?? ((track) => new LocalVideoTrack(track, {}, true)))(this.generator);
  }

  start(sourceId: string): Promise<LocalVideoTrack> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) return Promise.reject(new Error('nativeVideoSessionStopped'));
    this.startPromise = this.startAndWaitForFrame(sourceId);
    return this.startPromise;
  }

  private async startAndWaitForFrame(sourceId: string): Promise<LocalVideoTrack> {
    const firstFrame = new Promise<void>((resolve, reject) => {
      this.firstFrameResolve = resolve;
      this.firstFrameReject = reject;
    });
    window.addEventListener('message', this.onWindowMessage);
    this.removeHelperErrorListener = this.desktop.onNativeVideoError((code) => this.fail(code));
    this.startCommand = this.desktop.startNativeVideo(sourceId, Math.round(1_000 / this.intervalMs));
    try {
      const started = await this.startCommand;
      if (started.changed !== true || typeof started.sessionId !== 'string' || !started.sessionId) {
        throw new Error('nativeVideoStartRejected');
      }
      this.sessionId = started.sessionId;
      if (this.stopped) throw new Error('nativeVideoSessionStopped');
      await waitWithTimeout(firstFrame, this.firstFrameTimeoutMs, 'nativeVideoFirstFrameTimeout');
      return this.track;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    window.removeEventListener('message', this.onWindowMessage);
    this.removeHelperErrorListener?.();
    this.removeHelperErrorListener = undefined;
    this.firstFrameReject?.(new Error('nativeVideoSessionStopped'));
    this.generator.stop();
    this.track.stop();
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    this.stopPromise = this.stopResources();
    return this.stopPromise;
  }

  private async stopResources(): Promise<void> {
    const startCommand = this.startCommand;
    if (startCommand) {
      try {
        const started = await waitWithTimeout(startCommand, 1_500, 'nativeVideoStartCleanupTimeout');
        this.sessionId ??= started.sessionId;
      } catch { /* The main process owns cancellation when startup did not return a session ID. */ }
    }
    if (this.writePromise) await waitWithTimeout(this.writePromise, 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    await waitWithTimeout(this.writer.close(), 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    await this.desktop.stopNativeVideo(this.sessionId).then(() => undefined).catch(() => {});
  }

  private readonly onWindowMessage = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== 'lycan-native-screen-frame') return;
    const frame = event.data.frame as VideoFrame | undefined;
    if (!frame || typeof frame.close !== 'function') return;
    if (this.stopped || this.writing || this.now() - this.lastAcceptedAt < this.intervalMs) {
      frame.close();
      return;
    }
    this.lastAcceptedAt = this.now();
    this.writing = true;
    this.pendingFrame = frame;
    this.writePromise = this.writer.write(frame).catch(() => {
      this.fail('nativeVideoTrackWriteFailed');
    }).finally(() => {
      frame.close();
      if (this.pendingFrame === frame) this.pendingFrame = undefined;
      this.writing = false;
    });
    // 首帧已交给轨道；write 要等 LiveKit 开始读取才可能完成，不能以它作为发布前提。
    this.firstFrameResolve?.();
    this.firstFrameResolve = undefined;
  };

  private fail(code: string): void {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'nativeVideoFailed';
    this.firstFrameReject?.(new Error(safeCode));
    this.firstFrameReject = undefined;
    this.onError?.(safeCode);
    void this.stop();
  }
}

function createVideoGenerator(): GeneratedVideoTrack {
  const Generator = (window as Window & {
    MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => GeneratedVideoTrack;
  }).MediaStreamTrackGenerator;
  if (!Generator) throw new Error('nativeVideoTrackGeneratorUnavailable');
  return new Generator({ kind: 'video' });
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

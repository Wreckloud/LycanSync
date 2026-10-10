import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';
import { LocalVideoTrack } from 'livekit-client';
import { createScreenStatusFrame } from './screenStatusFrame';

export interface NativeVideoDesktopBridge {
  startNativeVideo(sourceId: string, maxFps: number, settings: ScreenSharePreferences): Promise<{ sessionId: string; changed: boolean }>;
  stopNativeVideo(sessionId: string): Promise<{ changed: boolean }>;
  onNativeVideoError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
  onNativeVideoSuspended(callback: (status: { sessionId: string; suspended: boolean }) => void): () => void;
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
  createSuspendedFrame?: (width: number, height: number, timestamp: number) => VideoFrame;
  createAdjustedFrame?: (frame: VideoFrame, init: VideoFrameInit) => VideoFrame;
  onError?: (code: string) => void;
  now?: () => number;
}

const FIRST_FRAME_TIMEOUT_MS = 8_000;
const SUSPENDED_HINT_INTERVAL_MS = 1_000;
const SUSPENDED_HINT_TIMESTAMP_STEP_US = SUSPENDED_HINT_INTERVAL_MS * 1_000;

/** 持有页面侧视频帧队列及一个 helper 采集会话，负责停止与帧释放。 */
export class NativeScreenVideoSession {
  readonly track: LocalVideoTrack;

  get captureSessionId() { return this.sessionId; }

  private readonly generator: GeneratedVideoTrack;
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private readonly intervalMs: number;
  private readonly firstFrameTimeoutMs: number;
  private readonly now: () => number;
  private readonly onError?: (code: string) => void;
  private readonly createSuspendedFrame: (width: number, height: number, timestamp: number) => VideoFrame;
  private readonly createAdjustedFrame: (frame: VideoFrame, init: VideoFrameInit) => VideoFrame;
  private removeHelperErrorListener?: () => void;
  private removeSuspensionListener?: () => void;
  private sessionId?: string;
  private pendingHelperFailure?: { sessionId: string; code: string };
  private pendingSuspension?: { sessionId: string; suspended: boolean };
  private startCommand?: Promise<{ sessionId: string; changed: boolean }>;
  private startPromise?: Promise<LocalVideoTrack>;
  private stopPromise?: Promise<void>;
  private firstFrameResolve?: () => void;
  private firstFrameReject?: (error: Error) => void;
  private suspensionTimer?: ReturnType<typeof setInterval>;
  private writePromise?: Promise<void>;
  private pendingFrame?: VideoFrame;
  private pendingFrameSessionId?: string;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private frameWidth = 1280;
  private frameHeight = 720;
  private suspended = false;
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
    this.createSuspendedFrame = options.createSuspendedFrame ?? createSuspendedFrame;
    this.createAdjustedFrame = options.createAdjustedFrame
      ?? ((frame, init) => new VideoFrame(frame, init));
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
    const settings = readScreenSharePreferences();
    const firstFrame = new Promise<void>((resolve, reject) => {
      this.firstFrameResolve = resolve;
      this.firstFrameReject = reject;
    });
    window.addEventListener('message', this.onWindowMessage);
    this.removeHelperErrorListener = this.desktop.onNativeVideoError((failure) => {
      if (this.sessionId) {
        if (failure.sessionId === this.sessionId) this.fail(failure.code);
      } else {
        this.pendingHelperFailure = failure;
      }
    });
    this.removeSuspensionListener = this.desktop.onNativeVideoSuspended((status) => {
      if (this.sessionId) {
        if (status.sessionId === this.sessionId) this.setSuspended(status.suspended);
      } else {
        this.pendingSuspension = status;
      }
    });
    this.startCommand = this.desktop.startNativeVideo(sourceId, Math.round(1_000 / this.intervalMs), settings);
    try {
      const started = await this.startCommand;
      if (started.changed !== true || typeof started.sessionId !== 'string' || !started.sessionId) {
        throw new Error('nativeVideoStartRejected');
      }
      this.sessionId = started.sessionId;
      if (this.pendingFrame) {
        const pendingFrame = this.pendingFrame;
        const pendingSessionId = this.pendingFrameSessionId;
        this.pendingFrame = undefined;
        this.pendingFrameSessionId = undefined;
        if (pendingSessionId === this.sessionId && !this.stopped) this.acceptFrame(pendingFrame);
        else pendingFrame.close();
      }
      const pendingSuspension = this.pendingSuspension;
      this.pendingSuspension = undefined;
      if (pendingSuspension?.sessionId === this.sessionId) this.setSuspended(pendingSuspension.suspended);
      const pendingFailure = this.pendingHelperFailure;
      this.pendingHelperFailure = undefined;
      if (pendingFailure?.sessionId === this.sessionId) throw new Error(pendingFailure.code);
      if (this.stopped) throw new Error('nativeVideoSessionStopped');
      await waitWithTimeout(firstFrame, this.firstFrameTimeoutMs, 'nativeVideoFirstFrameTimeout');
      return this.track;
    } catch (error) {
      await this.stop().catch((cleanupError) => {
        console.error('原生屏幕共享启动失败后的清理未完成', cleanupError);
      });
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.removeHelperErrorListener?.();
    this.removeHelperErrorListener = undefined;
    this.removeSuspensionListener?.();
    this.removeSuspensionListener = undefined;
    this.clearSuspensionTimer();
    this.firstFrameReject?.(new Error('nativeVideoSessionStopped'));
    this.generator.stop();
    this.track.stop();
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    this.pendingFrameSessionId = undefined;
    this.stopPromise = this.stopResources();
    return this.stopPromise;
  }

  private async stopResources(): Promise<void> {
    const startCommand = this.startCommand;
    let startCleanupTimedOut: Error | undefined;
    if (startCommand) {
      try {
        const started = await waitWithTimeout(startCommand, 1_500, 'nativeVideoStartCleanupTimeout');
        if (typeof started.sessionId === 'string' && started.sessionId) this.sessionId ??= started.sessionId;
      } catch (error) {
        if (error instanceof Error && error.message === 'nativeVideoStartCleanupTimeout') {
          startCleanupTimedOut = error;
          void startCommand.then((started) => {
            if (typeof started.sessionId !== 'string' || !started.sessionId) {
              window.removeEventListener('message', this.onWindowMessage);
              return;
            }
            return this.desktop.stopNativeVideo(started.sessionId).then(() => {
              window.removeEventListener('message', this.onWindowMessage);
            });
          }, () => {
            window.removeEventListener('message', this.onWindowMessage);
          }).catch((cleanupError) => {
            console.error('原生屏幕共享迟到启动清理失败', cleanupError);
          });
        } else {
          window.removeEventListener('message', this.onWindowMessage);
        }
      }
    }
    if (this.writePromise) await waitWithTimeout(this.writePromise, 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    await waitWithTimeout(this.writer.close(), 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    if (this.sessionId) await this.desktop.stopNativeVideo(this.sessionId);
    else if (!startCleanupTimedOut) window.removeEventListener('message', this.onWindowMessage);
    if (startCleanupTimedOut) throw startCleanupTimedOut;
    if (this.sessionId) window.removeEventListener('message', this.onWindowMessage);
  }

  private readonly onWindowMessage = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== 'lycan-native-screen-frame') return;
    let frame = event.data.frame as VideoFrame | undefined;
    if (!frame || typeof frame.close !== 'function') return;
    const frameSessionId = event.data.sessionId;
    if (typeof frameSessionId !== 'string' || !frameSessionId || this.stopped
        || (this.sessionId && frameSessionId !== this.sessionId)) {
      frame.close();
      return;
    }
    if (!this.sessionId) {
      // 启动响应可能晚于首帧；只保留一帧，取得会话标识后再确认归属。
      this.pendingFrame?.close();
      this.pendingFrame = frame;
      this.pendingFrameSessionId = frameSessionId;
      return;
    }
    this.acceptFrame(frame);
  };

  private acceptFrame(frame: VideoFrame): void {
    if (this.stopped || this.suspended || this.writing || this.now() - this.lastAcceptedAt < this.intervalMs) {
      frame.close();
      return;
    }
    const init: VideoFrameInit = {};
    const visibleRect = frame.visibleRect;
    // Electron 将纹理容量作为显示尺寸；实际窗口内容可能因对齐或纹理复用而更小。
    if (visibleRect && (frame.displayWidth !== visibleRect.width || frame.displayHeight !== visibleRect.height)) {
      init.displayWidth = visibleRect.width;
      init.displayHeight = visibleRect.height;
    }
    if (Number.isFinite(frame.timestamp)) {
      const timestamp = Math.max(frame.timestamp!, this.lastTimestamp + 1);
      if (timestamp !== frame.timestamp) init.timestamp = timestamp;
    }
    if (init.displayWidth !== undefined || init.timestamp !== undefined) {
      try {
        const adjustedFrame = this.createAdjustedFrame(frame, init);
        frame.close();
        frame = adjustedFrame;
      } catch {
        frame.close();
        this.fail('nativeVideoFrameAdjustmentFailed');
        return;
      }
    }
    if (Number.isInteger(frame.displayWidth) && frame.displayWidth > 0) this.frameWidth = frame.displayWidth;
    if (Number.isInteger(frame.displayHeight) && frame.displayHeight > 0) this.frameHeight = frame.displayHeight;
    this.lastAcceptedAt = this.now();
    this.writeFrame(frame);
  }

  private setSuspended(suspended: boolean): void {
    if (this.stopped || this.suspended === suspended) return;
    this.suspended = suspended;
    this.clearSuspensionTimer();
    if (suspended) {
      this.writeSuspendedFrame();
      this.suspensionTimer = setInterval(() => this.writeSuspendedFrame(), SUSPENDED_HINT_INTERVAL_MS);
    }
  }

  private writeSuspendedFrame(): void {
    if (this.stopped || !this.suspended || this.writing) return;
    const scale = Math.min(1, 1920 / this.frameWidth, 1080 / this.frameHeight);
    const width = Math.max(1, Math.round(this.frameWidth * scale));
    const height = Math.max(1, Math.round(this.frameHeight * scale));
    const timestamp = Math.max(Math.round(this.now() * 1000), this.lastTimestamp + SUSPENDED_HINT_TIMESTAMP_STEP_US);
    try {
      this.writeFrame(this.createSuspendedFrame(width, height, timestamp));
    } catch {
      this.fail('nativeVideoPauseFrameFailed');
    }
  }

  private writeFrame(frame: VideoFrame): void {
    if (Number.isFinite(frame.timestamp)) this.lastTimestamp = Math.max(this.lastTimestamp, frame.timestamp);
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
  }

  private clearSuspensionTimer(): void {
    if (this.suspensionTimer !== undefined) clearInterval(this.suspensionTimer);
    this.suspensionTimer = undefined;
  }

  private fail(code: string): void {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'nativeVideoFailed';
    this.firstFrameReject?.(new Error(safeCode));
    this.firstFrameReject = undefined;
    this.onError?.(safeCode);
    void this.stop().catch((error) => {
      console.error('原生屏幕共享停止未完成', error);
    });
  }
}

function createSuspendedFrame(width: number, height: number, timestamp: number): VideoFrame {
  return createScreenStatusFrame(width, height, timestamp, {
    title: '共享窗口已最小化',
    description: '恢复窗口后继续共享',
  });
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

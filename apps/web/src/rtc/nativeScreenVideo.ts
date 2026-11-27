import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';
import { LocalVideoTrack } from 'livekit-client';
import { createScreenStatusFrame } from './screenStatusFrame';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, SCREEN_SHARE_LOWER_LAYER_FPS, screenShareContentHint, screenShareDegradationPreference, screenShareLowerLayers, screenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from './screenShareQuality';
import { applyScreenShareEncoding, hasScreenShareSimulcast, readScreenShareEncoding, screenShareEncodingLimits } from './screenShareEncoding';

export interface NativeVideoDesktopBridge {
  recordScreenShareStartupTiming(sessionId: string, stage: 'screenVideoFirstFrame' | 'screenVideoStartupFailed',
    durationMs: number, failure?: { code: string }): void;
  startNativeVideo(sourceId: string, maxFps: number, settings: ScreenSharePreferences, resolution: { width: number; height: number }, discoveryId?: string): Promise<{ sessionId: string; changed: boolean; gameFollowId?: string }>;
  findNativeGameSource?(id: string): Promise<{ sourceId: string | null }>;
  switchNativeGameVideo?(id: string, sourceId: string, maxFps: number, settings: ScreenSharePreferences,
    resolution: { width: number; height: number }): Promise<{ sessionId: string; changed: boolean; gameFollowId?: string }>;
  endNativeGameFollow?(id: string): Promise<void>;
  stopNativeVideo(sessionId: string): Promise<{ changed: boolean }>;
  configureNativeVideo(sessionId: string, maxFps: number, resolution?: { width: number; height: number }, deliveryOnly?: boolean): Promise<{ changed: boolean }>;
  onNativeVideoError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
  onNativeVideoSuspended(callback: (status: { sessionId: string; suspended: boolean }) => void): () => void;
}

type GeneratedVideoTrack = MediaStreamTrack & {
  writable: WritableStream<VideoFrame>;
  stop(): void;
};

interface NativeScreenVideoOptions {
  maxFps: number;
  recommendedQuality?: CustomScreenShareQuality;
  captureSettings?: ScreenSharePreferences;
  resolution?: { width: number; height: number };
  contentHint?: 'motion' | 'detail';
  firstFrameTimeoutMs?: number;
  createGenerator?: () => GeneratedVideoTrack;
  createLocalTrack?: (track: MediaStreamTrack) => LocalVideoTrack;
  createSuspendedFrame?: (width: number, height: number, timestamp: number, waitingForGame?: boolean) => VideoFrame;
  createAdjustedFrame?: (frame: VideoFrame, init: VideoFrameInit) => VideoFrame;
  onError?: (code: string) => void;
  canChangeGameSource?: () => boolean;
  onGameSourceChanging?: () => Promise<void>;
  onGameSourceChanged?: (sourceId: string, sessionId: string) => Promise<void>;
  isCurrentCapture?: () => boolean;
  canReduceFrameRate?: () => boolean;
  onFrameRateAdjustmentFailure?: (captureFrameRate: number) => void;
  now?: () => number;
}

const FIRST_FRAME_TIMEOUT_MS = 8_000;
const SUSPENDED_HINT_INTERVAL_MS = 1_000;
const DEMAND_CHECK_INTERVAL_MS = 500;
const LOWER_LAYER_DEMAND_DELAY_MS = 3_000;
const RESIZE_SETTLE_MS = 500;

const nativeVideoInputs = new WeakMap<MediaStreamTrack, NativeScreenVideoSession>();

/** 只读取当前轨道所属会话；不创建采集或另行保留帧。 */
export function readNativeVideoInput(track: MediaStreamTrack) {
  return nativeVideoInputs.get(track)?.readDiagnostics() ?? null;
}

export function setNativeScreenPreviewDemand(track: MediaStreamTrack, preview: HTMLVideoElement, required: boolean) {
  nativeVideoInputs.get(track)?.setHighQualityPreview(preview, required);
}

export function setNativeScreenRecordingDemand(track: MediaStreamTrack, required: boolean) {
  const input = nativeVideoInputs.get(track);
  if (!input) return required ? Promise.reject(new Error('recordingShareUnavailable')) : Promise.resolve();
  return input.setRecordingDemand(required);
}

/** 持有页面侧视频帧队列及一个 helper 采集会话，负责停止与帧释放。 */
export class NativeScreenVideoSession {
  readonly track: LocalVideoTrack;
  private readonly captureSettings?: ScreenSharePreferences;

  get captureSessionId() { return this.sessionId; }
  get frameDimensions() {
    return this.submittedFrames ? { width: this.frameWidth, height: this.frameHeight } : undefined;
  }
  get needsFrameRateRecovery() { return this.frameRateAdjustmentFailed; }

  private readonly generator: GeneratedVideoTrack;
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private maxFps: number;
  private recommendedQuality?: CustomScreenShareQuality;
  private captureFrameRate: number;
  private deliveryFrameRate: number;
  private resolution: { width: number; height: number };
  private configuring = false;
  private readonly isCurrentCapture?: () => boolean;
  private readonly canReduceFrameRate?: () => boolean;
  private readonly onFrameRateAdjustmentFailure?: (captureFrameRate: number) => void;
  private readonly highQualityPreviews = new Set<HTMLVideoElement>();
  private lastDemandCheck = Number.NEGATIVE_INFINITY;
  private lastDemandSender?: RTCRtpSender;
  private lowerLayerDemandSince?: number;
  private demandChange?: Promise<void>;
  private recordingRequired = false;
  private frameRateAdjustmentFailed = false;
  private readonly firstFrameTimeoutMs: number;
  private readonly now: () => number;
  private readonly onError?: (code: string) => void;
  private readonly createSuspendedFrame: (width: number, height: number, timestamp: number, waitingForGame?: boolean) => VideoFrame;
  private readonly createAdjustedFrame: (frame: VideoFrame, init: VideoFrameInit) => VideoFrame;
  private removeHelperErrorListener?: () => void;
  private removeSuspensionListener?: () => void;
  private sessionId?: string;
  private pendingHelperFailure?: { sessionId: string; code: string };
  private pendingSuspension?: { sessionId: string; suspended: boolean };
  private startCommand?: ReturnType<NativeVideoDesktopBridge['startNativeVideo']>;
  private startPromise?: Promise<LocalVideoTrack>;
  private stopPromise?: Promise<void>;
  private nativeStopUnconfirmed = false;
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private suspensionTimer?: ReturnType<typeof setInterval>;
  private writePromise?: Promise<void>;
  private unconfirmedFrame?: VideoFrame;
  private writingFrame?: VideoFrame;
  private unconfirmedFrameSessionId?: string;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private timestampClock?: { localMicros: number; frameMicros: number; offset: number };
  private frameWidth = 1280;
  private frameHeight = 720;
  private layerResizeTimer?: ReturnType<typeof setTimeout>;
  private layerResize?: Promise<void>;
  private suspended = false;
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private get writing() { return this.writingFrame !== undefined; }
  private stopped = false;
  private receivedFrames = 0;
  private backpressureDroppedFrames = 0;
  private suspendedDroppedFrames = 0;
  private submittedFrames = 0;
  private completedWrites = 0;
  private writeFailures = 0;
  private placeholderFrames = 0;
  private startedAt: number | undefined;
  private firstFrameMs: number | null = null;
  private gameFollowId?: string;
  private sourceId?: string;
  private gameFollowTimer?: ReturnType<typeof setTimeout>;
  private gameTargetClosed = false;
  private gameWaitingSince?: number;
  private gameSourceChanging = false;
  private gameFirstFrameResolve?: () => void;
  private gameFirstFrameReject?: (error: Error) => void;
  private readonly canChangeGameSource?: () => boolean;
  private readonly onGameSourceChanging?: () => Promise<void>;
  private readonly onGameSourceChanged?: (sourceId: string, sessionId: string) => Promise<void>;

  constructor(
    private readonly desktop: NativeVideoDesktopBridge,
    options: NativeScreenVideoOptions,
  ) {
    if (![30, 60, 120].includes(options.maxFps)) {
      throw new Error('invalidNativeVideoFrameRate');
    }
    this.maxFps = options.maxFps;
    this.recommendedQuality = options.recommendedQuality;
    this.deliveryFrameRate = options.maxFps;
    this.captureSettings = options.captureSettings ? { ...options.captureSettings } : undefined;
    this.captureFrameRate = options.maxFps;
    this.isCurrentCapture = options.isCurrentCapture;
    this.canReduceFrameRate = options.canReduceFrameRate;
    this.onFrameRateAdjustmentFailure = options.onFrameRateAdjustmentFailure;
    this.resolution = options.resolution ?? { width: 1920, height: 1080 };
    if (![this.resolution.width, this.resolution.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) {
      throw new Error('invalidNativeVideoResolution');
    }
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
    this.onError = options.onError;
    this.canChangeGameSource = options.canChangeGameSource;
    this.onGameSourceChanging = options.onGameSourceChanging;
    this.onGameSourceChanged = options.onGameSourceChanged;
    this.createSuspendedFrame = options.createSuspendedFrame ?? createSuspendedFrame;
    this.createAdjustedFrame = options.createAdjustedFrame
      ?? ((frame, init) => new VideoFrame(frame, init));
    this.generator = (options.createGenerator ?? createVideoGenerator)();
    this.generator.contentHint = options.contentHint ?? 'motion';
    this.writer = this.generator.writable.getWriter();
    this.track = (options.createLocalTrack ?? ((track) => new LocalVideoTrack(track, {}, true)))(this.generator);
    nativeVideoInputs.set(this.generator, this);
  }

  readDiagnostics() {
    // 真实来源帧与最小化提示分开累计；写入完成数包含两者，不代表编码或网络确认。
    return { sessionId: this.sessionId ?? null, receivedFrames: this.receivedFrames,
      backpressureDroppedFrames: this.backpressureDroppedFrames,
      suspendedDroppedFrames: this.suspendedDroppedFrames, submittedFrames: this.submittedFrames,
      completedWrites: this.completedWrites, writeFailures: this.writeFailures,
      placeholderFrames: this.placeholderFrames, pendingWrite: this.writing, firstFrameMs: this.firstFrameMs,
      requestedFrameRate: this.maxFps, captureFrameRate: this.captureFrameRate,
      deliveryFrameRate: this.deliveryFrameRate,
      frameRateAdjustmentFailed: this.frameRateAdjustmentFailed };
  }

  setHighQualityPreview(preview: HTMLVideoElement, required: boolean): void {
    if (this.stopped) return;
    if (required) this.highQualityPreviews.add(preview);
    else this.highQualityPreviews.delete(preview);
    this.refreshCaptureFrameRate(true);
  }

  async setRecordingDemand(required: boolean) {
    if (required && this.stopped) throw new Error('recordingShareUnavailable');
    this.recordingRequired = required;
    await this.demandChange;
    this.refreshCaptureFrameRate(true);
    await this.demandChange;
    if (required && this.captureFrameRate !== this.maxFps) throw new Error('recordingCaptureRateUnavailable');
  }

  private refreshCaptureFrameRate(immediate = false): void {
    if (this.stopped || !this.sessionId || !this.canReduceFrameRate || this.configuring || this.gameSourceChanging || this.gameTargetClosed
        || this.demandChange || this.frameRateAdjustmentFailed || this.isCurrentCapture?.() === false) return;
    const now = this.now();
    if (!immediate && now - this.lastDemandCheck < DEMAND_CHECK_INTERVAL_MS) return;
    this.lastDemandCheck = now;
    let lowerLayersOnly = false;
    try {
      const sender = this.track.sender;
      if (sender !== this.lastDemandSender) {
        this.lowerLayerDemandSince = undefined;
        if (sender && this.recommendedQuality) this.scheduleLayerResize();
      }
      this.lastDemandSender = sender;
      const encodings = sender?.getParameters().encodings;
      // 主层明确暂停后，预览和中层最多需要 30 帧；层状态未知时保留用户目标。
      lowerLayersOnly = this.canReduceFrameRate() && this.highQualityPreviews.size === 0
        && !!encodings && hasScreenShareSimulcast(encodings) && typeof encodings[0].active === 'boolean'
        && encodings.at(-1)?.active === false;
    } catch { /* sender 不可读视为未知，按用户目标恢复，不降低采集规格。 */ }
    if (!lowerLayersOnly) this.lowerLayerDemandSince = undefined;
    else this.lowerLayerDemandSince ??= now;
    const frameRate = lowerLayersOnly && now - this.lowerLayerDemandSince! >= LOWER_LAYER_DEMAND_DELAY_MS
      ? Math.min(this.maxFps, SCREEN_SHARE_LOWER_LAYER_FPS) : this.maxFps;
    // 本地输出运行时保持 OBS 渲染配置，单独减少网页交付，不能因观看需求改变而清空回放。
    const captureFrameRate = this.recordingRequired ? this.maxFps : frameRate;
    const deliveryOnly = captureFrameRate === this.captureFrameRate;
    if (deliveryOnly && frameRate === this.deliveryFrameRate) return;
    const sessionId = this.sessionId;
    const configuration = deliveryOnly
      ? this.desktop.configureNativeVideo(sessionId, frameRate, this.resolution, true)
      : this.desktop.configureNativeVideo(sessionId, captureFrameRate, this.resolution);
    this.demandChange = configuration.then((result) => {
      if (this.stopped || this.sessionId !== sessionId) return;
      if (result.changed !== true) throw new Error('nativeVideoDemandConfigurationRejected');
      this.captureFrameRate = captureFrameRate;
      this.deliveryFrameRate = deliveryOnly ? frameRate : captureFrameRate;
    }).catch(() => {
      if (this.stopped || this.sessionId !== sessionId) return;
      // 可选节流失败不重试或伪报恢复，保留已确认帧率，由用户重新选择画质恢复。
      this.frameRateAdjustmentFailed = true;
      this.onFrameRateAdjustmentFailure?.(this.captureFrameRate);
    }).finally(() => {
      this.demandChange = undefined;
      this.refreshCaptureFrameRate(true);
    });
  }

  start(sourceId: string, discoveryId?: string): Promise<LocalVideoTrack> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) return Promise.reject(new Error('nativeVideoSessionStopped'));
    this.startPromise = this.startCapture(sourceId, discoveryId);
    return this.startPromise;
  }

  private async startCapture(sourceId: string, discoveryId?: string): Promise<LocalVideoTrack> {
    this.startedAt = this.now();
    const settings = this.captureSettings ?? readScreenSharePreferences();
    if (settings.followGame && (!this.desktop.findNativeGameSource || !this.desktop.switchNativeGameVideo
        || !this.desktop.endNativeGameFollow)) throw new Error('nativeGameFollowUnavailable');
    const ready = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    // 启动命令可能先失败；提前观察首帧拒绝，实际错误仍由下面的启动流程上报。
    void ready.catch(() => {});
    window.addEventListener('message', this.onWindowMessage);
    this.removeHelperErrorListener = this.desktop.onNativeVideoError((failure) => {
      if (this.sessionId) {
        if (failure.sessionId === this.sessionId) {
          if (failure.code === 'captureTargetClosed' && this.gameFollowId) {
            this.gameTargetClosed = true;
            this.gameWaitingSince ??= this.now();
            this.setSuspended(true);
          } else this.fail(failure.code);
        }
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
    this.startCommand = this.desktop.startNativeVideo(sourceId, this.maxFps, settings, this.resolution, discoveryId);
    try {
      const started = await this.startCommand;
      if (started.changed !== true || typeof started.sessionId !== 'string' || !started.sessionId) {
        throw new Error('nativeVideoStartRejected');
      }
      this.sessionId = started.sessionId;
      this.sourceId = sourceId;
      this.gameFollowId = started.gameFollowId;
      if (settings.followGame && !this.gameFollowId) throw new Error('nativeGameFollowUnavailable');
      const pendingFailure = this.pendingHelperFailure;
      this.pendingHelperFailure = undefined;
      if (pendingFailure?.sessionId === this.sessionId) throw new Error(pendingFailure.code);
      if (this.stopped) throw new Error('nativeVideoSessionStopped');
      const pendingSuspension = this.pendingSuspension;
      this.pendingSuspension = undefined;
      if (pendingSuspension?.sessionId === this.sessionId) this.setSuspended(pendingSuspension.suspended);
      if (this.unconfirmedFrame) {
        const unconfirmedFrame = this.unconfirmedFrame;
        const pendingSessionId = this.unconfirmedFrameSessionId;
        this.unconfirmedFrame = undefined;
        this.unconfirmedFrameSessionId = undefined;
        if (pendingSessionId === this.sessionId && !this.stopped) this.acceptFrame(unconfirmedFrame);
        else unconfirmedFrame.close();
      }
      await waitWithTimeout(ready, this.firstFrameTimeoutMs, 'nativeVideoFirstFrameTimeout');
      if (this.gameFollowId) this.scheduleGameFollow();
      return this.track;
    } catch (error) {
      if (this.sessionId && !this.stopped) {
        const code = error instanceof Error && ['nativeVideoFirstFrameTimeout', 'nativeVideoFrameAdjustmentFailed',
          'nativeVideoTrackWriteFailed', 'nativeVideoSessionStopped'].includes(error.message) ? error.message : 'nativeVideoFailed';
        this.desktop.recordScreenShareStartupTiming(this.sessionId, 'screenVideoStartupFailed',
          Math.max(0, this.now() - this.startedAt!), { code });
      }
      await this.stop().catch((cleanupError) => {
        console.error('原生屏幕共享启动失败后的清理未完成', cleanupError);
      });
      throw error;
    }
  }

  async configureQuality(id: ScreenShareQualityId, custom?: CustomScreenShareQuality): Promise<void> {
    if (this.stopped || this.configuring || this.gameSourceChanging || this.gameTargetClosed) throw new Error('nativeVideoConfigurationUnavailable');
    this.configuring = true;
    try {
      if (this.layerResize) await this.layerResize;
      // 手动画质优先；先收口已发送的节流请求，不与同一宿主的配置命令竞争。
      if (this.demandChange) await this.demandChange;
      await this.applyQuality(id, custom);
      this.recommendedQuality = id === 'custom' && custom?.bitrateMbps === undefined ? custom ?? DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY : undefined;
    } finally {
      this.configuring = false;
      if (this.layerResizeTimer !== undefined || this.recommendedQuality) this.scheduleLayerResize();
      this.lowerLayerDemandSince = undefined;
      this.lastDemandCheck = Number.NEGATIVE_INFINITY;
    }
  }

  private async applyQuality(id: ScreenShareQualityId, custom?: CustomScreenShareQuality): Promise<void> {
    const quality = screenShareQuality(id, custom);
    const sender = this.track.sender;
    const sessionId = this.sessionId;
    if (this.stopped || !sessionId || !sender) throw new Error('nativeVideoConfigurationUnavailable');
    const previousLimits = readScreenShareEncoding(sender);
    const previousFps = this.captureFrameRate;
    const previousResolution = this.resolution;
    const resolutionChanged = quality.width !== previousResolution.width || quality.height !== previousResolution.height;
    const frame = this.frameDimensions;
    // 小窗口在两档内都保持原尺寸；旧帧已触及采集上限时，升档后的尺寸尚未知。
    const dimensions = frame && (!resolutionChanged || (
      frame.width < Math.min(previousResolution.width, quality.width)
      && frame.height < Math.min(previousResolution.height, quality.height)
    )) ? frame : quality;
    let nativeRequested = false;
    try {
      const limits = screenShareEncodingLimits(id, previousLimits, dimensions, custom);
      await applyScreenShareEncoding(sender, limits);
      if (this.stopped || this.track.sender !== sender) throw new Error('nativeVideoSessionStopped');
      // 只改编码预算不重置 OBS，避免无必要的停帧和纹理重建。
      if (quality.fps !== previousFps || resolutionChanged) {
        nativeRequested = true;
        const response = await this.desktop.configureNativeVideo(sessionId, quality.fps, { width: quality.width, height: quality.height });
        if (response.changed !== true) throw new Error('nativeVideoConfigurationRejected');
      }
      if (this.stopped || this.track.sender !== sender) throw new Error('nativeVideoSessionStopped');
      this.maxFps = quality.fps;
      this.captureFrameRate = quality.fps;
      if (nativeRequested) this.deliveryFrameRate = quality.fps;
      this.frameRateAdjustmentFailed = false;
      this.resolution = { width: quality.width, height: quality.height };
      this.generator.contentHint = screenShareContentHint(id, custom);
      // SDK 重发布使用当前配置，不能重新套用最初发布时的画质。
      if (this.track.publishOptions) {
        const bitrate = limits.encodings[limits.encodings.length - 1].maxBitrate!;
        // SDK 对 ScreenShare 单独读取 screenShareEncoding，不能写入摄像头编码字段。
        this.track.publishOptions.screenShareEncoding = {
          maxBitrate: bitrate, maxFramerate: quality.fps, priority: 'high',
        };
        this.track.publishOptions.degradationPreference = screenShareDegradationPreference(id, custom);
        this.track.publishOptions.screenShareSimulcastLayers = screenShareLowerLayers(dimensions,
          previousLimits.encodings.length === 3, bitrate, this.track.publishOptions.degradationPreference);
      }
    } catch (error) {
      if (!this.stopped) {
        const rollback = await Promise.allSettled([
          ...(this.track.sender === sender ? [applyScreenShareEncoding(sender, previousLimits)] : []),
          ...(nativeRequested ? [this.desktop.configureNativeVideo(sessionId, previousFps, previousResolution).then((result) => {
            if (result.changed !== true) throw new Error('nativeVideoConfigurationRollbackRejected');
            this.deliveryFrameRate = previousFps;
          })] : []),
        ]);
        if (rollback.some((result) => result.status === 'rejected')) {
          console.error('屏幕共享画质恢复失败', rollback);
          this.fail('nativeVideoConfigurationRollbackFailed');
          throw new Error('nativeVideoConfigurationRollbackFailed');
        }
      }
      throw error;
    }
  }

  stop(retryNativeStop = false): Promise<void> {
    if (retryNativeStop && this.nativeStopUnconfirmed) {
      this.stopPromise = this.finishNativeStop(Promise.resolve());
    }
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearTimeout(this.gameFollowTimer);
    clearTimeout(this.layerResizeTimer);
    const endFollow = this.gameFollowId ? this.desktop.endNativeGameFollow!(this.gameFollowId) : Promise.resolve();
    void endFollow.catch(() => {});
    this.highQualityPreviews.clear();
    this.lastDemandSender = undefined;
    nativeVideoInputs.delete(this.generator);
    this.removeHelperErrorListener?.();
    this.removeHelperErrorListener = undefined;
    this.removeSuspensionListener?.();
    this.removeSuspensionListener = undefined;
    this.clearSuspensionTimer();
    this.startupReject?.(new Error('nativeVideoSessionStopped'));
    this.gameFirstFrameReject?.(new Error('nativeVideoSessionStopped'));
    this.gameFirstFrameReject = undefined;
    this.generator.stop();
    this.track.stop();
    this.unconfirmedFrame?.close();
    this.unconfirmedFrame = undefined;
    this.unconfirmedFrameSessionId = undefined;
    this.stopPromise = this.stopResources(endFollow, this.gameFollowId).finally(() => {
      window.removeEventListener('message', this.onWindowMessage);
    });
    return this.stopPromise;
  }

  private async stopResources(endFollow: Promise<void>, endedGameFollowId?: string): Promise<void> {
    const startCommand = this.startCommand;
    if (startCommand) {
      try {
        // 启动超时由主进程统一控制；页面不能先超时并永久留下已在回收的会话。
        const started = await startCommand;
        if (typeof started.sessionId === 'string' && started.sessionId) this.sessionId ??= started.sessionId;
        if (started.gameFollowId && started.gameFollowId !== endedGameFollowId) {
          this.gameFollowId = started.gameFollowId;
          endFollow = this.desktop.endNativeGameFollow!(started.gameFollowId);
          void endFollow.catch(() => {});
        }
      } catch {
        window.removeEventListener('message', this.onWindowMessage);
      }
    }
    if (this.writePromise) await waitWithTimeout(this.writePromise, 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    await waitWithTimeout(this.writer.close(), 500, 'nativeVideoWriterCloseTimeout').catch(() => {});
    await this.finishNativeStop(endFollow);
  }

  private async finishNativeStop(endFollow: Promise<void>): Promise<void> {
    this.nativeStopUnconfirmed = false;
    try {
      if (this.sessionId) await this.desktop.stopNativeVideo(this.sessionId);
    } catch (error) {
      await endFollow;
      this.nativeStopUnconfirmed = true;
      throw error;
    }
    await endFollow;
  }

  private readonly onWindowMessage = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== 'lycan-native-screen-frame') return;
    let frame = event.data.frame as VideoFrame | undefined;
    if (!frame || typeof frame.close !== 'function') return;
    const frameSessionId = event.data.sessionId;
    if (this.stopped && this.sessionId && frameSessionId && frameSessionId !== this.sessionId) return;
    if (typeof frameSessionId !== 'string' || !frameSessionId || this.stopped
        || (this.sessionId && frameSessionId !== this.sessionId)) {
      frame.close();
      return;
    }
    if (!this.sessionId) {
      // 启动响应可能晚于首帧；只保留一帧，取得会话标识后再确认归属。
      this.unconfirmedFrame?.close();
      this.unconfirmedFrame = frame;
      this.unconfirmedFrameSessionId = frameSessionId;
      return;
    }
    this.acceptFrame(frame);
  };

  private acceptFrame(frame: VideoFrame): void {
    // helper 已按目标帧率输出；页面只保留写入背压，避免重复限帧误丢正常帧。
    if (this.stopped) {
      frame.close();
      return;
    }
    this.receivedFrames++;
    // 借现有帧到达低频检查，不另开轮询或依赖诊断面板才能节流。
    this.refreshCaptureFrameRate();
    if (this.suspended || this.writing) {
      if (this.suspended) this.suspendedDroppedFrames++;
      else this.backpressureDroppedFrames++;
      frame.close();
      return;
    }
    this.gameFirstFrameResolve?.();
    this.gameFirstFrameResolve = undefined;
    const init: VideoFrameInit = {};
    const visibleRect = frame.visibleRect;
    // Electron 将纹理容量作为显示尺寸；实际窗口内容可能因对齐或纹理复用而更小。
    if (visibleRect) {
      const scale = Math.min(1, this.resolution.width / visibleRect.width, this.resolution.height / visibleRect.height);
      const width = Math.max(1, Math.round(visibleRect.width * scale));
      const height = Math.max(1, Math.round(visibleRect.height * scale));
      if (frame.displayWidth !== width || frame.displayHeight !== height) {
        init.displayWidth = width;
        init.displayHeight = height;
      }
    }
    if (Number.isFinite(frame.timestamp)) {
      if (!this.timestampClock) {
        const aligned = Math.max(frame.timestamp!, this.lastTimestamp + 1);
        this.timestampClock = { localMicros: Math.round(this.now() * 1000), frameMicros: aligned,
          offset: aligned - frame.timestamp! };
      }
      const timestamp = Math.max(frame.timestamp! + this.timestampClock.offset, this.lastTimestamp + 1);
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
    if (Number.isInteger(frame.displayWidth) && frame.displayWidth > 0
        && Number.isInteger(frame.displayHeight) && frame.displayHeight > 0
        && (!this.submittedFrames || this.frameWidth !== frame.displayWidth || this.frameHeight !== frame.displayHeight)) {
      this.frameWidth = frame.displayWidth;
      this.frameHeight = frame.displayHeight;
      if (this.track.sender) this.scheduleLayerResize();
    }
    this.submittedFrames++;
    if (this.firstFrameMs === null && this.startedAt !== undefined) {
      clearTimeout(this.restoreTimer);
      this.firstFrameMs = Math.max(0, this.now() - this.startedAt);
      this.desktop.recordScreenShareStartupTiming(this.sessionId!, 'screenVideoFirstFrame', this.firstFrameMs);
    }
    this.writeFrame(frame);
    // 首帧已交给轨道；write 要等 LiveKit 开始读取才可能完成，不能以它作为发布前提。
    this.startupResolve?.();
    this.startupResolve = undefined;
  }

  private setSuspended(suspended: boolean): void {
    if (this.stopped || this.suspended === suspended) return;
    this.suspended = suspended;
    this.lowerLayerDemandSince = undefined;
    this.lastDemandCheck = Number.NEGATIVE_INFINITY;
    this.clearSuspensionTimer();
    if (suspended) {
      this.writeSuspendedFrame();
      if (this.stopped) return;
      this.suspensionTimer = setInterval(() => this.writeSuspendedFrame(), SUSPENDED_HINT_INTERVAL_MS);
    } else if (this.placeholderFrames && this.firstFrameMs === null) {
      // 从最小化启动的会话在恢复后才开始计算真实首帧超时。
      this.restoreTimer = setTimeout(() => this.fail('nativeVideoFirstFrameTimeout'), this.firstFrameTimeoutMs);
    }
  }

  private scheduleLayerResize(): void {
    clearTimeout(this.layerResizeTimer);
    if (this.stopped) return;
    // 窗口停止变化后再调整分层和推荐码率，避免拖动时反复更新编码器。
    this.layerResizeTimer = setTimeout(() => {
      if (this.configuring) return;
      this.layerResizeTimer = undefined;
      this.layerResize = Promise.resolve(this.layerResize).then(() => this.updateLayerScales()).catch((error) => {
        if (!this.stopped) console.warn('窗口尺寸变化后更新共享分层失败', error);
      });
    }, RESIZE_SETTLE_MS);
  }

  private async updateLayerScales(): Promise<void> {
    const sender = this.track.sender;
    const options = this.track.publishOptions;
    if (this.stopped || this.configuring || !sender || !options) return;
    const parameters = sender.getParameters();
    const encodings = parameters.encodings;
    const dimensions = this.frameDimensions;
    if (!dimensions || (encodings.length !== 1 && !hasScreenShareSimulcast(encodings))) return;
    const main = encodings[encodings.length - 1];
    const bitrate = this.recommendedQuality ? screenShareQuality('custom', this.recommendedQuality, dimensions).bitrate : main.maxBitrate;
    if (!bitrate) return;
    const layers = encodings.length > 1
      ? screenShareLowerLayers(dimensions, encodings.length === 3, bitrate, options.degradationPreference) : [];
    let changed = main.maxBitrate !== bitrate;
    if (changed) main.maxBitrate = bitrate;
    layers.forEach((layer, index) => {
      const encoding = encodings[index];
      if (this.recommendedQuality && encoding.maxBitrate !== layer.encoding.maxBitrate) {
        encoding.maxBitrate = layer.encoding.maxBitrate;
        changed = true;
      }
      const scale = Math.max(1, Math.min(dimensions.width, dimensions.height) / Math.min(layer.width, layer.height));
      if (encoding.scaleResolutionDownBy === scale) return;
      encoding.scaleResolutionDownBy = scale;
      changed = true;
    });
    if (changed) await sender.setParameters(parameters);
    if (this.stopped || this.track.sender !== sender) return;
    if (options.screenShareEncoding && this.recommendedQuality) options.screenShareEncoding.maxBitrate = bitrate;
    if (encodings.length > 1) options.screenShareSimulcastLayers = layers;
  }

  private writeSuspendedFrame(): void {
    if (this.stopped || !this.suspended || this.writing) return;
    const scale = Math.min(1, this.resolution.width / this.frameWidth, this.resolution.height / this.frameHeight);
    const width = Math.max(1, Math.round(this.frameWidth * scale));
    const height = Math.max(1, Math.round(this.frameHeight * scale));
    // 提示帧沿用当前宿主帧的时钟；页面运行时长不能让恢复画面跳到未来。
    const localMicros = Math.round(this.now() * 1000);
    const frameMicros = this.timestampClock
      ? this.timestampClock.frameMicros + Math.max(0, localMicros - this.timestampClock.localMicros) : localMicros;
    const timestamp = Math.max(frameMicros, this.lastTimestamp + 1);
    try {
      this.writeFrame(this.createSuspendedFrame(width, height, timestamp,
        Boolean(this.gameFollowId && (this.gameTargetClosed || this.gameSourceChanging))));
      this.placeholderFrames++;
      this.startupResolve?.();
      this.startupResolve = undefined;
    } catch {
      this.fail('nativeVideoPauseFrameFailed');
    }
  }

  private writeFrame(frame: VideoFrame): void {
    if (Number.isFinite(frame.timestamp)) this.lastTimestamp = Math.max(this.lastTimestamp, frame.timestamp);
    this.writingFrame = frame;
    this.writePromise = this.writer.write(frame).then(() => {
      this.completedWrites++;
    }, () => {
      this.writeFailures++;
      this.fail('nativeVideoTrackWriteFailed');
    }).finally(() => {
      frame.close();
      if (this.writingFrame === frame) this.writingFrame = undefined;
    });
  }

  private clearSuspensionTimer(): void {
    clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    if (this.suspensionTimer !== undefined) clearInterval(this.suspensionTimer);
    this.suspensionTimer = undefined;
  }

  private scheduleGameFollow(): void {
    if (this.stopped) return;
    this.gameFollowTimer = setTimeout(() => {
      void this.refreshGameSource().catch(() => this.fail('nativeGameFollowFailed')).finally(() => this.scheduleGameFollow());
    }, 750);
  }

  private async refreshGameSource(): Promise<void> {
    if (this.stopped || this.configuring || this.demandChange || this.isCurrentCapture?.() === false || this.canChangeGameSource?.() === false) return;
    const id = this.gameFollowId!;
    const next = await this.desktop.findNativeGameSource!(id);
    if (this.stopped || this.isCurrentCapture?.() === false) return;
    if (!next.sourceId || (!this.gameTargetClosed && next.sourceId === this.sourceId)) {
      if (this.gameTargetClosed && this.gameWaitingSince !== undefined && this.now() - this.gameWaitingSince >= 30_000) {
        this.fail('captureTargetClosed');
      }
      return;
    }
    if (this.configuring || this.demandChange || this.canChangeGameSource?.() === false) return;
    this.gameSourceChanging = true;
    this.setSuspended(true);
    try {
      await this.onGameSourceChanging?.();
      if (this.stopped || this.isCurrentCapture?.() === false) return;
      const firstFrame = new Promise<void>((resolve, reject) => {
        this.gameFirstFrameResolve = resolve;
        this.gameFirstFrameReject = reject;
      });
      void firstFrame.catch(() => {});
      const previousSessionId = this.sessionId;
      this.sessionId = undefined;
      this.pendingHelperFailure = undefined;
      this.pendingSuspension = undefined;
      this.startCommand = this.desktop.switchNativeGameVideo!(id, next.sourceId, this.maxFps,
        this.captureSettings!, this.resolution);
      const started = await this.startCommand.catch(error => {
        // 切换在停止旧来源之前也可能被拒绝；保留旧标识让最终清理仍能找到它。
        this.sessionId = previousSessionId;
        throw error;
      });
      this.sessionId = started.sessionId;
      this.timestampClock = undefined;
      if (this.stopped) return;
      if (started.changed !== true || !started.sessionId || started.gameFollowId !== id) throw new Error('nativeGameFollowUnavailable');
      this.sourceId = next.sourceId;
      this.captureFrameRate = this.maxFps;
      this.deliveryFrameRate = this.maxFps;
      this.setSuspended(false);
      const pending = this.unconfirmedFrame;
      this.unconfirmedFrame = undefined;
      const frameSessionId = this.unconfirmedFrameSessionId;
      this.unconfirmedFrameSessionId = undefined;
      if (pending) {
        if (frameSessionId === this.sessionId) this.acceptFrame(pending);
        else pending.close();
      }
      // 回调可在启动响应等待期间写入；不能把等待前清空视为之后仍没有事件。
      const pendingFailure = this.pendingHelperFailure as { sessionId: string; code: string } | undefined;
      const pendingSuspension = this.pendingSuspension as { sessionId: string; suspended: boolean } | undefined;
      this.pendingHelperFailure = undefined;
      this.pendingSuspension = undefined;
      if (pendingFailure?.sessionId === this.sessionId) throw new Error(pendingFailure.code);
      if (pendingSuspension?.sessionId === this.sessionId) this.setSuspended(pendingSuspension.suspended);
      await waitWithTimeout(firstFrame, this.firstFrameTimeoutMs, 'nativeVideoFirstFrameTimeout');
      if (this.stopped || this.isCurrentCapture?.() === false) return;
      this.gameTargetClosed = false;
      this.gameWaitingSince = undefined;
      await this.onGameSourceChanged?.(next.sourceId, this.sessionId);
    } finally {
      this.gameFirstFrameResolve = undefined;
      this.gameFirstFrameReject = undefined;
      this.gameSourceChanging = false;
    }
  }

  private fail(code: string): void {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'nativeVideoFailed';
    this.startupReject?.(new Error(safeCode));
    this.startupReject = undefined;
    this.onError?.(safeCode);
    void this.stop().catch((error) => {
      console.error('原生屏幕共享停止未完成', error);
    });
  }
}

function createSuspendedFrame(width: number, height: number, timestamp: number, waitingForGame = false): VideoFrame {
  return createScreenStatusFrame(width, height, timestamp, waitingForGame ? {
    title: '正在切换英雄联盟画面', description: '等待大厅或对局窗口就绪',
  } : {
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

import { LocalAudioTrack } from 'livekit-client';
import processorUrl from './nativeScreenAudio.worklet.js?url&no-inline';

export interface NativeScreenAudioDesktopBridge {
  startNativeScreenAudio(sourceId: string, sessionId: string): Promise<{
    sampleRate: number;
    channels: 2;
    bitsPerSample: 32;
    nominalChunkMs: 10;
  }>;
  stopNativeScreenAudio(sessionId: string): Promise<{ changed: boolean }>;
  onNativeScreenAudioChunk(callback: (chunk: NativeScreenAudioChunk) => void): () => void;
  acknowledgeNativeScreenAudioChunk(sessionId: string, sequence: number, droppedChunks: number): void;
  onNativeScreenAudioError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
}

export interface NativeScreenAudioChunk {
  sessionId: string;
  sequence: number;
  frames: number;
  sampleRate: number;
  channels: 2;
  pcm: Uint8Array;
}

interface NativeScreenAudioOptions {
  onError?: (code: string) => void;
  createContext?: (sampleRate: number) => AudioContext;
  createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
  createLocalTrack?: (track: MediaStreamTrack, context: AudioContext) => LocalAudioTrack;
}

/** 将有界 WASAPI PCM 队列接入共享声音音轨，不连接本机扬声器。 */
export class NativeScreenAudioSession {
  track?: LocalAudioTrack;

  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private sessionId?: string;
  private startCommand?: Promise<{ sampleRate: number; channels: 2; bitsPerSample: 32; nominalChunkMs: 10 }>;
  private removeChunkListener?: () => void;
  private removeErrorListener?: () => void;
  private stopPromise?: Promise<void>;
  private nativeStartCommand?: ReturnType<NativeScreenAudioDesktopBridge['startNativeScreenAudio']>;
  private stopped = false;
  private droppedChunksBeforeWorklet = 0;
  private readonly onError?: (code: string) => void;

  constructor(
    private readonly desktop: NativeScreenAudioDesktopBridge,
    options: NativeScreenAudioOptions = {},
  ) {
    this.onError = options.onError;
    this.createContext = options.createContext ?? ((sampleRate) => new AudioContext({ sampleRate }));
    this.createWorkletNode = options.createWorkletNode ?? ((context) => new AudioWorkletNode(context, 'lycan-screen-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    }));
    this.createLocalTrack = options.createLocalTrack ?? ((track) => new LocalAudioTrack(track, {}, true));
  }

  private readonly createContext: (sampleRate: number) => AudioContext;
  private readonly createWorkletNode: (context: AudioContext) => AudioWorkletNode;
  private readonly createLocalTrack: (track: MediaStreamTrack, context: AudioContext) => LocalAudioTrack;

  start(sourceId: string, sessionId: string): Promise<LocalAudioTrack> {
    if (this.stopped) return Promise.reject(new Error('screenAudioSessionStopped'));
    if (!this.startCommand) this.startCommand = this.startGraphAndCapture(sourceId, sessionId);
    return this.startCommand.then(() => {
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      if (!this.track) throw new Error('screenAudioTrackUnavailable');
      return this.track;
    });
  }

  private async startGraphAndCapture(sourceId: string, sessionId: string) {
    this.sessionId = sessionId;
    this.removeChunkListener = this.desktop.onNativeScreenAudioChunk((chunk) => this.acceptChunk(chunk));
    this.removeErrorListener = this.desktop.onNativeScreenAudioError((failure) => {
      if (failure?.sessionId === this.sessionId) this.fail(failure.code);
    });
    try {
      this.nativeStartCommand = this.desktop.startNativeScreenAudio(sourceId, sessionId);
      const format = await this.nativeStartCommand;
      if (format.channels !== 2 || format.bitsPerSample !== 32 || format.nominalChunkMs !== 10
          || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000) {
        throw new Error('screenAudioFormatUnsupported');
      }
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      this.context = this.createContext(format.sampleRate);
      await this.context.audioWorklet.addModule(processorUrl);
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      this.node = this.createWorkletNode(this.context);
      const workletSessionId = sessionId;
      const destination = this.context.createMediaStreamDestination();
      this.node.connect(destination);
      this.node.port.onmessage = (event: MessageEvent) => {
        if (!this.stopped && event.data?.type === 'accepted' && Number.isSafeInteger(event.data.sequence)) {
          this.desktop.acknowledgeNativeScreenAudioChunk(workletSessionId, event.data.sequence,
            this.droppedChunksBeforeWorklet
              + (Number.isSafeInteger(event.data.droppedChunks) ? event.data.droppedChunks : 0));
        }
      };
      await this.context.resume();
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      this.track = this.createLocalTrack(destination.stream.getAudioTracks()[0], this.context);
      return format;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '共享声音启动失败，清理未完成。');
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = Promise.resolve().then(async () => {
      const context = this.context;
      const node = this.node;
      const removeChunks = this.removeChunkListener;
      const removeErrors = this.removeErrorListener;
      this.context = undefined;
      this.node = undefined;
      this.removeChunkListener = undefined;
      this.removeErrorListener = undefined;
      // 分别尝试每项清理，单个资源失败不能阻断其余释放。
      const cleanups = [
        Promise.resolve().then(() => removeChunks?.()),
        Promise.resolve().then(() => removeErrors?.()),
        Promise.resolve().then(() => node?.port.close()),
        Promise.resolve().then(() => node?.disconnect()),
        Promise.resolve().then(() => this.track?.stop()),
        Promise.resolve().then(() => context && context.state !== 'closed' ? context.close() : undefined),
        Promise.resolve().then(async () => {
          if (!this.nativeStartCommand || !this.sessionId) return;
          try {
            await this.nativeStartCommand;
          } catch {
            // 启动被拒绝时没有取得采集会话，无需发送对应停止命令。
            return;
          }
          await this.desktop.stopNativeScreenAudio(this.sessionId);
        }),
      ];
      const results = await Promise.allSettled(cleanups);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '共享声音清理未完成。');
    });
    return this.stopPromise;
  }

  private acceptChunk(chunk: NativeScreenAudioChunk) {
    if (this.stopped || !chunk || chunk.sessionId !== this.sessionId || !Number.isSafeInteger(chunk.sequence)) return;
    if (!this.node) {
      this.desktop.acknowledgeNativeScreenAudioChunk(this.sessionId!, chunk.sequence, ++this.droppedChunksBeforeWorklet);
      return;
    }
    const sampleRate = this.context?.sampleRate;
    if (!sampleRate || !Number.isSafeInteger(chunk.frames)
        || chunk.frames < 1 || chunk.frames > 4096
        || chunk.sampleRate !== sampleRate || chunk.channels !== 2
        || !(chunk.pcm instanceof Uint8Array) || chunk.pcm.byteLength !== chunk.frames * 8
        || chunk.pcm.byteLength % 4 !== 0) {
      if (!this.stopped && chunk?.sequence) {
        this.desktop.acknowledgeNativeScreenAudioChunk(this.sessionId!, chunk.sequence, ++this.droppedChunksBeforeWorklet);
      }
      return;
    }
    const pcm = chunk.pcm.slice();
    this.node.port.postMessage({ type: 'chunk', sequence: chunk.sequence, pcm: pcm.buffer }, [pcm.buffer]);
  }

  private fail(code: string) {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
    try {
      this.onError?.(safeCode);
    } finally {
      void this.stop().catch((error) => console.error('共享声音异常后的清理失败', error));
    }
  }
}

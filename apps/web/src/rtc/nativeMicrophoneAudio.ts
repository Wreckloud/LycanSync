import { LocalAudioTrack } from 'livekit-client';
import processorUrl from './nativeMicrophoneAudio.worklet.js?url&no-inline';
import type { AudioProcessingSettings } from './audioPreferences';

export interface NativeMicrophoneSettings extends Omit<AudioProcessingSettings, 'echoCancellation'> {
  inputGain: number;
}

export interface NativeMicrophoneChunk {
  sessionId: string;
  sequence: number;
  frames: number;
  sampleRate: number;
  channels: 1;
  pcm: Uint8Array;
}

export interface NativeMicrophoneDesktopBridge {
  startNativeMicrophone(sessionId: string, settings: NativeMicrophoneSettings): Promise<{
    sampleRate: 48000; channels: 1; bitsPerSample: 32; nominalChunkMs: 10;
  }>;
  configureNativeMicrophone(sessionId: string, settings: NativeMicrophoneSettings): Promise<{ changed: boolean }>;
  stopNativeMicrophone(sessionId: string): Promise<{ changed: boolean }>;
  onNativeMicrophoneChunk(callback: (chunk: NativeMicrophoneChunk) => void): () => void;
  acknowledgeNativeMicrophoneChunk(sessionId: string, sequence: number, droppedChunks: number): void;
  onNativeMicrophoneError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
}

interface NativeMicrophoneOptions {
  onError?: (code: string) => void;
  createContext?: (sampleRate: number) => AudioContext;
  createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
  createLocalTrack?: (track: MediaStreamTrack, context: AudioContext) => LocalAudioTrack;
}

/** Sends mono WASAPI PCM through the current room's ordinary LocalAudioTrack. */
export class NativeMicrophoneAudioSession {
  track?: LocalAudioTrack;

  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private sessionId?: string;
  private startCommand?: Promise<void>;
  private removeChunkListener?: () => void;
  private removeErrorListener?: () => void;
  private stopPromise?: Promise<void>;
  private nativeStartCommand?: ReturnType<NativeMicrophoneDesktopBridge['startNativeMicrophone']>;
  private stopped = false;
  private started = false;
  private droppedChunks = 0;
  private readonly onError?: (code: string) => void;
  private readonly createContext: (sampleRate: number) => AudioContext;
  private readonly createWorkletNode: (context: AudioContext) => AudioWorkletNode;
  private readonly createLocalTrack: (track: MediaStreamTrack, context: AudioContext) => LocalAudioTrack;

  constructor(private readonly desktop: NativeMicrophoneDesktopBridge, options: NativeMicrophoneOptions = {}) {
    this.onError = options.onError;
    this.createContext = options.createContext ?? ((sampleRate) => new AudioContext({ sampleRate }));
    this.createWorkletNode = options.createWorkletNode ?? ((context) => new AudioWorkletNode(context,
      'lycan-native-microphone', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }));
    this.createLocalTrack = options.createLocalTrack ?? ((track) => new LocalAudioTrack(track, {}, true));
  }

  start(sessionId: string, settings: NativeMicrophoneSettings): Promise<LocalAudioTrack> {
    if (this.stopped) return Promise.reject(new Error('microphoneSessionStopped'));
    if (!this.startCommand) this.startCommand = this.startGraphAndCapture(sessionId, settings);
    return this.startCommand.then(() => {
      if (this.stopped || !this.track) throw new Error('microphoneSessionStopped');
      return this.track;
    });
  }

  configure(settings: NativeMicrophoneSettings) {
    if (this.stopped || !this.sessionId || !this.startCommand) {
      return Promise.reject(new Error('microphoneSessionStopped'));
    }
    const sessionId = this.sessionId;
    return this.startCommand.then(() => {
      if (this.stopped || !this.started) throw new Error('microphoneSessionStopped');
      return this.desktop.configureNativeMicrophone(sessionId, settings);
    });
  }

  private async startGraphAndCapture(sessionId: string, settings: NativeMicrophoneSettings) {
    this.sessionId = sessionId;
    this.removeChunkListener = this.desktop.onNativeMicrophoneChunk((chunk) => this.acceptChunk(chunk));
    this.removeErrorListener = this.desktop.onNativeMicrophoneError((failure) => {
      if (failure?.sessionId === this.sessionId) this.fail(failure.code);
    });
    try {
      this.context = this.createContext(48_000);
      await this.context.audioWorklet.addModule(processorUrl);
      if (this.stopped) throw new Error('microphoneSessionStopped');
      this.node = this.createWorkletNode(this.context);
      const workletSessionId = sessionId;
      const destination = this.context.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      this.node.connect(destination);
      this.node.port.onmessage = (event: MessageEvent) => {
        if (!this.stopped && event.data?.type === 'accepted' && Number.isSafeInteger(event.data.sequence)) {
          const workletDropped = Number.isSafeInteger(event.data.droppedChunks) ? event.data.droppedChunks : 0;
          this.desktop.acknowledgeNativeMicrophoneChunk(workletSessionId,
            event.data.sequence, this.droppedChunks + workletDropped);
        }
      };
      await this.context.resume();
      if (this.stopped) throw new Error('microphoneSessionStopped');
      this.track = this.createLocalTrack(destination.stream.getAudioTracks()[0], this.context);
      this.nativeStartCommand = this.desktop.startNativeMicrophone(sessionId, settings);
      await this.nativeStartCommand;
      this.started = true;
      if (this.stopped) throw new Error('microphoneSessionStopped');
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '原生麦克风启动失败，清理未完成。');
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
      // Each resource must be released even when another cleanup fails.
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
            // A rejected native startup did not establish an owned capture session.
            return;
          }
          this.started = false;
          await this.desktop.stopNativeMicrophone(this.sessionId);
        }),
      ];
      const results = await Promise.allSettled(cleanups);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '原生麦克风清理未完成。');
    });
    return this.stopPromise;
  }

  private acceptChunk(chunk: NativeMicrophoneChunk) {
    if (this.stopped || !chunk || chunk.sessionId !== this.sessionId || !Number.isSafeInteger(chunk.sequence)) return;
    if (!this.node) {
      this.desktop.acknowledgeNativeMicrophoneChunk(this.sessionId!, chunk.sequence, ++this.droppedChunks);
      return;
    }
    if (chunk.frames !== 480 || chunk.sampleRate !== 48_000 || chunk.channels !== 1
        || !(chunk.pcm instanceof Uint8Array) || chunk.pcm.byteLength !== 480 * 4) {
      this.desktop.acknowledgeNativeMicrophoneChunk(this.sessionId!, chunk.sequence, ++this.droppedChunks);
      return;
    }
    const pcm = chunk.pcm.slice();
    this.node.port.postMessage({ type: 'chunk', sequence: chunk.sequence, pcm: pcm.buffer }, [pcm.buffer]);
  }

  private fail(code: string) {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'microphoneCaptureFailed';
    try {
      this.onError?.(safeCode);
    } finally {
      void this.stop().catch((error) => console.error('原生麦克风异常后的清理失败', error));
    }
  }
}

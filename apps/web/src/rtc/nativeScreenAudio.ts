import { LocalAudioTrack } from 'livekit-client';

export interface NativeScreenAudioDesktopBridge {
  startNativeScreenAudio(sourceId: string, sessionId: string): Promise<{
    sampleRate: number;
    channels: 2;
    bitsPerSample: 32;
    nominalChunkMs: 10;
  }>;
  stopNativeScreenAudio(sessionId: string): Promise<{ changed: boolean }>;
  onNativeScreenAudioChunk(callback: (chunk: NativeScreenAudioChunk) => void): () => void;
  acknowledgeNativeScreenAudioChunk(sequence: number, droppedChunks: number): void;
  onNativeScreenAudioError(callback: (code: string) => void): () => void;
}

export interface NativeScreenAudioChunk {
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

const PROCESSOR_SOURCE = `
class LycanScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.dropped = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'chunk' || !(data.pcm instanceof ArrayBuffer)) return;
      if (this.queue.length >= 2) { this.queue.shift(); this.dropped++; }
      this.queue.push({ sequence: data.sequence, samples: new Float32Array(data.pcm), offset: 0 });
      this.port.postMessage({ type: 'accepted', sequence: data.sequence, droppedChunks: this.dropped });
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const left = output[0];
    const right = output[1];
    for (let index = 0; index < left.length; index++) {
      if (!this.current || this.current.offset >= this.current.samples.length / 2) {
        this.current = this.queue.shift() || null;
      }
      if (!this.current) { left[index] = 0; right[index] = 0; continue; }
      const sample = this.current.offset++ * 2;
      left[index] = this.current.samples[sample];
      right[index] = this.current.samples[sample + 1];
    }
    return true;
  }
}
registerProcessor('lycan-screen-audio', LycanScreenAudioProcessor);
`;

/** Feeds bounded WASAPI PCM blocks to an inaudible MediaStreamDestination track. */
export class NativeScreenAudioSession {
  track?: LocalAudioTrack;

  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private sessionId?: string;
  private startCommand?: Promise<{ sampleRate: number; channels: 2; bitsPerSample: 32; nominalChunkMs: 10 }>;
  private removeChunkListener?: () => void;
  private removeErrorListener?: () => void;
  private stopPromise?: Promise<void>;
  private stopped = false;
  private started = false;
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
      if (!this.track) throw new Error('screenAudioTrackUnavailable');
      return this.track;
    });
  }

  private async startGraphAndCapture(sourceId: string, sessionId: string) {
    this.sessionId = sessionId;
    this.removeChunkListener = this.desktop.onNativeScreenAudioChunk((chunk) => this.acceptChunk(chunk));
    this.removeErrorListener = this.desktop.onNativeScreenAudioError((code) => this.fail(code));
    let objectUrl: string | undefined;
    try {
      const format = await this.desktop.startNativeScreenAudio(sourceId, sessionId);
      this.started = true;
      if (format.channels !== 2 || format.bitsPerSample !== 32 || format.nominalChunkMs !== 10
          || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000) {
        throw new Error('screenAudioFormatUnsupported');
      }
      if (this.stopped) {
        this.started = false;
        await this.desktop.stopNativeScreenAudio(sessionId).catch(() => {});
        throw new Error('screenAudioSessionStopped');
      }
      this.context = this.createContext(format.sampleRate);
      const blob = new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' });
      objectUrl = URL.createObjectURL(blob);
      await this.context.audioWorklet.addModule(objectUrl);
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      this.node = this.createWorkletNode(this.context);
      const destination = this.context.createMediaStreamDestination();
      this.node.connect(destination);
      this.node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'accepted' && Number.isSafeInteger(event.data.sequence)) {
          this.desktop.acknowledgeNativeScreenAudioChunk(event.data.sequence,
            this.droppedChunksBeforeWorklet
              + (Number.isSafeInteger(event.data.droppedChunks) ? event.data.droppedChunks : 0));
        }
      };
      await this.context.resume();
      if (this.stopped) throw new Error('screenAudioSessionStopped');
      this.track = this.createLocalTrack(destination.stream.getAudioTracks()[0], this.context);
      return format;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.removeChunkListener?.();
    this.removeChunkListener = undefined;
    this.removeErrorListener?.();
    this.removeErrorListener = undefined;
    this.node?.port.close();
    this.node?.disconnect();
    this.node = undefined;
    this.track?.stop();
    this.stopPromise = (async () => {
      const context = this.context;
      this.context = undefined;
      if (context && context.state !== 'closed') await context.close();
      if (this.sessionId && this.started) {
        this.started = false;
        await this.desktop.stopNativeScreenAudio(this.sessionId);
      }
    })();
    return this.stopPromise;
  }

  private acceptChunk(chunk: NativeScreenAudioChunk) {
    if (this.stopped || !chunk || !Number.isSafeInteger(chunk.sequence)) return;
    if (!this.node) {
      this.desktop.acknowledgeNativeScreenAudioChunk(chunk.sequence, ++this.droppedChunksBeforeWorklet);
      return;
    }
    const sampleRate = this.context?.sampleRate;
    if (!sampleRate || !Number.isSafeInteger(chunk.frames)
        || chunk.frames < 1 || chunk.frames > 4096
        || chunk.sampleRate !== sampleRate || chunk.channels !== 2
        || !(chunk.pcm instanceof Uint8Array) || chunk.pcm.byteLength !== chunk.frames * 8
        || chunk.pcm.byteLength % 4 !== 0) {
      if (!this.stopped && chunk?.sequence) {
        this.desktop.acknowledgeNativeScreenAudioChunk(chunk.sequence, ++this.droppedChunksBeforeWorklet);
      }
      return;
    }
    const pcm = chunk.pcm.slice();
    this.node.port.postMessage({ type: 'chunk', sequence: chunk.sequence, pcm: pcm.buffer }, [pcm.buffer]);
  }

  private fail(code: string) {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'screenShareAudioFailed';
    this.onError?.(safeCode);
    void this.stop();
  }
}

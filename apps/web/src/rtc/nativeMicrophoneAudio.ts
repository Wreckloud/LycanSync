import { LocalAudioTrack } from 'livekit-client';
import type { AudioProcessingSettings } from './audioPreferences';

export interface NativeMicrophoneSettings extends Omit<AudioProcessingSettings, 'echoCancellation'> {
  inputGain: number;
}

export interface NativeMicrophoneChunk {
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
  acknowledgeNativeMicrophoneChunk(sequence: number, droppedChunks: number): void;
  onNativeMicrophoneError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
}

interface NativeMicrophoneOptions {
  onError?: (code: string) => void;
  createContext?: (sampleRate: number) => AudioContext;
  createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
  createLocalTrack?: (track: MediaStreamTrack, context: AudioContext) => LocalAudioTrack;
}

const PROCESSOR_SOURCE = `
class LycanMicrophoneProcessor extends AudioWorkletProcessor {
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
    if (!output || output.length < 1) return true;
    const samples = output[0];
    for (let index = 0; index < samples.length; index++) {
      if (!this.current || this.current.offset >= this.current.samples.length) this.current = this.queue.shift() || null;
      samples[index] = this.current ? this.current.samples[this.current.offset++] : 0;
    }
    return true;
  }
}
registerProcessor('lycan-native-microphone', LycanMicrophoneProcessor);
`;

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
    let objectUrl: string | undefined;
    try {
      this.context = this.createContext(48_000);
      const blob = new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' });
      objectUrl = URL.createObjectURL(blob);
      await this.context.audioWorklet.addModule(objectUrl);
      if (this.stopped) throw new Error('microphoneSessionStopped');
      this.node = this.createWorkletNode(this.context);
      const destination = this.context.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      this.node.connect(destination);
      this.node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'accepted' && Number.isSafeInteger(event.data.sequence)) {
          const workletDropped = Number.isSafeInteger(event.data.droppedChunks) ? event.data.droppedChunks : 0;
          this.desktop.acknowledgeNativeMicrophoneChunk(event.data.sequence, this.droppedChunks + workletDropped);
        }
      };
      await this.context.resume();
      if (this.stopped) throw new Error('microphoneSessionStopped');
      this.track = this.createLocalTrack(destination.stream.getAudioTracks()[0], this.context);
      await this.desktop.startNativeMicrophone(sessionId, settings);
      this.started = true;
      if (this.stopped) {
        this.started = false;
        await this.desktop.stopNativeMicrophone(sessionId).catch(() => {});
        throw new Error('microphoneSessionStopped');
      }
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
        await this.desktop.stopNativeMicrophone(this.sessionId);
      }
    })();
    return this.stopPromise;
  }

  private acceptChunk(chunk: NativeMicrophoneChunk) {
    if (this.stopped || !chunk || !Number.isSafeInteger(chunk.sequence)) return;
    if (!this.node) {
      this.desktop.acknowledgeNativeMicrophoneChunk(chunk.sequence, ++this.droppedChunks);
      return;
    }
    if (chunk.frames !== 480 || chunk.sampleRate !== 48_000 || chunk.channels !== 1
        || !(chunk.pcm instanceof Uint8Array) || chunk.pcm.byteLength !== 480 * 4) {
      this.desktop.acknowledgeNativeMicrophoneChunk(chunk.sequence, ++this.droppedChunks);
      return;
    }
    const pcm = chunk.pcm.slice();
    this.node.port.postMessage({ type: 'chunk', sequence: chunk.sequence, pcm: pcm.buffer }, [pcm.buffer]);
  }

  private fail(code: string) {
    if (this.stopped) return;
    const safeCode = /^[a-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'microphoneCaptureFailed';
    this.onError?.(safeCode);
    void this.stop();
  }
}

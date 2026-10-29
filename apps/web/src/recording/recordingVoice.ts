import workletUrl from './recordingVoice.worklet.js?url&no-inline';

export interface RecordingVoiceTrack { track: MediaStreamTrack; gain: number }

/** 借用已发布／订阅的人声轨道，停止时只释放混音图，不停止原轨道。 */
export class RecordingVoice {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private limiter?: DynamicsCompressorNode;
  private silence?: GainNode;
  private tracks = new Map<MediaStreamTrack, { source: MediaStreamAudioSourceNode; gain: GainNode }>();
  private stopped = false;

  constructor(private readonly id: string, private readonly send: (id: string, position: number, pcm: Uint8Array) => Promise<boolean>,
    private readonly onFailure: () => void) {}

  async start() {
    const context = new AudioContext({ sampleRate: 48_000 });
    this.context = context;
    try {
      if (context.sampleRate !== 48_000) throw new Error('recordingVoiceUnavailable');
      await context.audioWorklet.addModule(workletUrl);
      if (this.stopped) return;
      const node = new AudioWorkletNode(context, 'lycan-recording-voice', { channelCount: 1, channelCountMode: 'explicit',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.node = node;
      this.limiter = context.createDynamicsCompressor();
      this.limiter.threshold.value = -3; this.limiter.knee.value = 6; this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003; this.limiter.release.value = 0.1;
      this.limiter.connect(node);
      this.silence = context.createGain(); this.silence.gain.value = 0;
      node.connect(this.silence).connect(context.destination);
      node.onprocessorerror = () => { if (!this.stopped) this.onFailure(); };
      node.port.onmessage = async event => {
        if (this.stopped || event.data?.type !== 'voice' || !(event.data.pcm instanceof ArrayBuffer)) return;
        try { await this.send(this.id, event.data.position, new Uint8Array(event.data.pcm)); }
        catch { if (!this.stopped) this.onFailure(); }
        finally { if (!this.stopped) node.port.postMessage({ type: 'ack' }); }
      };
      await context.resume();
    } catch (error) { await this.stop(); throw error; }
  }
  update(tracks: RecordingVoiceTrack[]) {
    if (this.stopped || !this.context || !this.limiter) return;
    tracks = tracks.filter(item => Number.isFinite(item.gain) && item.gain > 0 && item.track.readyState !== 'ended');
    const next = new Set(tracks.map(item => item.track));
    for (const [track, entry] of this.tracks) {
      if (!next.has(track)) { entry.source.disconnect(); entry.gain.disconnect(); this.tracks.delete(track); }
    }
    for (const item of tracks) {
      if (!Number.isFinite(item.gain) || item.gain <= 0 || item.track.readyState === 'ended') continue;
      let entry = this.tracks.get(item.track);
      if (!entry) {
        entry = { source: this.context.createMediaStreamSource(new MediaStream([item.track])), gain: this.context.createGain() };
        entry.source.connect(entry.gain).connect(this.limiter); this.tracks.set(item.track, entry);
      }
      entry.gain.gain.value = Math.min(item.gain, 2);
    }
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.tracks.values()) { entry.source.disconnect(); entry.gain.disconnect(); }
    this.tracks.clear(); this.limiter?.disconnect(); this.silence?.disconnect();
    if (this.node) {
      this.node.onprocessorerror = null; this.node.port.onmessage = null;
      this.node.port.postMessage({ type: 'stop' }); this.node.port.close(); this.node.disconnect();
    }
    if (this.context?.state !== 'closed') await this.context?.close();
  }
}

class RecordingVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(480);
    this.cursor = 0;
    this.position = 0;
    this.inFlight = 0;
    this.stopped = false;
    this.port.onmessage = event => {
      if (event.data?.type === 'ack') this.inFlight = Math.max(0, this.inFlight - 1);
      if (event.data?.type === 'stop') this.stopped = true;
    };
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    const length = outputs[0]?.[0]?.length ?? 128;
    for (let i = 0; i < length; i++) {
      if (!this.cursor) this.position = currentFrame + i;
      const sample = input?.[i] ?? 0;
      this.samples[this.cursor++] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      if (this.cursor !== 480) continue;
      if (this.inFlight < 2) {
        const pcm = this.samples.slice();
        this.port.postMessage({ type: 'voice', position: this.position, pcm: pcm.buffer }, [pcm.buffer]);
        this.inFlight++;
      }
      this.cursor = 0;
    }
    // 只维持音频图运行，输出保持静音，不能把本地麦克风回放到扬声器。
    return true;
  }
}
registerProcessor('lycan-recording-voice', RecordingVoiceProcessor);

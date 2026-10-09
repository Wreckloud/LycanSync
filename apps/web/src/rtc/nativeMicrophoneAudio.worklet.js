class LycanMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.dropped = 0;
    this.pendingAcknowledgements = [];
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'chunk' || !(data.pcm instanceof ArrayBuffer)) return;
      if (this.queue.length >= 12) {
        const discarded = this.queue.shift();
        this.dropped++;
        const pendingIndex = this.pendingAcknowledgements.indexOf(discarded.sequence);
        if (pendingIndex >= 0) {
          this.pendingAcknowledgements.splice(pendingIndex, 1);
          this.port.postMessage({ type: 'accepted', sequence: discarded.sequence, droppedChunks: this.dropped });
        }
      }
      this.queue.push({ sequence: data.sequence, samples: new Float32Array(data.pcm), offset: 0 });
      this.pendingAcknowledgements.push(data.sequence);
      this.acknowledgeAvailableCapacity();
    };
  }
  acknowledgeAvailableCapacity() {
    // Keep a small playback reserve; delay IPC acknowledgements while it is full.
    if (this.queue.length >= 4) return;
    for (const sequence of this.pendingAcknowledgements) {
      this.port.postMessage({ type: 'accepted', sequence, droppedChunks: this.dropped });
    }
    this.pendingAcknowledgements.length = 0;
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 1) return true;
    const samples = output[0];
    for (let index = 0; index < samples.length; index++) {
      if (!this.current || this.current.offset >= this.current.samples.length) this.current = this.queue.shift() || null;
      samples[index] = this.current ? this.current.samples[this.current.offset++] : 0;
    }
    this.acknowledgeAvailableCapacity();
    return true;
  }
}
registerProcessor('lycan-native-microphone', LycanMicrophoneProcessor);

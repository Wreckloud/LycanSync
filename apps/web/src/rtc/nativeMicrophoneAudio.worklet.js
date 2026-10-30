class LycanMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.dropped = 0;
    this.pendingAcknowledgements = [];
    this.pushToTalk = false;
    this.remaining = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'gate' && typeof data.pushToTalk === 'boolean' && typeof data.held === 'boolean') {
        const wasOpen = !this.pushToTalk || this.remaining > 0;
        this.pushToTalk = data.pushToTalk;
        this.remaining = data.held ? Math.round(sampleRate * 0.35) : 0;
        if (wasOpen !== (!this.pushToTalk || this.remaining > 0)) {
          this.queue.length = 0;
          this.current = null;
          this.acknowledgeAvailableCapacity();
        }
        return;
      }
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
    // 待播队列满时延后确认，让主进程暂停发送，避免持续积压。
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
      const value = this.current ? this.current.samples[this.current.offset++] : 0;
      samples[index] = !this.pushToTalk || this.remaining > 0 ? value : 0;
      if (this.remaining > 0) this.remaining--;
    }
    this.acknowledgeAvailableCapacity();
    return true;
  }
}
registerProcessor('lycan-native-microphone', LycanMicrophoneProcessor);

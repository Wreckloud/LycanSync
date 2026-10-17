class VoiceVolumeBalanceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 1, automationRate: 'k-rate' },
      { name: 'audible', defaultValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.gain = 1;
    this.limiter = 1;
    this.speechPower = 0;
    this.measuredPower = 0;
    this.measuredFrames = 0;
    this.windowFrames = Math.round(sampleRate * 0.02);
    this.raiseRate = 1 - Math.exp(-1 / (sampleRate * 0.8));
    this.lowerRate = 1 - Math.exp(-1 / (sampleRate * 0.08));
    this.stopped = false;
    this.port.onmessage = ({ data }) => { if (data?.type === 'stop') this.stopped = true; };
  }

  process(inputs, outputs, parameters) {
    if (this.stopped) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    if (!input?.length || !parameters.audible[0]) {
      output.forEach((channel) => channel.fill(0));
      this.gain = 1;
      this.speechPower = 0;
      this.measuredFrames = 0;
      this.measuredPower = 0;
      this.limiter = 1;
      return true;
    }
    if (!parameters.enabled[0]) {
      output.forEach((channel, index) => channel.set(input[index] ?? input[0]));
      this.gain = 1;
      this.speechPower = 0;
      this.measuredFrames = 0;
      this.measuredPower = 0;
      this.limiter = 1;
      return true;
    }

    let peak = 0;
    let blockPower = 0;
    const frames = input[0].length;
    for (const channel of input) {
      let power = 0;
      for (let index = 0; index < frames; index++) {
        power += channel[index] * channel[index];
        peak = Math.max(peak, Math.abs(channel[index]));
      }
      // 多声道共用增益，安静的一侧不应让另一侧被额外放大。
      blockPower = Math.max(blockPower, power);
    }
    this.measuredPower += blockPower;
    this.measuredFrames += frames;
    if (this.measuredFrames >= this.windowFrames) {
      const power = this.measuredPower / this.measuredFrames;
      // 低于约 -44 dBFS 不追踪为讲话；静音和微弱底噪不会不断抬升增益。
      this.speechPower = power >= 0.00004
        ? (this.speechPower ? this.speechPower * 0.8 + power * 0.2 : power) : 0;
      this.measuredPower = 0;
      this.measuredFrames = 0;
    }
    // 讲话目标约 -20 dBFS RMS，最多补偿 ±12 dB；手动音量由 SDK 在此节点之后应用。
    const target = this.speechPower
      ? Math.max(0.25, Math.min(4, 0.1 / Math.sqrt(this.speechPower))) : 1;
    const rate = target < this.gain ? this.lowerRate : this.raiseRate;
    const ceiling = peak ? Math.min(1, 0.9 / (peak * Math.max(this.gain, target))) : 1;
    // 突然大声当块限峰，释放缓慢恢复；不缓存音频或等待前瞻帧。
    const release = 1 - Math.exp(-frames / (sampleRate * 0.1));
    this.limiter = Math.min(ceiling, this.limiter + (1 - this.limiter) * release);
    for (let index = 0; index < frames; index++) {
      this.gain += (target - this.gain) * rate;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][index] = (input[channel] ?? input[0])[index] * this.gain * this.limiter;
      }
    }
    return true;
  }
}

registerProcessor('lycan-voice-volume-balance', VoiceVolumeBalanceProcessor);

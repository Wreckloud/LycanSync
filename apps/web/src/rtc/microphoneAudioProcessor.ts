import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { normalizeAudioVolume } from './audioPreferences';

/** 在浏览器原生采集处理之后增加轻量的人声滤波、压缩和输入增益。 */
export class MicrophoneAudioProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'lycansync-microphone-audio';
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private highPass?: BiquadFilterNode;
  private compressor?: DynamicsCompressorNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private inputGain: number;
  private voiceEnhancement: boolean;

  constructor(inputGain: number, voiceEnhancement: boolean) {
    this.inputGain = normalizeAudioVolume(inputGain);
    this.voiceEnhancement = voiceEnhancement;
  }

  async init(options: AudioProcessorOptions) {
    this.build(options.track, options.audioContext);
  }

  async restart(options: AudioProcessorOptions) {
    const audioContext = options.audioContext ?? this.audioContext;
    if (!audioContext) throw new Error('麦克风处理器缺少 AudioContext');
    this.releaseNodes();
    this.processedTrack?.stop();
    this.build(options.track, audioContext);
  }

  async destroy() {
    this.releaseNodes();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.audioContext = undefined;
  }

  setInputGain(value: number) {
    this.inputGain = normalizeAudioVolume(value);
    if (this.gain && this.audioContext) {
      this.gain.gain.setValueAtTime(this.inputGain, this.audioContext.currentTime);
    }
  }

  setVoiceEnhancement(enabled: boolean) {
    if (this.voiceEnhancement === enabled) return;
    this.voiceEnhancement = enabled;
    this.connectNodes();
  }

  private build(track: MediaStreamTrack, audioContext: AudioContext) {
    this.audioContext = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.highPass = audioContext.createBiquadFilter();
    this.highPass.type = 'highpass';
    this.highPass.frequency.value = 80;
    this.highPass.Q.value = 0.7;
    this.compressor = audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;
    this.gain = audioContext.createGain();
    this.gain.gain.value = this.inputGain;
    this.destination = audioContext.createMediaStreamDestination();
    this.destination.channelCount = 1;
    this.destination.channelCountMode = 'explicit';
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.connectNodes();
  }

  private connectNodes() {
    if (!this.source || !this.highPass || !this.compressor || !this.gain || !this.destination) return;
    this.source.disconnect();
    this.highPass.disconnect();
    this.compressor.disconnect();
    this.gain.disconnect();
    if (this.voiceEnhancement) {
      this.source.connect(this.highPass);
      this.highPass.connect(this.gain);
      this.gain.connect(this.compressor);
      this.compressor.connect(this.destination);
    } else {
      this.source.connect(this.gain);
      this.gain.connect(this.destination);
    }
  }

  private releaseNodes() {
    this.source?.disconnect();
    this.highPass?.disconnect();
    this.compressor?.disconnect();
    this.gain?.disconnect();
    this.source = undefined;
    this.highPass = undefined;
    this.compressor = undefined;
    this.gain = undefined;
    this.destination = undefined;
  }
}

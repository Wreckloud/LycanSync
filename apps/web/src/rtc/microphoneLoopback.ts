interface MicrophoneLoopbackOptions {
  onStopped?: () => void;
  onError?: (error: Error) => void;
  createPeer?: () => RTCPeerConnection;
  createContext?: () => AudioContext;
}

/** Locally encode and decode the published microphone without another capture or RTC room. */
export class MicrophoneLoopback {
  private readonly controller = new AbortController();
  private sourceTrack?: MediaStreamTrack;
  private clonedTrack?: MediaStreamTrack;
  private receivedTrack?: MediaStreamTrack;
  private sender?: RTCPeerConnection;
  private receiver?: RTCPeerConnection;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private playbackElement?: HTMLAudioElement;
  private playbackReady?: Promise<void>;
  private stopped = false;
  private readonly sourceEnded = () => this.stop();

  constructor(private readonly options: MicrophoneLoopbackOptions = {}) {}

  async start(track: MediaStreamTrack, volume: number, maxBitrate: number, dtx: boolean) {
    if (this.sourceTrack) throw new Error('麦克风试听已启动。');
    if (this.stopped || track.readyState !== 'live') throw new Error('麦克风音轨已停止。');
    this.sourceTrack = track;
    track.addEventListener('ended', this.sourceEnded);
    const timer = setTimeout(() => {
      this.options.onError?.(new Error('麦克风试听连接超时，请重试。'));
      this.stop();
    }, 10_000);
    try {
      this.context = this.options.createContext?.() ?? new AudioContext({ sampleRate: 48000 });
      this.gain = this.context.createGain();
      this.setVolume(volume);
      this.gain.connect(this.context.destination);
      // Resume while handling the user's click, before SDP negotiation loses user activation.
      await this.context.resume();
      this.assertRunning();
      this.sender = this.options.createPeer?.() ?? new RTCPeerConnection({ iceServers: [] });
      this.receiver = this.options.createPeer?.() ?? new RTCPeerConnection({ iceServers: [] });
      for (const peer of [this.sender, this.receiver]) {
        peer.onconnectionstatechange = () => {
          if (!this.stopped && (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')) {
            this.options.onError?.(new Error('麦克风试听连接已中断，请重试。'));
            this.stop();
          }
        };
      }
      this.receiver.ontrack = ({ track: received }) => {
        if (this.stopped) { received.stop(); return; }
        this.receivedTrack = received;
        try {
          this.source = this.context!.createMediaStreamSource(new MediaStream([received]));
          this.source.connect(this.gain!);
          // Chromium needs an active media element to drive remote WebRTC audio playout.
          this.playbackElement = new Audio();
          this.playbackElement.muted = true;
          this.playbackElement.srcObject = new MediaStream([received]);
          this.playbackReady = this.playbackElement.play();
          void this.playbackReady.catch(() => {});
        } catch (error) {
          this.options.onError?.(error instanceof Error ? error : new Error('麦克风试听播放失败。'));
          this.stop();
        }
      };
      const connectionReady = this.waitForConnection(this.sender);
      // Negotiation may fail before we await connectionReady; always observe its rejection.
      void connectionReady.catch(() => {});
      this.clonedTrack = track.clone();
      const transceiver = this.sender.addTransceiver(this.clonedTrack, { direction: 'sendonly' });
      const opus = RTCRtpSender.getCapabilities('audio')?.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
      if (!opus?.length) throw new Error('当前客户端不支持 Opus 麦克风试听。');
      transceiver.setCodecPreferences(opus);
      await this.sender.setLocalDescription(await this.sender.createOffer());
      await this.waitForIce(this.sender);
      await this.receiver.setRemoteDescription(this.sender.localDescription!);
      const answer = await this.receiver.createAnswer();
      const opusPayload = answer.sdp?.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
      if (!opusPayload) throw new Error('麦克风试听未协商到 Opus。');
      answer.sdp = answer.sdp!.replace(new RegExp(`a=fmtp:${opusPayload} ([^\\r\\n]*)`), (_line, existing: string) => {
        const settings = existing.split(';').filter((setting) => !/^(maxaveragebitrate|usedtx|stereo)=/.test(setting.trim()));
        return `a=fmtp:${opusPayload} ${settings.join(';')};maxaveragebitrate=${maxBitrate};usedtx=${dtx ? 1 : 0};stereo=0`;
      });
      await this.receiver.setLocalDescription(answer);
      await this.waitForIce(this.receiver);
      await this.sender.setRemoteDescription(this.receiver.localDescription!);
      await connectionReady;
      this.assertRunning();
      if (!this.receivedTrack) throw new Error('麦克风试听未收到音轨。');
      await this.playbackReady;
      const parameters = transceiver.sender.getParameters();
      parameters.encodings[0].maxBitrate = maxBitrate;
      await transceiver.sender.setParameters(parameters);
      this.assertRunning();
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  setVolume(volume: number) {
    if (this.gain && this.context) this.gain.gain.setValueAtTime(volume, this.context.currentTime);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.sourceTrack?.removeEventListener('ended', this.sourceEnded);
    this.source?.disconnect();
    this.gain?.disconnect();
    if (this.playbackElement) {
      this.playbackElement.pause();
      this.playbackElement.srcObject = null;
    }
    if (this.sender) this.sender.onconnectionstatechange = null;
    if (this.receiver) { this.receiver.onconnectionstatechange = null; this.receiver.ontrack = null; }
    this.sender?.close();
    this.receiver?.close();
    this.clonedTrack?.stop();
    this.receivedTrack?.stop();
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch((error: Error) => this.options.onError?.(error));
    }
    this.options.onStopped?.();
  }

  private assertRunning() {
    if (this.stopped) throw new DOMException('麦克风试听已取消。', 'AbortError');
  }

  private waitForIce(peer: RTCPeerConnection) {
    return this.waitForState(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete');
  }

  private waitForConnection(peer: RTCPeerConnection) {
    return this.waitForState(peer, 'connectionstatechange', () => peer.connectionState === 'connected');
  }

  private waitForState(peer: RTCPeerConnection, event: string, complete: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        peer.removeEventListener(event, changed);
        this.controller.signal.removeEventListener('abort', aborted);
      };
      const aborted = () => { cleanup(); reject(new DOMException('麦克风试听已取消。', 'AbortError')); };
      const changed = () => {
        if (complete()) { cleanup(); resolve(); }
        else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          cleanup(); reject(new Error('麦克风试听连接已中断。'));
        }
      };
      peer.addEventListener(event, changed);
      this.controller.signal.addEventListener('abort', aborted, { once: true });
      if (this.controller.signal.aborted) aborted(); else changed();
    });
  }
}

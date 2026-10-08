import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { useRtcRoom } from './useRtcRoom';

const rtcMocks = vi.hoisted(() => ({
  token: vi.fn(),
  published: vi.fn(),
  unpublishing: vi.fn(),
  nativeStarts: vi.fn(),
  nativeStops: vi.fn(),
  nativeAudioStarts: vi.fn(),
  nativeAudioStops: vi.fn(),
  nativeAudioError: vi.fn(),
  selectedSources: vi.fn(),
  nativeError: vi.fn(),
}));

vi.mock('./tokenApi', () => ({
  requestRtcToken: rtcMocks.token,
  TokenRequestError: class TokenRequestError extends Error {},
}));

vi.mock('./microphoneAudioProcessor', () => ({
  MicrophoneAudioProcessor: class MicrophoneAudioProcessor {},
}));

vi.mock('./nativeScreenVideo', () => ({
  NativeScreenVideoSession: class NativeScreenVideoSession {
    track = { stop: vi.fn() };
    sessionId?: string;
    constructor(private readonly desktop: Window['lycanDesktop'], private readonly options: { maxFps: number; onError?: (code: string) => void }) {
      if (options.onError) rtcMocks.nativeError.mockImplementation(options.onError);
    }
    async start(sourceId: string) {
      const result = await this.desktop!.startNativeVideo(sourceId, this.options.maxFps);
      this.sessionId = result.sessionId;
      return this.track as never;
    }
    get captureSessionId() { return this.sessionId; }
    async stop() {
      if (this.sessionId) await this.desktop!.stopNativeVideo(this.sessionId);
    }
  },
}));

vi.mock('./nativeScreenAudio', () => ({
  NativeScreenAudioSession: class NativeScreenAudioSession {
    track = { stop: vi.fn() };
    private sessionId = '';
    constructor(private readonly desktop: Window['lycanDesktop'], options: { onError?: (code: string) => void }) {
      if (options.onError) {
        rtcMocks.nativeAudioError.mockImplementation(async (code: string) => {
          options.onError?.(code);
          await this.stop();
        });
      }
    }
    async start(sourceId: string, sessionId: string) {
      this.sessionId = sessionId;
      await this.desktop!.startNativeScreenAudio(sourceId, sessionId);
      return this.track as never;
    }
    async stop() { if (this.sessionId) await this.desktop!.stopNativeScreenAudio(this.sessionId); }
  },
}));

vi.mock('livekit-client', () => {
  const source = { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' };
  const events = {
    TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed', TrackMuted: 'trackMuted',
    TrackUnmuted: 'trackUnmuted', ParticipantAttributesChanged: 'participantAttributesChanged',
    AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged', ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected', TrackPublished: 'trackPublished',
    LocalTrackPublished: 'localTrackPublished', TrackUnpublished: 'trackUnpublished',
    LocalTrackUnpublished: 'localTrackUnpublished', ActiveSpeakersChanged: 'activeSpeakersChanged',
    ConnectionStateChanged: 'connectionStateChanged', Disconnected: 'disconnected',
  };
  class MockRoom {
    state = 'disconnected';
    canPlaybackAudio = true;
    remoteParticipants = new Map();
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    publications = new Map<string, { track: { stop: ReturnType<typeof vi.fn> }; source: string }>();
    localParticipant = {
      identity: 'local',
      trackPublications: this.publications,
      getTrackPublication: (trackSource: string) => this.publications.get(trackSource),
      createTracks: async () => [],
      setAttributes: async () => {},
      publishTrack: async (track: { stop: ReturnType<typeof vi.fn> }, options?: { source: string }) => {
        rtcMocks.published(track, options);
        const publication = { track, source: options?.source ?? source.Microphone };
        this.publications.set(publication.source, publication);
        this.emit(events.LocalTrackPublished, publication);
      },
      unpublishTrack: async (track: { stop: ReturnType<typeof vi.fn> }, stopTrack: boolean) => {
        rtcMocks.unpublishing(track, stopTrack);
        const entry = [...this.publications.entries()].find(([, publication]) => publication.track === track);
        if (entry) this.publications.delete(entry[0]);
        this.emit(events.LocalTrackUnpublished, { track, source: entry?.[1].source });
      },
    };
    on(event: string, callback: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
      return this;
    }
    emit(event: string, ...args: unknown[]) { this.handlers.get(event)?.forEach((callback) => callback(...args)); }
    registerByteStreamHandler() {}
    async connect() { this.state = 'connected'; this.emit(events.ConnectionStateChanged, 'connected'); }
    async disconnect() { this.state = 'disconnected'; }
    async startAudio() {}
    removeAllListeners() { this.handlers.clear(); }
  }
  class MockVideoPreset {
    resolution: { width: number; height: number };
    encoding: { maxBitrate: number; maxFramerate: number };
    constructor(width: number, height: number, bitrate: number, fps: number) {
      this.resolution = { width, height };
      this.encoding = { maxBitrate: bitrate, maxFramerate: fps };
    }
  }
  return {
    ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' },
    DisconnectReason: { DUPLICATE_IDENTITY: 'duplicateIdentity' },
    LocalAudioTrack: class LocalAudioTrack {},
    Room: MockRoom,
    RoomEvent: events,
    Track: { Source: source },
    VideoPreset: MockVideoPreset,
    supportsAV1: () => false,
  };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  vi.resetAllMocks();
});

describe('native screen share wiring', () => {
  it('publishes only after native start resolves, with ScreenShare source, then releases on stop and leave', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'native-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('group-1')).toBe(true);
      rtcMocks.published.mockImplementationOnce(() => {
        expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('monitor:1:0', 60);
      });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.published).toHaveBeenCalledOnce();
      expect(rtcMocks.published.mock.calls[0][1]).toMatchObject({ source: Track.Source.ScreenShare });
      expect(rtc.screenShareActive.value).toBe(true);

      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.unpublishing).toHaveBeenCalledWith(rtcMocks.published.mock.calls[0][0], true);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('native-session');
      expect(rtc.screenShareActive.value).toBe(false);
      expect(rtc.notice.value).toBe('');

      rtcMocks.nativeStarts.mockResolvedValueOnce({ sessionId: 'leave-session', changed: true });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await rtc.leave();
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('leave-session');
    } finally {
      scope.stop();
    }
  });

  it('shows a genuine running track write failure to the user', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'failed-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('group-3');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.nativeError('nativeVideoTrackWriteFailed');
      expect(rtc.notice.value).toContain('nativeVideoTrackWriteFailed');
      expect(rtcMocks.unpublishing).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('failed-session');
    } finally {
      scope.stop();
    }
  });

  it('silently releases a published screen track when its window closes', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'closed-window-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:1:0', shareAudio: false });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'window:1:0', kind: 'window', title: 'Game', width: 1280, height: 720, primary: false },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('group-window-close');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.nativeError('captureTargetClosed');
      expect(rtc.notice.value).toBe('');
      expect(rtcMocks.unpublishing).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('closed-window-session');
    } finally {
      scope.stop();
    }
  });

  it('publishes selected app audio as a separate ScreenShareAudio track and stops both tracks', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'native-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.nativeAudioStarts.mockResolvedValue({ sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10 });
    rtcMocks.nativeAudioStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:1:0', shareAudio: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({
          videoCapture: { available: true, reason: 'ready' },
          screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' },
        }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'window:1:0', kind: 'window', title: 'Game', width: 1280, height: 720, primary: false },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
        startNativeScreenAudio: rtcMocks.nativeAudioStarts,
        stopNativeScreenAudio: rtcMocks.nativeAudioStops,
        onNativeScreenAudioChunk: () => () => {},
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('group-audio');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledWith('window:1:0', 'native-session');
      expect(rtcMocks.published).toHaveBeenCalledTimes(2);
      expect(rtcMocks.published.mock.calls.map((call) => call[1]?.source)).toEqual([
        Track.Source.ScreenShare, Track.Source.ScreenShareAudio,
      ]);

      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledWith('native-session');
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('native-session');
    } finally {
      scope.stop();
    }
  });

  it('keeps screen video when process audio startup fails without retrying as system mix', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'native-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.nativeAudioStarts.mockRejectedValue(new Error('screenShareAudioUnsupported'));
    rtcMocks.nativeAudioStops.mockResolvedValue({ changed: false });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({
          videoCapture: { available: true, reason: 'ready' },
          screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' },
        }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
        startNativeScreenAudio: rtcMocks.nativeAudioStarts,
        stopNativeScreenAudio: rtcMocks.nativeAudioStops,
        onNativeScreenAudioChunk: () => () => {},
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('group-audio-fallback');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.published).toHaveBeenCalledOnce();
      expect(rtcMocks.published.mock.calls[0][1]?.source).toBe(Track.Source.ScreenShare);
      expect(rtc.notice.value).toContain('仅共享画面');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('reports a process-loopback window target failure without blaming the playback device', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'native-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.nativeAudioStarts.mockResolvedValue({ sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10 });
    rtcMocks.nativeAudioStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:1:0', shareAudio: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({
          videoCapture: { available: true, reason: 'ready' },
          screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' },
        }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'window:1:0', kind: 'window', title: 'Game', width: 1280, height: 720, primary: false },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
        startNativeScreenAudio: rtcMocks.nativeAudioStarts,
        stopNativeScreenAudio: rtcMocks.nativeAudioStops,
        onNativeScreenAudioChunk: () => () => {},
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('group-audio-target-error');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await rtcMocks.nativeAudioError('screenShareAudioTargetUnavailable');
      expect(rtc.notice.value).toContain('所选应用已关闭或声音目标不可用');
      expect(rtc.notice.value).not.toContain('默认播放设备');
      expect(rtcMocks.unpublishing).toHaveBeenCalledWith(rtcMocks.published.mock.calls[1][0], true);
      expect(rtcMocks.unpublishing.mock.calls[0][0]).not.toBe(rtcMocks.published.mock.calls[0][0]);
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledWith('native-session');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('does not silently fall back to Chromium when native capture is unavailable', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const screenTracks = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: false, reason: 'nativeVideoBridgeUnavailable' } }),
        listNativeVideoSources: vi.fn(),
        startNativeVideo: rtcMocks.nativeStarts,
        stopNativeVideo: rtcMocks.nativeStops,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
    }))!;
    try {
      await rtc.join('group-2');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.published).not.toHaveBeenCalled();
      expect(screenTracks).not.toHaveBeenCalled();
      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
      expect(rtc.notice.value).toBe('屏幕共享操作失败（nativeVideoBridgeUnavailable）。');
    } finally {
      scope.stop();
    }
  });
});

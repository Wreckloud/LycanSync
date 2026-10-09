import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAudioTrack, Track } from 'livekit-client';
import { useRtcRoom } from './useRtcRoom';

const rtcMocks = vi.hoisted(() => ({
  token: vi.fn(),
  attributesSet: vi.fn(),
  published: vi.fn(),
  unpublishing: vi.fn(),
  nativeStarts: vi.fn(),
  nativeStops: vi.fn(),
  nativeAudioStarts: vi.fn(),
  nativeAudioStops: vi.fn(),
  nativeAudioError: vi.fn(),
  microphoneStarted: vi.fn(),
  microphoneStopped: vi.fn(),
  microphoneConfigured: vi.fn(),
  microphoneInstances: [] as unknown[],
  browserTracks: [] as unknown[],
  createTracks: vi.fn(async () => rtcMocks.browserTracks.splice(0)),
  processors: [] as unknown[],
  nativeVideoInstances: [] as unknown[],
  nativeAudioInstances: [] as unknown[],
  nativeMicrophoneError: vi.fn(),
  selectedSources: vi.fn(),
  nativeError: vi.fn(),
  rooms: [] as unknown[],
}));

vi.mock('./tokenApi', () => ({
  requestRtcToken: rtcMocks.token,
  TokenRequestError: class TokenRequestError extends Error {},
}));

vi.mock('./microphoneAudioProcessor', () => ({
  MicrophoneAudioProcessor: class MicrophoneAudioProcessor {
    setInputGain = vi.fn((value: number) => { this.inputGain = value; });
    setVoiceEnhancement = vi.fn((value: boolean) => { this.voiceEnhancement = value; });
    constructor(inputGain: number, voiceEnhancement: boolean) {
      this.inputGain = inputGain;
      this.voiceEnhancement = voiceEnhancement;
      rtcMocks.processors.push(this);
    }
    inputGain: number;
    voiceEnhancement: boolean;
  },
}));

vi.mock('./nativeScreenVideo', () => ({
  NativeScreenVideoSession: class NativeScreenVideoSession {
    track = { stop: vi.fn() };
    sessionId?: string;
    private startPromise?: Promise<never>;
    private stopPromise?: Promise<void>;
    constructor(private readonly desktop: Window['lycanDesktop'], private readonly options: { maxFps: number; onError?: (code: string) => void }) {
      rtcMocks.nativeVideoInstances.push(this);
      if (options.onError) rtcMocks.nativeError.mockImplementation(options.onError);
    }
    start(sourceId: string) {
      if (!this.startPromise) {
        this.startPromise = this.desktop!.startNativeVideo(sourceId, this.options.maxFps).then((result) => {
          this.sessionId = result.sessionId;
          return this.track as never;
        });
      }
      return this.startPromise;
    }
    get captureSessionId() { return this.sessionId; }
    stop() {
      if (!this.stopPromise) {
        this.stopPromise = (async () => {
          await this.startPromise?.catch(() => {});
          if (this.sessionId) await this.desktop!.stopNativeVideo(this.sessionId);
        })();
      }
      return this.stopPromise;
    }
  },
}));

vi.mock('./nativeScreenAudio', () => ({
  NativeScreenAudioSession: class NativeScreenAudioSession {
    track = { stop: vi.fn() };
    private sessionId = '';
    private stopPromise?: Promise<void>;
    constructor(private readonly desktop: Window['lycanDesktop'], options: { onError?: (code: string) => void }) {
      rtcMocks.nativeAudioInstances.push(this);
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
    stop() {
      if (!this.stopPromise) {
        this.stopPromise = (async () => {
          if (this.sessionId) await this.desktop!.stopNativeScreenAudio(this.sessionId);
        })();
      }
      return this.stopPromise;
    }
  },
}));

vi.mock('./nativeMicrophoneAudio', () => ({
  NativeMicrophoneAudioSession: class NativeMicrophoneAudioSession {
    track = { stop: vi.fn() };
    private sessionId = '';
    constructor(private readonly desktop: Window['lycanDesktop'], options: { onError?: (code: string) => void }) {
      rtcMocks.microphoneInstances.push(this);
      if (options.onError) rtcMocks.nativeMicrophoneError.mockImplementation(options.onError);
    }
    async start(sessionId: string, settings: unknown) {
      this.sessionId = sessionId;
      await this.desktop!.startNativeMicrophone(sessionId, settings as never);
      return this.track as never;
    }
    configure(settings: unknown) {
      return this.desktop!.configureNativeMicrophone!(this.sessionId, settings as never);
    }
    async stop() {
      if (this.sessionId) await this.desktop!.stopNativeMicrophone(this.sessionId);
    }
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
    constructor() {
      rtcMocks.rooms.push(this);
    }
    state = 'disconnected';
    canPlaybackAudio = true;
    remoteParticipants = new Map();
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    publications = new Map<string, { track: { stop: ReturnType<typeof vi.fn> }; source: string }>();
    attributes: Array<Record<string, string>> = [];
    localParticipant = {
      identity: 'local',
      trackPublications: this.publications,
      getTrackPublication: (trackSource: string) => this.publications.get(trackSource),
      createTracks: () => rtcMocks.createTracks() as Promise<never[]>,
      setAttributes: async (attributes: Record<string, string>) => {
        this.attributes.push(attributes);
        await rtcMocks.attributesSet(this, attributes);
      },
      publishTrack: async (track: { stop: ReturnType<typeof vi.fn> }, options?: { source: string }) => {
        await rtcMocks.published(track, options);
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
  rtcMocks.rooms.length = 0;
  rtcMocks.microphoneInstances.length = 0;
  rtcMocks.browserTracks.length = 0;
  rtcMocks.createTracks.mockReset().mockImplementation(async () => rtcMocks.browserTracks.splice(0));
  rtcMocks.processors.length = 0;
  rtcMocks.nativeVideoInstances.length = 0;
  rtcMocks.nativeAudioInstances.length = 0;
  vi.resetAllMocks();
});

function mockRoom() {
  return rtcMocks.rooms.at(-1) as {
    remoteParticipants: Map<string, { identity: string; getTrackPublication: (source: string) => unknown }>;
    localParticipant: { getTrackPublication: (source: string) => unknown };
    emit: (event: string, ...args: unknown[]) => void;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function configureNativeMicrophoneDesktop() {
  rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
  rtcMocks.microphoneStarted.mockResolvedValue({
    sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10,
  });
  rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
  rtcMocks.microphoneConfigured.mockResolvedValue({ changed: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { lycanDesktop: {
      startNativeMicrophone: rtcMocks.microphoneStarted,
      configureNativeMicrophone: rtcMocks.microphoneConfigured,
      stopNativeMicrophone: rtcMocks.microphoneStopped,
    } },
  });
}

function browserMicrophoneTrack(
  applyConstraints: () => Promise<void>,
  settings: MediaTrackSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  setProcessor: () => Promise<void> = async () => {},
) {
  const mediaStreamTrack = { getSettings: () => settings };
  return Object.assign(Object.create(LocalAudioTrack.prototype), {
    mediaStreamTrack,
    applyConstraints,
    setProcessor: vi.fn(setProcessor),
    stop: vi.fn(),
  }) as LocalAudioTrack;
}

function configureNativeScreenDesktop(options: {
  capabilities?: Record<string, { available: boolean; reason: string }>;
  screenAudio?: boolean;
} = {}) {
  rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
  rtcMocks.microphoneStarted.mockResolvedValue({
    sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10,
  });
  rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
  rtcMocks.nativeStarts.mockImplementation(async (sourceId: string) => ({ sessionId: `${sourceId}-session`, changed: true }));
  rtcMocks.nativeStops.mockResolvedValue({ changed: true });
  rtcMocks.nativeAudioStarts.mockResolvedValue({
    sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10,
  });
  rtcMocks.nativeAudioStops.mockResolvedValue({ changed: true });
  rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:test:0', shareAudio: options.screenAudio ?? false });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { lycanDesktop: {
      getNativeMediaCapabilities: async () => options.capabilities ?? ({
        videoCapture: { available: true, reason: 'ready' },
        screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' },
      }),
      listNativeVideoSources: async () => ({ revision: 1, sources: [] }),
      startNativeVideo: rtcMocks.nativeStarts,
      stopNativeVideo: rtcMocks.nativeStops,
      startNativeScreenAudio: rtcMocks.nativeAudioStarts,
      stopNativeScreenAudio: rtcMocks.nativeAudioStops,
      onNativeScreenAudioChunk: () => () => {},
      startNativeMicrophone: rtcMocks.microphoneStarted,
      stopNativeMicrophone: rtcMocks.microphoneStopped,
    } },
  });
}

describe('native screen share wiring', () => {
  it('returns false when default microphone startup belongs to a room replaced before it finishes', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const delayedMicrophone = deferred<never[]>();
    rtcMocks.createTracks.mockImplementationOnce(() => delayedMicrophone.promise)
      .mockImplementationOnce(async () => []);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      const joiningA = rtc.join('join-room-a');
      await vi.waitFor(() => expect(rtcMocks.createTracks).toHaveBeenCalledOnce());
      const roomA = rtcMocks.rooms[0] as { attributes: Array<Record<string, string>> };

      await rtc.leave();
      expect(await rtc.join('join-room-b')).toBe(true);
      const roomB = rtcMocks.rooms[1] as { attributes: Array<Record<string, string>> };
      expect(roomB.attributes).toEqual([{ 'lycansync.listening': 'true' }]);

      delayedMicrophone.resolve([] as never[]);
      expect(await joiningA).toBe(false);
      expect(roomA.attributes).toEqual([]);
      expect(roomB.attributes).toEqual([{ 'lycansync.listening': 'true' }]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('returns false when leave happens while the room listening attribute is being synchronized', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const delayedListeningSync = deferred<void>();
    rtcMocks.attributesSet.mockImplementationOnce(() => delayedListeningSync.promise);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      const joiningA = rtc.join('sync-room-a');
      await vi.waitFor(() => expect(rtcMocks.attributesSet).toHaveBeenCalledOnce());
      const roomA = rtcMocks.rooms[0] as { attributes: Array<Record<string, string>> };

      await rtc.leave();
      expect(await rtc.join('sync-room-b')).toBe(true);
      const roomB = rtcMocks.rooms[1] as { attributes: Array<Record<string, string>> };
      delayedListeningSync.resolve(undefined);

      expect(await joiningA).toBe(false);
      expect(roomA.attributes).toEqual([{ 'lycansync.listening': 'true' }]);
      expect(roomB.attributes).toEqual([{ 'lycansync.listening': 'true' }]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('still joins when default microphone capture fails in the current connected room', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.createTracks.mockRejectedValueOnce(new Error('microphone permission denied'));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('microphone-failed-room')).toBe(true);
      expect(rtc.status.value).toBe('connected');
      expect(rtc.notice.value).toContain('麦克风操作失败');
      expect((rtcMocks.rooms[0] as { attributes: Array<Record<string, string>> }).attributes)
        .toEqual([{ 'lycansync.listening': 'true' }]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('reports an unconfirmed microphone stop without a misleading capture permission error', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({ sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10 });
    rtcMocks.microphoneStopped.mockRejectedValue(new Error('native stop failed'));
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        startNativeMicrophone: rtcMocks.microphoneStarted,
        configureNativeMicrophone: rtcMocks.microphoneConfigured,
        stopNativeMicrophone: rtcMocks.microphoneStopped,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('microphone-group')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.Microphone, false);
      expect(rtc.notice.value).toBe('麦克风停止未确认，请重新连接语音。');
      expect(rtc.busySources.value).toEqual([]);
    } finally {
      rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
      scope.stop();
    }
  });

  it.each(['gain', 'processing'] as const)('does not apply a failed %s request from room A to room B', async (setting) => {
    configureNativeMicrophoneDesktop();
    const delayed = deferred<{ changed: boolean }>();
    rtcMocks.microphoneConfigured.mockReturnValueOnce(delayed.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('room-a')).toBe(true);
      let update: Promise<void> | undefined;
      if (setting === 'gain') rtc.setMicrophoneInputGain(0.5);
      else update = rtc.setMicrophoneProcessing({
        echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceEnhancement: false,
      });

      const roomA = rtc.room.value;
      await rtc.leave();
      expect(await rtc.join('room-b')).toBe(true);
      expect(rtc.room.value).not.toBe(roomA);
      const roomBNotice = rtc.notice.value;

      delayed.reject(new Error('room A settings failed'));
      if (update) await update;
      else await Promise.resolve();
      expect(rtc.notice.value).toBe(roomBNotice);
    } finally {
      rtcMocks.microphoneConfigured.mockResolvedValue({ changed: true });
      await rtc.leave();
      scope.stop();
    }
  });

  it('ignores processing failure from an old microphone instance after reopening in the same room', async () => {
    configureNativeMicrophoneDesktop();
    const delayed = deferred<{ changed: boolean }>();
    rtcMocks.microphoneConfigured.mockReturnValueOnce(delayed.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('same-room')).toBe(true);
      const oldMicrophone = rtcMocks.microphoneInstances.at(-1);
      const update = rtc.setMicrophoneProcessing({
        echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceEnhancement: false,
      });
      await rtc.toggleMedia(Track.Source.Microphone);
      await rtc.toggleMedia(Track.Source.Microphone);
      expect(rtcMocks.microphoneInstances.at(-1)).not.toBe(oldMicrophone);

      delayed.reject(new Error('old microphone settings failed'));
      await update;
      expect(rtc.notice.value).toBe('');
    } finally {
      rtcMocks.microphoneConfigured.mockResolvedValue({ changed: true });
      await rtc.leave();
      scope.stop();
    }
  });

  it.each(['gain', 'processing'] as const)('still reports a current %s request failure', async (setting) => {
    configureNativeMicrophoneDesktop();
    rtcMocks.microphoneConfigured.mockRejectedValue(new Error('current settings failed'));
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('current-room')).toBe(true);
      if (setting === 'gain') {
        rtc.setMicrophoneInputGain(0.5);
        await Promise.resolve();
      } else {
        await rtc.setMicrophoneProcessing({
          echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceEnhancement: false,
        });
      }
      expect(rtc.notice.value).toBe('麦克风设置未能应用。');
    } finally {
      rtcMocks.microphoneConfigured.mockResolvedValue({ changed: true });
      await rtc.leave();
      scope.stop();
    }
  });

  it.each(['resolved', 'rejected'] as const)('does not let an old browser audio track %s result change the new room notice', async (result) => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const delayed = deferred<void>();
    rtcMocks.browserTracks.push(browserMicrophoneTrack(() => delayed.promise));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('browser-room-a')).toBe(true);
      const update = rtc.setMicrophoneProcessing({
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true,
      });
      await rtc.leave();
      rtcMocks.browserTracks.push(browserMicrophoneTrack(async () => {}));
      expect(await rtc.join('browser-room-b')).toBe(true);
      rtc.notice.value = '新房间当前提示';

      if (result === 'resolved') delayed.resolve(undefined);
      else delayed.reject(new Error('old browser constraints failed'));
      await update;
      expect(rtc.notice.value).toBe('新房间当前提示');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('uses the desktop native microphone and publishes it as the microphone source', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({ sampleRate: 48000, channels: 1, bitsPerSample: 32, nominalChunkMs: 10 });
    rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
    rtcMocks.microphoneConfigured.mockResolvedValue({ changed: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        startNativeMicrophone: rtcMocks.microphoneStarted,
        configureNativeMicrophone: rtcMocks.microphoneConfigured,
        stopNativeMicrophone: rtcMocks.microphoneStopped,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 0.8,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
    }))!;
    try {
      expect(await rtc.join('microphone-group')).toBe(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      expect(rtcMocks.microphoneStarted.mock.calls[0][1]).toEqual({
        inputGain: 0.8, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true,
      });
      expect(rtcMocks.published).toHaveBeenCalledWith(expect.anything(), { source: Track.Source.Microphone });
      rtc.setMicrophoneInputGain(0.5);
      expect(rtcMocks.microphoneConfigured).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ inputGain: 0.5 }));
      await rtc.toggleMedia(Track.Source.Microphone);
      expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce();
    } finally {
      scope.stop();
    }
  });

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
      await vi.waitFor(() => expect(rtcMocks.nativeStops).toHaveBeenCalledWith('failed-session'));
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
      await vi.waitFor(() => expect(rtcMocks.nativeStops).toHaveBeenCalledWith('closed-window-session'));
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

  it('keeps the new browser microphone processor when an old createTracks request resolves late', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const delayedTracks = deferred<never[]>();
    const roomBTrack = browserMicrophoneTrack(async () => {});
    rtcMocks.createTracks.mockImplementationOnce(async () => [])
      .mockImplementationOnce(() => delayedTracks.promise)
      .mockImplementationOnce(async () => [roomBTrack]);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('browser-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.Microphone, true);
      await rtc.leave();
      expect(await rtc.join('browser-b')).toBe(true);
      const processorB = rtcMocks.processors.at(-1) as {
        setInputGain: ReturnType<typeof vi.fn>;
        setVoiceEnhancement: ReturnType<typeof vi.fn>;
      };

      const lateTrack = browserMicrophoneTrack(async () => {});
      delayedTracks.resolve([lateTrack] as never[]);
      await oldTask;
      rtc.setMicrophoneInputGain(0.4);
      await rtc.setMicrophoneProcessing({
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false,
      });

      expect(lateTrack.stop).toHaveBeenCalledOnce();
      expect(lateTrack.setProcessor).not.toHaveBeenCalled();
      expect(processorB.setInputGain).toHaveBeenLastCalledWith(0.4);
      expect(processorB.setVoiceEnhancement).toHaveBeenLastCalledWith(false);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('releases a browser track when its processor attachment resolves after leaving', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    const delayedProcessor = deferred<void>();
    const roomATrack = browserMicrophoneTrack(async () => {}, undefined, () => delayedProcessor.promise);
    const roomBTrack = browserMicrophoneTrack(async () => {});
    rtcMocks.createTracks.mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [roomATrack])
      .mockImplementationOnce(async () => [roomBTrack]);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('processor-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.Microphone, true);
      await vi.waitFor(() => expect(roomATrack.setProcessor).toHaveBeenCalledOnce());
      await rtc.leave();
      expect(await rtc.join('processor-b')).toBe(true);
      const processorB = rtcMocks.processors.at(-1);

      delayedProcessor.resolve(undefined);
      await oldTask;
      expect(roomATrack.stop).toHaveBeenCalledOnce();
      expect(rtcMocks.processors.at(-1)).toBe(processorB);
      rtc.setMicrophoneInputGain(0.6);
      expect((processorB as { setInputGain: ReturnType<typeof vi.fn> }).setInputGain).toHaveBeenLastCalledWith(0.6);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('does not start a selected native source after its room has been left', async () => {
    configureNativeScreenDesktop();
    const delayedSelection = deferred<{ sourceId: string; shareAudio: boolean } | null>();
    rtcMocks.selectedSources.mockImplementationOnce(() => delayedSelection.promise)
      .mockResolvedValueOnce({ sourceId: 'window:room-b:0', shareAudio: false });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('selector-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.selectedSources).toHaveBeenCalledOnce());
      await rtc.leave();
      expect(await rtc.join('selector-b')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const roomB = mockRoom();
      const roomBVideo = rtcMocks.nativeVideoInstances.at(-1) as { track: { stop: ReturnType<typeof vi.fn> } };

      delayedSelection.resolve({ sourceId: 'window:room-a:0', shareAudio: false });
      await oldTask;

      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:room-b:0', 60);
      expect(rtc.screenShareActive.value).toBe(true);
      expect(roomB.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();
      expect(roomBVideo.track.stop).not.toHaveBeenCalled();
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('keeps an explicit current-room source cancellation silent', async () => {
    configureNativeScreenDesktop();
    const delayedSelection = deferred<{ sourceId: string; shareAudio: boolean } | null>();
    rtcMocks.selectedSources.mockReturnValueOnce(delayedSelection.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('cancel-current')).toBe(true);
      const task = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.selectedSources).toHaveBeenCalledOnce());
      rtc.cancelPendingScreenShareSelection();
      delayedSelection.resolve({ sourceId: 'window:cancelled:0', shareAudio: false });
      await task;

      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
      expect(rtcMocks.published.mock.calls.some(([, options]) => options?.source === Track.Source.ScreenShare)).toBe(false);
      expect(rtc.notice.value).toBe('');
      expect(rtc.busySources.value).toEqual([]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('cleans a native video start that resolves after leave without stopping the next room share', async () => {
    configureNativeScreenDesktop();
    const delayedStart = deferred<{ sessionId: string; changed: boolean }>();
    rtcMocks.nativeStarts.mockImplementationOnce(() => delayedStart.promise)
      .mockImplementation(async (sourceId: string) => ({ sessionId: `${sourceId}-session`, changed: true }));
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:room-a:0', shareAudio: false });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('capture-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce());
      const oldVideo = rtcMocks.nativeVideoInstances.at(-1) as { track: { stop: ReturnType<typeof vi.fn> } };
      const leaving = rtc.leave();
      await vi.waitFor(() => expect(rtc.status.value).toBe('idle'));
      expect(await rtc.join('capture-b')).toBe(true);
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:room-b:0', shareAudio: false });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const newVideo = rtcMocks.nativeVideoInstances.at(-1) as { track: { stop: ReturnType<typeof vi.fn> } };

      delayedStart.resolve({ sessionId: 'old-native-session', changed: true });
      await oldTask;
      await leaving;
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('old-native-session');
      expect(oldVideo.track.stop).toHaveBeenCalledOnce();
      expect(newVideo.track.stop).not.toHaveBeenCalled();
      expect(rtc.screenShareActive.value).toBe(true);

      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('window:room-b:0-session');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('does not let an old pending publication register or clear the new room share', async () => {
    configureNativeScreenDesktop();
    const delayedPublish = deferred<void>();
    let delayFirstScreenShare = true;
    rtcMocks.published.mockImplementation((_track, options) => {
      if (delayFirstScreenShare && options?.source === Track.Source.ScreenShare) {
        delayFirstScreenShare = false;
        return delayedPublish.promise;
      }
    });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:room-a:0', shareAudio: false });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('publish-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.published.mock.calls.some(([, options]) =>
        options?.source === Track.Source.ScreenShare)).toBe(true));
      const oldTrack = rtcMocks.published.mock.calls.find(([, options]) =>
        options?.source === Track.Source.ScreenShare)![0] as { stop: ReturnType<typeof vi.fn> };
      await rtc.leave();
      expect(await rtc.join('publish-b')).toBe(true);
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:room-b:0', shareAudio: false });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);

      delayedPublish.resolve(undefined);
      await oldTask;
      expect(rtc.screenShareActive.value).toBe(true);
      expect(rtcMocks.unpublishing).toHaveBeenCalledWith(oldTrack, true);
      expect(oldTrack.stop).toHaveBeenCalledOnce();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('does not let a failed old screen-audio startup replace the new room notice', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    const delayedAudioStart = deferred<{ sampleRate: number; channels: 2; bitsPerSample: 32; nominalChunkMs: 10 }>();
    rtcMocks.nativeAudioStarts.mockImplementationOnce(() => delayedAudioStart.promise);
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:room-a:0', shareAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('audio-a')).toBe(true);
      const oldTask = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce());
      await rtc.leave();
      expect(await rtc.join('audio-b')).toBe(true);
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:room-b:0', shareAudio: true });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtc.notice.value = '新房间现有提示';
      const roomBAudio = rtcMocks.nativeAudioInstances.at(-1);

      delayedAudioStart.reject(new Error('screenShareAudioTargetUnavailable'));
      await oldTask;

      expect(rtc.notice.value).toBe('新房间现有提示');
      expect(rtcMocks.nativeAudioInstances.at(-1)).toBe(roomBAudio);
      expect(rtc.screenShareActive.value).toBe(true);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });
});

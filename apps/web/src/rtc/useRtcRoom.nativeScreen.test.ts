import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAudioTrack, Track } from 'livekit-client';
import { useRtcRoom } from './useRtcRoom';
import { encodeRemoteControlMessage, REMOTE_CONTROL_TOPIC, type RemoteControlMessage } from './remoteControl';

const rtcMocks = vi.hoisted(() => ({
  token: vi.fn(),
  attributesSet: vi.fn(),
  published: vi.fn(),
  unpublishing: vi.fn(),
  nativeStarts: vi.fn(),
  nativeConfigured: vi.fn(),
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
  publishData: vi.fn(),
  rooms: [] as unknown[],
  initialRemoteParticipants: [] as unknown[],
  sentPackets: [] as Array<{ payload: Uint8Array; options: { reliable?: boolean; destinationIdentities?: string[]; topic?: string } }>,
  subscriptionPermissions: [] as Array<{ room: unknown; allowAll: boolean; permissions: unknown[] }>,
  subscriptionLifecycle: [] as Array<{ room: unknown; event: 'permissions' | 'connect' }>,
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
        this.startPromise = this.desktop!.startNativeVideo(sourceId, this.options.maxFps, { hideCursor: false, hideBorder: false }).then((result) => {
          this.sessionId = result.sessionId;
          return this.track as never;
        });
      }
      return this.startPromise;
    }
    get captureSessionId() { return this.sessionId; }
    configureQuality(id: string) { return rtcMocks.nativeConfigured(id); }
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
    track = { stop: vi.fn(), mute: vi.fn(async () => {}), mediaStreamTrack: { enabled: true }, sender: { track: { enabled: true } } };
    private sessionId = '';
    private starting?: Promise<unknown>;
    private stopping?: Promise<void>;
    constructor(private readonly desktop: Window['lycanDesktop'], options: { onError?: (code: string) => void }) {
      rtcMocks.microphoneInstances.push(this);
      if (options.onError) rtcMocks.nativeMicrophoneError.mockImplementation(options.onError);
    }
    async start(sessionId: string, settings: unknown) {
      this.sessionId = sessionId;
      this.starting = this.desktop!.startNativeMicrophone(sessionId, settings as never);
      await this.starting;
      return this.track as never;
    }
    configure(settings: unknown) {
      return this.desktop!.configureNativeMicrophone!(this.sessionId, settings as never);
    }
    stop() {
      this.stopping ??= (async () => {
        try { await this.starting; } catch { return; }
        if (this.sessionId) await this.desktop!.stopNativeMicrophone(this.sessionId);
      })();
      return this.stopping;
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
    ConnectionStateChanged: 'connectionStateChanged', Disconnected: 'disconnected', DataReceived: 'dataReceived',
  };
  class MockRoom {
    constructor() {
      rtcMocks.rooms.push(this);
      for (const participant of rtcMocks.initialRemoteParticipants as Array<{ identity: string }>) {
        this.remoteParticipants.set(participant.identity, participant);
      }
    }
    state = 'disconnected';
    publicationSequence = 0;
    canPlaybackAudio = true;
    remoteParticipants = new Map();
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    publications = new Map<string, { trackSid: string; track: { stop: ReturnType<typeof vi.fn> }; source: string }>();
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
        const publication = { trackSid: `track-${++this.publicationSequence}`, track, source: options?.source ?? source.Microphone };
        this.publications.set(publication.source, publication);
        this.emit(events.LocalTrackPublished, publication);
        return publication;
      },
      setTrackSubscriptionPermissions: (allowAll: boolean, permissions: unknown[]) => {
        rtcMocks.subscriptionPermissions.push({ room: this, allowAll, permissions });
        rtcMocks.subscriptionLifecycle.push({ room: this, event: 'permissions' });
      },
      publishData: async (payload: Uint8Array, options: { reliable?: boolean; destinationIdentities?: string[]; topic?: string }) => {
        rtcMocks.sentPackets.push({ payload, options });
        await rtcMocks.publishData(payload, options);
      },
      unpublishTrack: async (track: { stop: () => void }, stopTrack: boolean) => {
        if (stopTrack && [...this.publications.values()].some((publication) =>
          publication.source === source.Microphone && publication.track === track)) track.stop();
        await rtcMocks.unpublishing(track, stopTrack);
        const entry = [...this.publications.entries()].find(([, publication]) => publication.track === track);
        if (entry) this.publications.delete(entry[0]);
        this.emit(events.LocalTrackUnpublished, { track, trackSid: entry?.[1].trackSid, source: entry?.[1].source });
      },
    };
    on(event: string, callback: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
      return this;
    }
    emit(event: string, ...args: unknown[]) { this.handlers.get(event)?.forEach((callback) => callback(...args)); }
    registerByteStreamHandler() {}
    async connect() {
      rtcMocks.subscriptionLifecycle.push({ room: this, event: 'connect' });
      this.state = 'connected';
      this.emit(events.ConnectionStateChanged, 'connected');
    }
    async disconnect() { this.state = 'disconnected'; }
    async startAudio() {}
    removeAllListeners() { this.handlers.clear(); }
  }
  class MockVideoPreset {
    get width() { return this.resolution.width; }
    get height() { return this.resolution.height; }
    resolution: { width: number; height: number };
    encoding: { maxBitrate: number; maxFramerate: number };
    constructor(width: number, height: number, bitrate: number, fps: number) {
      this.resolution = { width, height };
      this.encoding = { maxBitrate: bitrate, maxFramerate: fps };
    }
  }
  return {
    ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' },
    DisconnectReason: { DUPLICATE_IDENTITY: 'duplicateIdentity', PARTICIPANT_REMOVED: 'participantRemoved' },
    LocalAudioTrack: class LocalAudioTrack {},
    Room: MockRoom,
    RoomEvent: events,
    Track: { Source: source },
    VideoPreset: MockVideoPreset,
  };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  rtcMocks.rooms.length = 0;
  rtcMocks.initialRemoteParticipants.length = 0;
  rtcMocks.sentPackets.length = 0;
  rtcMocks.subscriptionPermissions.length = 0;
  rtcMocks.subscriptionLifecycle.length = 0;
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

function addRemoteParticipant(identity: string, withScreenShare = false) {
  const publications = new Map<string, unknown>();
  if (withScreenShare) publications.set(Track.Source.ScreenShare, { source: Track.Source.ScreenShare });
  const participant = { identity, name: identity, getTrackPublication: (source: string) => publications.get(source) };
  rtcMocks.initialRemoteParticipants.push(participant);
  const room = rtcMocks.rooms.at(-1) as { remoteParticipants: Map<string, { identity: string }> } | undefined;
  room?.remoteParticipants.set(identity, participant);
  return participant;
}

function receiveRemoteControl(identity: string, message: RemoteControlMessage) {
  mockRoom().emit('dataReceived', encodeRemoteControlMessage(message), { identity }, 'reliable', REMOTE_CONTROL_TOPIC);
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
  const mediaStreamTrack = { getSettings: () => settings, enabled: true };
  return Object.assign(Object.create(LocalAudioTrack.prototype), {
    mediaStreamTrack,
    getSourceTrackSettings: () => settings,
    applyConstraints,
    setProcessor: vi.fn(setProcessor),
    mute: vi.fn(async () => {}),
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
  it('checks capture settings on the original browser microphone rather than processed output', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const track = browserMicrophoneTrack(async () => {});
    Object.defineProperty(track, 'mediaStreamTrack', { configurable: true,
      value: { getSettings: () => ({}) },
    });
    rtcMocks.browserTracks.push(track);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('microphone-source-settings')).toBe(true);
      await rtc.setMicrophoneProcessing({ echoCancellation: true, noiseSuppression: true,
        autoGainControl: true, voiceEnhancement: true });
      expect(rtc.notice.value).toBe('部分音频处理设置需要重新开麦后生效。');
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('waits for standalone microphone test cleanup before requesting a room token or capturing', async () => {
    configureNativeMicrophoneDesktop();
    const stopped = deferred<void>();
    const beforeMicrophoneChange = vi.fn().mockReturnValueOnce(stopped.promise).mockResolvedValue(undefined);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
      events: { beforeMicrophoneChange },
    }))!;
    try {
      const joining = rtc.join('test-microphone');
      expect(rtc.status.value).toBe('joining');
      expect(rtcMocks.token).not.toHaveBeenCalled();
      expect(rtcMocks.microphoneStarted).not.toHaveBeenCalled();
      stopped.resolve();
      expect(await joining).toBe(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      expect(beforeMicrophoneChange).toHaveBeenCalledTimes(2);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('does not enter a room if the join was cancelled while waiting for test cleanup', async () => {
    configureNativeMicrophoneDesktop();
    const stopped = deferred<void>();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
      events: { beforeMicrophoneChange: () => stopped.promise },
    }))!;
    const joining = rtc.join('test-microphone');
    await rtc.leave();
    stopped.resolve();
    expect(await joining).toBe(false);
    expect(rtcMocks.token).not.toHaveBeenCalled();
    expect(rtc.status.value).toBe('idle');
    scope.stop();
  });

  it('reports unconfirmed test cleanup and does not enter a room', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
      events: { beforeMicrophoneChange: async () => { throw new Error('test stop failed'); } },
    }))!;
    expect(await rtc.join('test-microphone')).toBe(false);
    expect(rtcMocks.token).not.toHaveBeenCalled();
    expect(rtc.status.value).toBe('idle');
    expect(rtc.notice.value).toContain('试听停止未确认');
    scope.stop();
  });

  it('disables sending before awaiting audition cleanup, then releases the published microphone', async () => {
    configureNativeMicrophoneDesktop();
    const beforeMicrophoneChange = vi.fn().mockResolvedValue(undefined);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
      events: { beforeMicrophoneChange },
    }))!;
    try {
      expect(await rtc.join('test-microphone')).toBe(true);
      const stopped = deferred<void>();
      beforeMicrophoneChange.mockReturnValueOnce(stopped.promise);
      const changing = rtc.setMediaEnabled(Track.Source.Microphone, false);
      const track = rtc.room.value!.localParticipant.getTrackPublication(Track.Source.Microphone)!.track!;
      expect(track.mediaStreamTrack.enabled).toBe(false);
      expect(track.sender!.track!.enabled).toBe(false);
      expect(track.mute).toHaveBeenCalled();
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtc.microphoneIntent.value).toBe(false);
      expect(rtcMocks.unpublishing).not.toHaveBeenCalled();
      expect(rtcMocks.microphoneStopped).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce());
      expect(rtcMocks.unpublishing).not.toHaveBeenCalled();
      stopped.resolve();
      await changing;
      expect(rtcMocks.unpublishing).toHaveBeenCalledOnce();
      expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce();
      beforeMicrophoneChange.mockRejectedValueOnce(new Error('test stop failed'));
      await rtc.setMediaEnabled(Track.Source.Microphone, true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      expect(rtc.notice.value).toContain('试听停止未确认');
      expect(rtc.busySources.value).toEqual([]);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('still turns off the published microphone if optional audition cleanup fails', async () => {
    configureNativeMicrophoneDesktop();
    const beforeMicrophoneChange = vi.fn().mockResolvedValue(undefined);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true },
      events: { beforeMicrophoneChange },
    }))!;
    try {
      expect(await rtc.join('test-microphone')).toBe(true);
      beforeMicrophoneChange.mockRejectedValueOnce(new Error('test stop failed'));
      await rtc.setMediaEnabled(Track.Source.Microphone, false);
      expect(rtcMocks.unpublishing).toHaveBeenCalledOnce();
      expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce();
      expect(rtc.notice.value).toContain('试听停止未确认');
    } finally { await rtc.leave(); scope.stop(); }
  });
  it.each([true, false])('停止收听后恢复只沿用此前开麦意愿：%s', async (intent) => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('listening-intent')).toBe(true);
      if (!intent) await rtc.setMediaEnabled(Track.Source.Microphone, false);
      await rtc.updateListeningState(false);
      expect(rtc.listening.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtc.microphoneIntent.value).toBe(intent);
      await rtc.updateListeningState(true);
      expect(rtc.listening.value).toBe(true);
      expect(rtc.microphoneEnabled.value).toBe(intent);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(intent ? 2 : 1);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('停止及状态同步未完成时，实际 sender 和图标状态已关闭，原生采集不等待网络', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('pending-stop');
      const track = rtc.room.value!.localParticipant.getTrackPublication(Track.Source.Microphone)!.track!;
      const stop = deferred<void>();
      const unpublish = deferred<void>();
      const attributes = deferred<void>();
      rtcMocks.microphoneStopped.mockReturnValueOnce(stop.promise);
      rtcMocks.unpublishing.mockReturnValueOnce(unpublish.promise);
      rtcMocks.attributesSet.mockReturnValueOnce(attributes.promise);
      const stopping = rtc.updateListeningState(false);
      expect(rtc.listening.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtc.microphoneIntent.value).toBe(true);
      expect(track.mediaStreamTrack.enabled).toBe(false);
      expect(track.sender!.track!.enabled).toBe(false);
      await vi.waitFor(() => expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce());
      expect(rtc.busySources.value).toContain(Track.Source.Microphone);
      stop.resolve(); unpublish.resolve(); attributes.resolve();
      await stopping;
      expect(rtc.busySources.value).toEqual([]);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it.each(['unpublish', 'native', 'mute'] as const)('停止 %s 失败仍禁发，恢复不会另建采集', async (failure) => {
    configureNativeMicrophoneDesktop();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('failed-stop');
      const track = rtc.room.value!.localParticipant.getTrackPublication(Track.Source.Microphone)!.track!;
      if (failure === 'mute') vi.mocked(track.mute).mockRejectedValueOnce(new Error('mute failed'));
      else (failure === 'native' ? rtcMocks.microphoneStopped : rtcMocks.unpublishing)
        .mockRejectedValueOnce(new Error('stop failed'));
      await rtc.updateListeningState(false);
      expect(rtc.notice.value).toContain('停止未确认');
      expect(track.mediaStreamTrack.enabled).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce();
      await rtc.updateListeningState(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtc.notice.value).toContain('停止未确认');
    } finally { await rtc.leave(); scope.stop(); log.mockRestore(); }
  });

  it('恢复启动失败保留意愿，但不能显示成功开麦；明确开麦可重试', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('failed-restore');
      await rtc.updateListeningState(false);
      rtcMocks.microphoneStarted.mockRejectedValueOnce(new Error('audioDeviceUnavailable'));
      await rtc.updateListeningState(true);
      expect(rtc.microphoneIntent.value).toBe(true);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtc.notice.value).toContain('麦克风不可用');
      await rtc.toggleMedia(Track.Source.Microphone);
      expect(rtc.microphoneEnabled.value).toBe(true);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('连续停止、恢复、停止收敛到最后意愿，旧停止不会触发开麦', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('rapid-listening');
      const delayed = deferred<void>();
      rtcMocks.microphoneStopped.mockReturnValueOnce(delayed.promise);
      const first = rtc.updateListeningState(false);
      const second = rtc.updateListeningState(true);
      const third = rtc.updateListeningState(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      delayed.resolve();
      await Promise.all([first, second, third]);
      expect(rtc.listening.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
    } finally { await rtc.leave(); scope.stop(); }
  });

  it.each(['capture', 'publish'] as const)('启动 %s 中停止，迟到音轨始终禁发且被清理', async (stage) => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('cancel-start');
      await rtc.setMediaEnabled(Track.Source.Microphone, false);
      const delayed = deferred<unknown>();
      (stage === 'capture' ? rtcMocks.microphoneStarted : rtcMocks.published).mockReturnValueOnce(delayed.promise);
      const opening = rtc.setMediaEnabled(Track.Source.Microphone, true);
      await vi.waitFor(() => expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(2));
      if (stage === 'publish') await vi.waitFor(() => expect(rtcMocks.published).toHaveBeenCalledTimes(2));
      const closing = rtc.updateListeningState(false);
      const track = (rtcMocks.microphoneInstances.at(-1) as { track: { mediaStreamTrack: { enabled: boolean }; stop: ReturnType<typeof vi.fn> } }).track;
      expect(rtc.microphoneEnabled.value).toBe(false);
      if (stage === 'publish') expect(track.mediaStreamTrack.enabled).toBe(false);
      delayed.resolve(undefined);
      await Promise.all([opening, closing]);
      expect(track.mediaStreamTrack.enabled).toBe(false);
      expect(track.stop).toHaveBeenCalled();
      expect(rtc.room.value!.localParticipant.getTrackPublication(Track.Source.Microphone)).toBeUndefined();
      expect(rtc.microphoneEnabled.value).toBe(false);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('重连不会恢复停听后的发送资格，也不重建麦克风', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('reconnect-listening');
      await rtc.updateListeningState(false);
      const room = rtcMocks.rooms.at(-1) as { emit: (event: string, ...args: unknown[]) => void };
      room.emit('connectionStateChanged', 'reconnecting');
      room.emit('connectionStateChanged', 'connected');
      expect(rtc.listening.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('旧房间停止迟到时不执行排队恢复，也不改变新房间关麦意愿', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('old-listening-room');
      const delayed = deferred<void>();
      rtcMocks.microphoneStopped.mockReturnValueOnce(delayed.promise);
      const stopping = rtc.updateListeningState(false);
      await vi.waitFor(() => expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce());
      const restoring = rtc.updateListeningState(true);
      await rtc.leave();
      expect(await rtc.join('new-listening-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.Microphone, false);
      delayed.resolve();
      await Promise.all([stopping, restoring]);
      expect(rtc.microphoneIntent.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(2);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('允许发送的已有麦克风在普通重连时继续使用，不重新采集', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('allowed-reconnect');
      const room = rtcMocks.rooms.at(-1) as { emit: (event: string, ...args: unknown[]) => void };
      room.emit('connectionStateChanged', 'reconnecting');
      room.emit('connectionStateChanged', 'connected');
      expect(rtc.microphoneEnabled.value).toBe(true);
      expect(rtc.microphoneIntent.value).toBe(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      expect(rtcMocks.microphoneStopped).not.toHaveBeenCalled();
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('SDK 静音确认迟到时保持禁发，恢复必须等清理确认', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('mute-ack');
      const track = (rtcMocks.microphoneInstances.at(-1) as {
        track: { mute: ReturnType<typeof vi.fn>; mediaStreamTrack: { enabled: boolean } } }).track;
      const muted = deferred<void>();
      track.mute.mockReturnValueOnce(muted.promise);
      const stopping = rtc.updateListeningState(false);
      const restoring = rtc.updateListeningState(true);
      await vi.waitFor(() => expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce());
      expect(rtc.microphoneEnabled.value).toBe(false);
      expect(track.mediaStreamTrack.enabled).toBe(false);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledOnce();
      muted.resolve();
      await Promise.all([stopping, restoring]);
      expect(rtc.microphoneEnabled.value).toBe(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(2);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('浏览器处理前输入、处理后输出及发布中的 sender 在停听时都禁发', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const track = browserMicrophoneTrack(async () => {});
    const raw = track.mediaStreamTrack;
    const processed = { enabled: true };
    const senderTrack = { enabled: true };
    track.setProcessor = vi.fn(async () => {
      Object.defineProperty(track, 'mediaStreamTrack', { configurable: true, value: processed });
      Object.defineProperty(track, 'sender', { value: { track: senderTrack } });
    });
    rtcMocks.browserTracks.push(track);
    const publish = deferred<void>();
    rtcMocks.published.mockReturnValueOnce(publish.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      const joining = rtc.join('browser-gate');
      await vi.waitFor(() => expect(rtcMocks.published).toHaveBeenCalledOnce());
      expect(raw.enabled).toBe(false);
      expect(processed.enabled).toBe(false);
      const stopping = rtc.updateListeningState(false);
      expect(raw.enabled).toBe(false);
      expect(processed.enabled).toBe(false);
      expect(senderTrack.enabled).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
      publish.resolve();
      await Promise.all([joining, stopping]);
      expect(track.stop).toHaveBeenCalled();
      expect(rtc.listening.value).toBe(false);
      expect(rtc.microphoneEnabled.value).toBe(false);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('启动中重复请求开麦复用任务，不取消后再采集', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('duplicate-open');
      await rtc.setMediaEnabled(Track.Source.Microphone, false);
      const started = deferred<unknown>();
      rtcMocks.microphoneStarted.mockReturnValueOnce(started.promise);
      const first = rtc.setMediaEnabled(Track.Source.Microphone, true);
      await vi.waitFor(() => expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(2));
      const second = rtc.setMediaEnabled(Track.Source.Microphone, true);
      const listeningAgain = rtc.updateListeningState(true);
      started.resolve(undefined);
      await Promise.all([first, second, listeningAgain]);
      expect(rtc.microphoneEnabled.value).toBe(true);
      expect(rtcMocks.microphoneStarted).toHaveBeenCalledTimes(2);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('共享中关闭再开启声音只替换声音轨道，保留画面、麦克风及公开权限', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    addRemoteParticipant('viewer');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('audio-toggle');
      await rtc.setMediaEnabled(Track.Source.Microphone, true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const room = mockRoom();
      const video = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const originalAudio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      expect(rtc.currentScreenShareAudioMode.value).toBe('process');
      expect(await rtc.setScreenShareAudioEnabled(false)).toBe(true);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(true);
      const newAudio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      expect(newAudio).toBeDefined();
      expect(newAudio).not.toBe(originalAudio);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(video);
      expect(room.localParticipant.getTrackPublication(Track.Source.Microphone)).toBe(microphone);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(rtcMocks.microphoneStopped).not.toHaveBeenCalled();
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledTimes(2);
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
      expect(rtcMocks.subscriptionPermissions.at(-1)?.permissions).toEqual([
        { participantIdentity: 'viewer', allowAll: false,
          allowedTrackSids: expect.arrayContaining([
            (video as { trackSid: string }).trackSid, (newAudio as { trackSid: string }).trackSid,
            (microphone as { trackSid: string }).trackSid,
          ]) },
      ]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it.each(['capture', 'publish'])('共享中声音 %s 失败不停止画面，失败后可以重试', async (stage) => {
    configureNativeScreenDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('audio-toggle-failure');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const video = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (stage === 'capture') rtcMocks.nativeAudioStarts.mockRejectedValueOnce(new Error('capture failed'));
      else rtcMocks.published.mockRejectedValueOnce(new Error('publish failed'));
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(false);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(video);
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(rtc.notice.value).toContain('画面仍在共享');
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(true);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeDefined();
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('声音切换期间拒绝重复操作与画质切换，离房后不发布迟到的声音', async () => {
    configureNativeScreenDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    const startup = deferred<unknown>();
    try {
      await rtc.join('late-audio-toggle');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.nativeAudioStarts.mockReturnValueOnce(startup.promise);
      const enabling = rtc.setScreenShareAudioEnabled(true);
      expect(rtc.busySources.value).toContain(Track.Source.ScreenShare);
      expect(await rtc.setScreenShareAudioEnabled(false)).toBe(false);
      expect(await rtc.setScreenShareQuality('text')).toBe(false);
      await rtc.leave();
      await rtc.join('next-audio-room');
      rtc.notice.value = '新房间提示';
      startup.resolve({});
      expect(await enabling).toBe(false);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(rtc.notice.value).toBe('新房间提示');
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
    } finally {
      startup.resolve({});
      await rtc.leave();
      scope.stop();
    }
  });

  it('更换来源的选择过程与取消保留原共享，确认后重建并撤销原远控授权', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: true });
    const revoke = vi.fn().mockResolvedValue({ changed: true });
    Object.assign(window.lycanDesktop!, {
      authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      revokeNativeRemoteControl: revoke,
    });
    addRemoteParticipant('viewer');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    const selection = deferred<{ sourceId: string; shareAudio: boolean; quality: string } | null>();
    try {
      await rtc.join('source-replacement');
      await rtc.setMediaEnabled(Track.Source.Microphone, true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const room = mockRoom();
      const video = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const audio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      receiveRemoteControl('viewer', { type: 'request', shareSessionId: 'monitor:1:0-session', requestId: 'request' });
      expect(await rtc.allowRemoteControl()).toBe(true);
      rtcMocks.selectedSources.mockReturnValueOnce(selection.promise);
      const choosing = rtc.changeScreenShareSource();
      expect(rtc.screenShareSourceBusy.value).toBe(true);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(video);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBe(audio);
      expect(await rtc.setScreenShareAudioEnabled(false)).toBe(false);
      selection.resolve(null);
      expect(await choosing).toBe(false);
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(rtc.remoteControlOwner.value).not.toBeNull();

      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:2:0', shareAudio: true, quality: 'text' });
      expect(await rtc.changeScreenShareSource()).toBe(true);
      expect(rtcMocks.nativeStarts).toHaveBeenLastCalledWith('window:2:0', 30, expect.anything());
      expect(rtcMocks.nativeAudioStarts).toHaveBeenLastCalledWith('window:2:0', 'window:2:0-session');
      expect(rtc.currentScreenShareQuality.value).toBe('text');
      expect(room.localParticipant.getTrackPublication(Track.Source.Microphone)).toBe(microphone);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).not.toBe(video);
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(revoke).toHaveBeenCalledWith('monitor:1:0-session', expect.any(String));
      expect(rtcMocks.microphoneStopped).not.toHaveBeenCalled();
      expect(rtc.status.value).toBe('connected');
    } finally {
      selection.resolve(null);
      await rtc.leave();
      scope.stop();
    }
  });

  it('离开房间后忽略迟到的来源选择，不影响新房间', async () => {
    configureNativeScreenDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    const selection = deferred<{ sourceId: string; shareAudio: boolean } | null>();
    try {
      await rtc.join('old-source-room');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.selectedSources.mockReturnValueOnce(selection.promise);
      const choosing = rtc.changeScreenShareSource();
      await rtc.leave();
      await rtc.join('new-source-room');
      rtc.notice.value = '新房间提示';
      selection.resolve({ sourceId: 'window:late:0', shareAudio: true });
      expect(await choosing).toBe(false);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtc.notice.value).toBe('新房间提示');
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeUndefined();
    } finally {
      selection.resolve(null);
      await rtc.leave();
      scope.stop();
    }
  });

  it('更换来源时原采集停止未确认，不叠加新采集', async () => {
    configureNativeScreenDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('source-stop-failure');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.nativeStops.mockRejectedValueOnce(new Error('stop failed'));
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:next:0', shareAudio: false });
      expect(await rtc.changeScreenShareSource()).toBe(false);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtc.notice.value).toContain('停止未确认');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('changes quality without recreating the publication, audio or capture, and ignores completion after leaving', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('quality-change-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const room = mockRoom();
      const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const publishCount = rtcMocks.published.mock.calls.length;
      expect(await rtc.setScreenShareQuality('economy')).toBe(true);
      expect(rtc.currentScreenShareQuality.value).toBe('economy');
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(publication);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(rtcMocks.nativeAudioStops).not.toHaveBeenCalled();
      expect(rtcMocks.published).toHaveBeenCalledTimes(publishCount);
      rtcMocks.nativeConfigured.mockRejectedValueOnce(new Error('configure failed'));
      expect(await rtc.setScreenShareQuality('text')).toBe(false);
      expect(rtc.currentScreenShareQuality.value).toBe('economy');
      expect(rtc.notice.value).toContain('保留原画质');
      const pending = deferred<void>();
      rtcMocks.nativeConfigured.mockReturnValueOnce(pending.promise);
      const changing = rtc.setScreenShareQuality('highFrameRate');
      expect(rtc.screenShareQualityBusy.value).toBe(true);
      expect(await rtc.setScreenShareQuality('text')).toBe(false);
      await rtc.leave();
      expect(await rtc.join('new-quality-room')).toBe(true);
      rtc.notice.value = '新房间提示';
      pending.resolve();
      expect(await changing).toBe(false);
      expect(rtc.notice.value).toBe('新房间提示');
      expect(rtc.currentScreenShareQuality.value).toBe('economy');
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('releases microphone and sharing when removed without treating it as a media server failure', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('removed-member-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      mockRoom().emit('disconnected', 'participantRemoved');
      expect(rtc.notice.value).toContain('语音、共享和远控已结束');
      await vi.waitFor(() => {
        expect(rtcMocks.microphoneStopped).toHaveBeenCalledOnce();
        expect(rtcMocks.nativeStops).toHaveBeenCalledOnce();
        expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
      });
      expect(rtc.screenShareActive.value).toBe(false);
      expect(rtc.room.value).toBeNull();
    } finally { scope.stop(); }
  });

  it.each([
    { quality: 'economy', fps: 30, bitrate: 3_000_000, degradation: 'balanced' },
    { quality: 'standard', fps: 60, bitrate: 12_000_000, degradation: 'maintain-framerate' },
    { quality: 'highFrameRate', fps: 120, bitrate: 20_000_000, degradation: 'maintain-framerate' },
    { quality: 'text', fps: 30, bitrate: 8_000_000, degradation: 'maintain-resolution' },
  ] as const)('passes the $quality selection to native capture and publication', async ({ quality, fps, bitrate, degradation }) => {
    configureNativeScreenDesktop();
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'window:test:0', shareAudio: false, quality });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('quality-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:test:0', fps, { hideCursor: false, hideBorder: false });
      expect(rtcMocks.published).toHaveBeenCalledWith(expect.anything(), {
        source: Track.Source.ScreenShare,
        screenShareEncoding: expect.objectContaining({ maxFramerate: fps, maxBitrate: bitrate, priority: 'high' }),
        videoCodec: 'h264', simulcast: true,
        screenShareSimulcastLayers: [expect.objectContaining({ width: 640, height: 360,
          encoding: expect.objectContaining({ maxBitrate: 1_000_000, maxFramerate: 30 }) })],
        degradationPreference: degradation,
      });
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('keeps subscription permissions denied until actual public track SIDs are published', async () => {
    rtcMocks.initialRemoteParticipants.push({ identity: 'alice', getTrackPublication: () => undefined });
    configureNativeScreenDesktop({ screenAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('permission-room')).toBe(true);
      const room = mockRoom();
      const localParticipant = room.localParticipant as unknown as {
        trackPublications: Map<string, { trackSid: string; track: { stop: ReturnType<typeof vi.fn> }; source: string }>;
      };
      const roomEvents = rtcMocks.subscriptionLifecycle.filter((event) => event.room === room);
      expect(roomEvents[0]).toMatchObject({ event: 'permissions' });
      expect(roomEvents.findIndex((event) => event.event === 'permissions'))
        .toBeLessThan(roomEvents.findIndex((event) => event.event === 'connect'));
      expect(rtcMocks.subscriptionPermissions.some(({ allowAll }) => allowAll)).toBe(false);

      const microphoneSid = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        participantIdentity: string; allowedTrackSids: string[];
      }>;
      expect(microphoneSid).toEqual([{ participantIdentity: 'alice', allowedTrackSids: ['track-1'], allowAll: false }]);
      const microphonePublication = localParticipant.trackPublications.get(Track.Source.Microphone)!;
      room.emit('localTrackUnpublished', microphonePublication);
      let republishedSids = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(republishedSids[0].allowedTrackSids).toEqual([]);
      const republishedMicrophone = { ...microphonePublication, trackSid: 'microphone-republished' };
      localParticipant.trackPublications.set(Track.Source.Microphone, republishedMicrophone);
      room.emit('localTrackPublished', republishedMicrophone);
      republishedSids = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(republishedSids[0].allowedTrackSids).toEqual(['microphone-republished']);
      room.emit('localTrackPublished', { track: { stop: vi.fn() }, trackSid: 'unregistered-private-track', source: 'screen_share' });
      const afterUnregisteredTrack = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(afterUnregisteredTrack[0].allowedTrackSids).toEqual(['microphone-republished']);

      const pendingPublish = deferred<void>();
      rtcMocks.published.mockImplementation(() => pendingPublish.promise);
      const sharing = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.nativeStarts).toHaveBeenCalled());
      const beforePublish = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(beforePublish[0].allowedTrackSids).toEqual(['microphone-republished']);

      pendingPublish.resolve();
      await sharing;
      const publicSids = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(publicSids[0].allowedTrackSids).toEqual(['microphone-republished', 'track-2', 'track-3']);

      const videoPublication = localParticipant.trackPublications.get(Track.Source.ScreenShare)!;
      room.emit('localTrackUnpublished', videoPublication);
      const republishedVideo = { ...videoPublication, trackSid: 'track-republished' };
      localParticipant.trackPublications.set(Track.Source.ScreenShare, republishedVideo);
      room.emit('localTrackPublished', republishedVideo);
      const republishedShareSids = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(republishedShareSids[0].allowedTrackSids).toEqual(['microphone-republished', 'track-3', 'track-republished']);

      const participant = { identity: 'bob', getTrackPublication: () => undefined };
      room.remoteParticipants.set('bob', participant);
      room.emit('participantConnected', participant);
      const withNewMember = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        participantIdentity: string; allowedTrackSids: string[];
      }>;
      expect(withNewMember).toEqual([
        { participantIdentity: 'alice', allowAll: false, allowedTrackSids: ['microphone-republished', 'track-3', 'track-republished'] },
        { participantIdentity: 'bob', allowAll: false, allowedTrackSids: ['microphone-republished', 'track-3', 'track-republished'] },
      ]);

      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      const afterUnpublish = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        participantIdentity: string; allowedTrackSids: string[];
      }>;
      expect(afterUnpublish.map(({ allowedTrackSids }) => allowedTrackSids))
        .toEqual([['microphone-republished'], ['microphone-republished']]);
      room.emit('localTrackPublished', { ...republishedVideo, trackSid: 'late-after-stop' });
      const afterLatePublish = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(afterLatePublish.map(({ allowedTrackSids }) => allowedTrackSids))
        .toEqual([['microphone-republished'], ['microphone-republished']]);
      room.remoteParticipants.delete('bob');
      room.emit('participantDisconnected', participant);
      const afterDeparture = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        participantIdentity: string; allowedTrackSids: string[];
      }>;
      expect(afterDeparture).toEqual([{ participantIdentity: 'alice', allowAll: false,
        allowedTrackSids: ['microphone-republished'] }]);
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('revokes microphone eligibility before an error-triggered unpublish can finish', async () => {
    rtcMocks.initialRemoteParticipants.push({ identity: 'alice', getTrackPublication: () => undefined });
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
    }))!;
    try {
      expect(await rtc.join('microphone-error-permission-room')).toBe(true);
      const room = mockRoom();
      const trackPublications = (room.localParticipant as unknown as {
        trackPublications: Map<string, { trackSid: string; track: { stop: ReturnType<typeof vi.fn> }; source: string }>;
      }).trackPublications;
      const microphonePublication = trackPublications.get(Track.Source.Microphone)!;
      const pendingUnpublish = deferred<void>();
      rtcMocks.unpublishing.mockImplementation(() => pendingUnpublish.promise);

      rtcMocks.nativeMicrophoneError('audioDeviceUnavailable');
      await vi.waitFor(() => expect(rtcMocks.unpublishing).toHaveBeenCalledWith(microphonePublication.track, true));
      room.emit('localTrackPublished', { ...microphonePublication, trackSid: 'late-microphone-error-sid' });
      const permissions = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(permissions[0].allowedTrackSids).not.toContain('late-microphone-error-sid');
      expect(permissions[0].allowedTrackSids).toEqual([]);

      pendingUnpublish.resolve();
      await vi.waitFor(() => expect(room.localParticipant.getTrackPublication(Track.Source.Microphone)).toBeUndefined());
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it.each([Track.Source.Microphone, Track.Source.ScreenShare] as const)(
    'revokes %s eligibility before a user-requested unpublish finishes', async (source) => {
      rtcMocks.initialRemoteParticipants.push({ identity: 'alice', getTrackPublication: () => undefined });
      configureNativeScreenDesktop({ screenAudio: true });
      const scope = effectScope();
      const rtc = scope.run(() => useRtcRoom({
        inputGain: 1,
        processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
        events: { selectNativeScreenSource: rtcMocks.selectedSources },
      }))!;
      try {
        expect(await rtc.join(`user-stop-${source}-room`)).toBe(true);
        if (source === Track.Source.ScreenShare) await rtc.setMediaEnabled(source, true);
        const room = mockRoom();
        const trackPublications = (room.localParticipant as unknown as {
          trackPublications: Map<string, { trackSid: string; track: { stop: ReturnType<typeof vi.fn> }; source: string }>;
        }).trackPublications;
        const targetSources = source === Track.Source.Microphone
          ? [Track.Source.Microphone]
          : [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];
        const oldPublications = targetSources.map((targetSource) => trackPublications.get(targetSource)!);
        const pendingUnpublish = deferred<void>();
        rtcMocks.unpublishing.mockImplementation(() => pendingUnpublish.promise);

        const stopping = rtc.setMediaEnabled(source, false);
        await vi.waitFor(() => expect(rtcMocks.unpublishing).toHaveBeenCalledTimes(oldPublications.length));
        oldPublications.forEach((publication) => {
          room.emit('localTrackPublished', { ...publication, trackSid: `late-${publication.trackSid}` });
        });
        const permissions = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
          allowedTrackSids: string[];
        }>;
        oldPublications.forEach((publication) => {
          expect(permissions.flatMap(({ allowedTrackSids }) => allowedTrackSids)).not.toContain(publication.trackSid);
          expect(permissions.flatMap(({ allowedTrackSids }) => allowedTrackSids))
            .not.toContain(`late-${publication.trackSid}`);
        });

        pendingUnpublish.resolve();
        await stopping;
      } finally {
        await rtc.leave();
        scope.stop();
      }
    },
  );

  it('revokes a failed screen publication before native device cleanup waits', async () => {
    rtcMocks.initialRemoteParticipants.push({ identity: 'alice', getTrackPublication: () => undefined });
    configureNativeScreenDesktop();
    const pendingNativeStop = deferred<void>();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('failed-publish-permission-room')).toBe(true);
      rtcMocks.published.mockRejectedValueOnce(new Error('publish failed'));
      rtcMocks.nativeStops.mockImplementation(() => pendingNativeStop.promise);
      const publishing = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.nativeStops).toHaveBeenCalled());
      const failedVideo = rtcMocks.nativeVideoInstances.at(-1) as { track: { stop: ReturnType<typeof vi.fn> } };
      const room = mockRoom();
      room.emit('localTrackPublished', {
        track: failedVideo.track, trackSid: 'late-failed-screen-share', source: Track.Source.ScreenShare,
      });
      const permissions = [...rtcMocks.subscriptionPermissions].at(-1)?.permissions as Array<{
        allowedTrackSids: string[];
      }>;
      expect(permissions[0].allowedTrackSids).not.toContain('late-failed-screen-share');

      pendingNativeStop.resolve();
      await publishing;
    } finally {
      pendingNativeStop.resolve();
      await rtc.leave();
      scope.stop();
    }
  });

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

  it('queries existing shares after join and accepts the matching current-room response', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    addRemoteParticipant('owner-a', true);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('remote-control-query')).toBe(true);
      const query = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .find((message) => message.type === 'queryShare');
      expect(query?.requestId).toBeTruthy();
      receiveRemoteControl('owner-a', { type: 'shareState', shareSessionId: 'share-a', sourceKind: 'monitor', requestId: query.requestId });
      expect(rtc.remoteControlShares.value['owner-a']).toEqual({ shareSessionId: 'share-a', kind: 'monitor' });
      receiveRemoteControl('owner-a', { type: 'shareState', shareSessionId: 'stale-share', sourceKind: 'window', requestId: 'stale-query' });
      expect(rtc.remoteControlShares.value['owner-a'].shareSessionId).toBe('share-a');
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('cancels a pending request immediately, ignores its late allow and does not restore control after reconnect', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    configureNativeMicrophoneDesktop();
    addRemoteParticipant('owner-a', true);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('remote-control-cancel');
      const query = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .find((message) => message.type === 'queryShare');
      receiveRemoteControl('owner-a', { type: 'shareState', shareSessionId: 'share-a',
        sourceKind: 'monitor', requestId: query.requestId });
      expect(rtc.remoteControlShares.value['owner-a']).toEqual({ shareSessionId: 'share-a', kind: 'monitor' });

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      const firstRequest = rtc.remoteControlPending.value!;
      await rtc.cancelPendingRemoteControl('owner-a');
      await rtc.cancelPendingRemoteControl('owner-a');
      expect(rtc.remoteControlPending.value).toBeNull();
      expect(rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'cancel')).toHaveLength(1);
      receiveRemoteControl('owner-a', { type: 'allow', shareSessionId: firstRequest.shareSessionId,
        requestId: firstRequest.requestId, controlSessionId: 'late-control' });
      expect(rtc.remoteControlActive.value).toBeNull();

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      const nextRequest = rtc.remoteControlPending.value!;
      expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
      receiveRemoteControl('owner-a', { type: 'allow', shareSessionId: nextRequest.shareSessionId,
        requestId: nextRequest.requestId, controlSessionId: 'current-control' });
      expect(rtc.remoteControlActive.value?.controlSessionId).toBe('current-control');

      mockRoom().emit('connectionStateChanged', 'reconnecting');
      expect(rtc.remoteControlActive.value).toBeNull();
      mockRoom().emit('connectionStateChanged', 'connected');
      expect(rtc.remoteControlActive.value).toBeNull();
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('releases controller state before a pending revoke notification settles', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    configureNativeMicrophoneDesktop();
    addRemoteParticipant('owner-a', true);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    const notification = deferred<void>();
    try {
      await rtc.join('remote-control-local-stop');
      const query = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .find((message) => message.type === 'queryShare');
      receiveRemoteControl('owner-a', { type: 'shareState', shareSessionId: 'share-a',
        sourceKind: 'monitor', requestId: query.requestId });
      await rtc.requestRemoteControl('owner-a');
      const request = rtc.remoteControlPending.value!;
      receiveRemoteControl('owner-a', { type: 'allow', shareSessionId: request.shareSessionId,
        requestId: request.requestId, controlSessionId: 'control-a' });
      rtcMocks.publishData.mockImplementation((payload: Uint8Array) => {
        if (JSON.parse(new TextDecoder().decode(payload)).type === 'revoke') return notification.promise;
      });

      expect(await rtc.exitRemoteControl()).toBe(true);
      expect(rtc.remoteControlActive.value).toBeNull();
      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      rtc.notice.value = '新会话提示';
      notification.reject(new Error('network unavailable'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rtc.notice.value).toBe('新会话提示');
    } finally {
      notification.resolve();
      await rtc.leave();
      scope.stop();
    }
  });

  it('locks requests to one target and disposes the old pointer queue on controller exit', async () => {
    vi.useFakeTimers();
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    addRemoteParticipant('owner-a', true);
    addRemoteParticipant('owner-b', true);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { lycanDesktop: {
      startNativeMicrophone: rtcMocks.microphoneStarted,
      stopNativeMicrophone: rtcMocks.microphoneStopped,
      configureNativeMicrophone: rtcMocks.microphoneConfigured,
    } } });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('remote-control-controller');
      const queryPacket = rtcMocks.sentPackets.find(({ payload, options }) =>
        options.destinationIdentities?.[0] === 'owner-a'
          && JSON.parse(new TextDecoder().decode(payload)).type === 'queryShare');
      const query = JSON.parse(new TextDecoder().decode(queryPacket!.payload));
      const owner = addRemoteParticipant('owner-a', true);
      expect(owner).toBeTruthy();
      receiveRemoteControl('owner-a', { type: 'shareState', shareSessionId: 'share-a', sourceKind: 'monitor', requestId: query.requestId });
      receiveRemoteControl('owner-b', { type: 'share', shareSessionId: 'share-b', sourceKind: 'monitor' });

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      expect(await rtc.requestRemoteControl('owner-b')).toBe(false);
      const request = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .reverse().find((message) => message.type === 'request');
      receiveRemoteControl('owner-a', { type: 'allow', shareSessionId: 'share-a', requestId: request.requestId, controlSessionId: 'control-a' });
      expect(rtc.remoteControlActive.value?.controlSessionId).toBe('control-a');

      let failOldMove!: () => void;
      let finishRevoke!: () => void;
      rtcMocks.publishData.mockImplementation((payload: Uint8Array) => {
        const message = JSON.parse(new TextDecoder().decode(payload));
        if (message.type === 'input' && message.input.kind === 'move') {
          return new Promise<void>((_, reject) => { failOldMove = () => reject(new Error('oldInputFailed')); });
        }
        if (message.type === 'revoke') return new Promise<void>((resolve) => { finishRevoke = resolve; });
      });
      rtc.sendRemoteControlInput({ kind: 'move', x: 100, y: 200 });
      await vi.advanceTimersByTimeAsync(16);
      await rtc.sendRemoteControlInput({ kind: 'keyDown', key: 'letterA' });
      const exiting = rtc.exitRemoteControl();
      expect(await exiting).toBe(true);
      expect(rtc.remoteControlActive.value).toBeNull();
      finishRevoke();
      await vi.advanceTimersByTimeAsync(20);
      const sentInputs = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'input');
      expect(sentInputs.map((message) => message.input.kind)).toEqual(['move', 'keyDown']);
      expect(sentInputs.map((message) => message.sequence)).toEqual([1, 2]);
      expect(rtc.remoteControlActive.value).toBeNull();
      expect(rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .some((message) => message.type === 'revoke')).toBe(true);
      expect(await rtc.requestRemoteControl('owner-b')).toBe(true);
      const nextRequest = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .reverse().find((message) => message.type === 'request');
      receiveRemoteControl('owner-b', { type: 'allow', shareSessionId: 'share-b',
        requestId: nextRequest.requestId, controlSessionId: 'control-b' });
      expect(rtc.remoteControlActive.value?.controlSessionId).toBe('control-b');
      failOldMove();
      await Promise.resolve();
      expect(rtc.remoteControlActive.value?.controlSessionId).toBe('control-b');
      let failRevoke = true;
      rtcMocks.publishData.mockImplementation((payload: Uint8Array) => {
        if (JSON.parse(new TextDecoder().decode(payload)).type === 'revoke' && failRevoke) {
          failRevoke = false;
          throw new Error('revokeSendFailed');
        }
      });
      expect(await rtc.exitRemoteControl()).toBe(true);
      expect(rtc.remoteControlActive.value).toBeNull();
      await vi.waitFor(() => expect(rtc.notice.value).toContain('本地输入已停止'));
      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      await rtc.cancelPendingRemoteControl();
      mockRoom().remoteParticipants.delete('owner-b');
      mockRoom().emit('participantDisconnected', { identity: 'owner-b' });
      expect(rtc.remoteControlPending.value).toBeNull();
    } finally {
      await rtc.leave();
      scope.stop();
      vi.useRealTimers();
    }
  });

  it('clears the owner approval slot immediately when the applicant leaves', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({});
    rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'approval-share', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
        startNativeMicrophone: rtcMocks.microphoneStarted, stopNativeMicrophone: rtcMocks.microphoneStopped,
        authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
        sendNativeRemoteInput: vi.fn().mockResolvedValue({ changed: true }),
        revokeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      } },
    });
    addRemoteParticipant('viewer-a');
    addRemoteParticipant('viewer-b');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('remote-control-applicant-left');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'approval-share', requestId: 'request-a' });
      expect(rtc.remoteControlRequest.value?.identity).toBe('viewer-a');
      const room = mockRoom();
      room.remoteParticipants.delete('viewer-a');
      room.emit('participantDisconnected', { identity: 'viewer-a' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      receiveRemoteControl('viewer-b', { type: 'request', shareSessionId: 'approval-share', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-b', requestId: 'request-b' });
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('does not grant a request canceled while native authorization is pending', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({});
    rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'cancel-race-share' });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    const authorization = deferred<{ changed: true }>();
    const authorizeNative = vi.fn(() => authorization.promise);
    const revokeNative = vi.fn().mockResolvedValue({ changed: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
        startNativeMicrophone: rtcMocks.microphoneStarted, stopNativeMicrophone: rtcMocks.microphoneStopped,
        authorizeNativeRemoteControl: authorizeNative, revokeNativeRemoteControl: revokeNative,
      } },
    });
    addRemoteParticipant('viewer-a');
    addRemoteParticipant('viewer-b');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('remote-control-cancel-race');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'cancel-race-share', requestId: 'request-a' });
      const allowing = rtc.allowRemoteControl();
      expect(rtc.remoteControlGranting.value).toBe(true);
      receiveRemoteControl('viewer-a', { type: 'cancel', shareSessionId: 'cancel-race-share', requestId: 'request-a' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      authorization.resolve({ changed: true });

      expect(await allowing).toBe(false);
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(revokeNative).toHaveBeenCalledTimes(1);
      receiveRemoteControl('viewer-b', { type: 'request', shareSessionId: 'cancel-race-share', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-b', requestId: 'request-b' });
    } finally {
      authorization.resolve({ changed: true });
      await rtc.leave();
      scope.stop();
    }
  });

  it('keeps a late old-share authorization from replacing or granting the new share', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({});
    rtcMocks.microphoneStopped.mockResolvedValue({});
    rtcMocks.nativeStarts.mockResolvedValueOnce({ sessionId: 'share-a' }).mockResolvedValueOnce({ sessionId: 'share-b' });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    const oldAuthorization = deferred<{ changed: true }>();
    const authorizeNative = vi.fn((sessionId: string) => sessionId === 'share-a'
      ? oldAuthorization.promise : Promise.resolve({ changed: true as const }));
    const revokeNative = vi.fn().mockResolvedValue({ changed: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
        startNativeMicrophone: rtcMocks.microphoneStarted, stopNativeMicrophone: rtcMocks.microphoneStopped,
        authorizeNativeRemoteControl: authorizeNative, revokeNativeRemoteControl: revokeNative,
      } },
    });
    addRemoteParticipant('viewer-a');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('remote-owner-room-a')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'share-a', requestId: 'request-a' });
      const oldAllow = rtc.allowRemoteControl();
      await rtc.leave();

      expect(await rtc.join('remote-owner-room-b')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'share-b', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();

      oldAuthorization.resolve({ changed: true });
      expect(await oldAllow).toBe(false);
      expect(revokeNative).toHaveBeenCalledWith('share-a', expect.any(String));
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();

      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'share-b', requestId: 'request-b2' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-a', requestId: 'request-b2' });
      expect(await rtc.allowRemoteControl()).toBe(true);
      expect(rtc.remoteControlOwner.value?.identity).toBe('viewer-a');
    } finally {
      oldAuthorization.resolve({ changed: true });
      await rtc.leave();
      scope.stop();
    }
  });

  it('reclaims native authorization when the reliable allow packet fails', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({});
    rtcMocks.microphoneStopped.mockResolvedValue({});
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'allow-failure-share' });
    rtcMocks.nativeStops.mockResolvedValue({});
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    const authorizeNative = vi.fn().mockResolvedValue({});
    const revokeNative = vi.fn().mockResolvedValue({});
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
        startNativeMicrophone: rtcMocks.microphoneStarted, stopNativeMicrophone: rtcMocks.microphoneStopped,
        authorizeNativeRemoteControl: authorizeNative, revokeNativeRemoteControl: revokeNative,
      } },
    });
    addRemoteParticipant('viewer-a');
    addRemoteParticipant('viewer-b');
    rtcMocks.publishData.mockImplementation((payload: Uint8Array) => {
      if (JSON.parse(new TextDecoder().decode(payload)).type === 'allow') throw new Error('allowSendFailed');
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('remote-control-allow-send-failure');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'allow-failure-share', requestId: 'allow-request' });

      expect(await rtc.allowRemoteControl()).toBe(false);
      expect(authorizeNative).toHaveBeenCalledTimes(1);
      expect(revokeNative).toHaveBeenCalledWith('allow-failure-share', expect.any(String));
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(rtc.remoteControlCleanupPending.value).toBe(false);

      receiveRemoteControl('viewer-b', { type: 'request', shareSessionId: 'allow-failure-share', requestId: 'next-request' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-b', requestId: 'next-request' });
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('keeps owner input disabled after failed revocation and retries without stopping the shared track', async () => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    rtcMocks.microphoneStarted.mockResolvedValue({});
    rtcMocks.microphoneStopped.mockResolvedValue({ changed: true });
    rtcMocks.nativeStarts.mockResolvedValue({ sessionId: 'share-session', changed: true });
    rtcMocks.nativeStops.mockResolvedValue({ changed: true });
    rtcMocks.selectedSources.mockResolvedValue({ sourceId: 'monitor:1:0', shareAudio: false });
    const nativeInput = vi.fn().mockResolvedValue({ changed: true });
    const revokeNative = vi.fn().mockRejectedValueOnce(new Error('releaseFailed')).mockResolvedValue({ changed: true });
    const revokeNotification = deferred<void>();
    rtcMocks.publishData.mockImplementation((payload: Uint8Array) => {
      if (JSON.parse(new TextDecoder().decode(payload)).type === 'revoke') return revokeNotification.promise;
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: true, reason: 'ready' } }),
        listNativeVideoSources: async () => ({ revision: 1, sources: [
          { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        ] }),
        startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
        startNativeMicrophone: rtcMocks.microphoneStarted, stopNativeMicrophone: rtcMocks.microphoneStopped,
        authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
        sendNativeRemoteInput: nativeInput, revokeNativeRemoteControl: revokeNative,
      } },
    });
    addRemoteParticipant('viewer-a');
    addRemoteParticipant('viewer-b');
    addRemoteParticipant('owner-c', true);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('remote-control-owner');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', shareSessionId: 'share-session', requestId: 'request-a' });
      receiveRemoteControl('viewer-b', { type: 'request', shareSessionId: 'share-session', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-a', requestId: 'request-a' });
      await rtc.allowRemoteControl();
      const granted = rtc.remoteControlOwner.value!;
      expect(rtc.remoteControlActive.value).toBeNull();
      receiveRemoteControl('viewer-a', { type: 'input', shareSessionId: 'share-session', controlSessionId: granted.controlSessionId,
        sequence: 1, input: { kind: 'keyDown', key: 'letterA' } });
      // A newer lossy pointer must not invalidate the earlier reliable key release.
      receiveRemoteControl('viewer-a', { type: 'input', shareSessionId: 'share-session', controlSessionId: granted.controlSessionId,
        sequence: 3, input: { kind: 'move', x: 30000, y: 40000 } });
      receiveRemoteControl('viewer-a', { type: 'input', shareSessionId: 'share-session', controlSessionId: granted.controlSessionId,
        sequence: 2, input: { kind: 'keyUp', key: 'letterA' } });
      await vi.waitFor(() => expect(nativeInput).toHaveBeenCalledTimes(3));

      receiveRemoteControl('viewer-a', { type: 'revoke', shareSessionId: 'stale-share', requestId: 'old',
        controlSessionId: granted.controlSessionId });
      await Promise.resolve();
      expect(rtc.remoteControlOwner.value?.controlSessionId).toBe(granted.controlSessionId);
      expect(revokeNative).not.toHaveBeenCalled();

      expect(await rtc.revokeRemoteControl()).toBe(false);
      expect(rtc.remoteControlCleanupPending.value).toBe(true);
      expect(rtc.notice.value).toContain('尚未释放');
      receiveRemoteControl('viewer-a', { type: 'input', shareSessionId: 'share-session', controlSessionId: granted.controlSessionId,
        sequence: 4, input: { kind: 'keyDown', key: 'letterB' } });
      await Promise.resolve();
      expect(nativeInput).toHaveBeenCalledTimes(3);
      expect(mockRoom().localParticipant?.getTrackPublication?.(Track.Source.ScreenShare)).toBeTruthy();
      expect(await rtc.retryRemoteControlCleanup()).toBe(true);
      expect(rtc.remoteControlCleanupPending.value).toBe(false);
      expect(nativeInput).toHaveBeenCalledTimes(3);
      receiveRemoteControl('owner-c', { type: 'share', shareSessionId: 'other-share', sourceKind: 'monitor' });
      expect(await rtc.requestRemoteControl('owner-c')).toBe(true);
    } finally {
      revokeNotification.resolve();
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
      expect(rtc.notice.value).toBe('麦克风停止未确认，已禁止发送，请重启客户端后再开麦。');
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
        expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('monitor:1:0', 60, { hideCursor: false, hideBorder: false });
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

  it.each([false, true])('attempts audio cleanup when native video stop fails (audio failure: %s)', async (audioStopFails) => {
    configureNativeScreenDesktop({ screenAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    const cleanupError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await rtc.join('stop-failure-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const startsBeforeStop = rtcMocks.nativeStarts.mock.calls.length;
      rtcMocks.nativeStops.mockRejectedValue(new Error('native stop failed'));
      if (audioStopFails) {
        rtcMocks.nativeAudioStops.mockRejectedValue(new Error('native audio stop failed'));
      }
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('window:test:0-session');
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledWith('window:test:0-session');
      expect(rtc.notice.value).toContain('停止未确认');
      expect(rtc.screenShareActive.value).toBe(false);
      if (audioStopFails) expect(cleanupError).toHaveBeenCalledWith('原生音频清理未完成', expect.any(Error));

      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(startsBeforeStop);
      expect(rtc.notice.value).toContain('重启客户端');
    } finally {
      cleanupError.mockRestore();
      await rtc.leave();
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

  it('共享声音发布失败只清理声音，保留画面和麦克风', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    rtcMocks.published.mockImplementation(async (_track, options) => {
      if (options?.source === Track.Source.ScreenShareAudio) throw new Error('audio publication failed');
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({
      inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('audio-publish-failure')).toBe(true);
      const room = mockRoom();
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toMatchObject({ track: expect.anything() });
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(room.localParticipant.getTrackPublication(Track.Source.Microphone)).toBe(microphone);
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(rtc.notice.value).toContain('仅共享画面');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.nativeStops).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
    } finally {
      await rtc.leave();
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
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:room-b:0', 60, { hideCursor: false, hideBorder: false });
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
    addRemoteParticipant('peer');
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
      const roomA = rtcMocks.rooms[0];
      await rtc.leave();
      expect(await rtc.join('publish-b')).toBe(true);
      const roomB = mockRoom();
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:room-b:0', shareAudio: false });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const packetsBeforeOldPublish = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'share');
      expect(packetsBeforeOldPublish).toHaveLength(1);
      const roomAPermissionsBeforeLatePublish = rtcMocks.subscriptionPermissions
        .filter((entry) => entry.room === roomA).length;

      delayedPublish.resolve(undefined);
      await oldTask;
      expect(rtcMocks.subscriptionPermissions.filter((entry) => entry.room === roomA))
        .toHaveLength(roomAPermissionsBeforeLatePublish);
      const sharePackets = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'share');
      expect(sharePackets).toHaveLength(1);
      expect(rtc.screenShareActive.value).toBe(true);
      expect(rtcMocks.unpublishing).toHaveBeenCalledWith(oldTrack, true);
      expect(oldTrack.stop).toHaveBeenCalledOnce();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();
      const roomBPermissionUpdates = rtcMocks.subscriptionPermissions.filter((entry) => entry.room === roomB).length;
      (roomA as { emit: (event: string, ...args: unknown[]) => void }).emit('localTrackPublished', {
        track: oldTrack, trackSid: 'old-room-late-sid', source: Track.Source.ScreenShare,
      });
      expect(rtcMocks.subscriptionPermissions.filter((entry) => entry.room === roomB))
        .toHaveLength(roomBPermissionUpdates);
      const roomBSids = [...rtcMocks.subscriptionPermissions].filter((entry) => entry.room === roomB).at(-1)
        ?.permissions as Array<{ allowedTrackSids: string[] }>;
      expect(roomBSids.flatMap(({ allowedTrackSids }) => allowedTrackSids)).not.toContain('old-room-late-sid');
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

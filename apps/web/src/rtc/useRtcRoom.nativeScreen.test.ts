import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAudioTrack, Track } from 'livekit-client';
import { useRtcRoom } from './useRtcRoom';
import type { CustomScreenShareQuality } from './screenShareQuality';
import type { ScreenSharePreferences } from '../settings/screenSharePreferences';
import { encodeRemoteControlMessage, REMOTE_CONTROL_TOPIC, type RemoteControlMessage } from './remoteControl';

const rtcMocks = vi.hoisted(() => ({
  token: vi.fn(),
  attributesSet: vi.fn(),
  published: vi.fn(),
  unpublishing: vi.fn(),
  nativeStarts: vi.fn(),
  startupTiming: vi.fn(),
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
    needsFrameRateRecovery = false;
    constructor(private readonly desktop: Window['lycanDesktop'], private readonly options: { maxFps: number; resolution: { width: number; height: number };
      captureSettings?: ScreenSharePreferences;
      isCurrentCapture?: () => boolean; canReduceFrameRate?: () => boolean;
      onFrameRateAdjustmentFailure?: (frameRate: number) => void; onError?: (code: string) => void }) {
      rtcMocks.nativeVideoInstances.push(this);
      if (options.onError) rtcMocks.nativeError.mockImplementation(options.onError);
    }
    start(sourceId: string) {
      if (!this.startPromise) {
        this.startPromise = this.desktop!.startNativeVideo(sourceId, this.options.maxFps,
          this.options.captureSettings ?? { hideCursor: false, hideBorder: false }, this.options.resolution).then((result) => {
          this.sessionId = result.sessionId;
          return this.track as never;
        });
      }
      return this.startPromise;
    }
    get captureSessionId() { return this.sessionId; }
    canReduceFrameRate() { return this.options.isCurrentCapture?.() && this.options.canReduceFrameRate?.(); }
    reportFrameRateFailure(frameRate: number) { this.needsFrameRateRecovery = true; this.options.onFrameRateAdjustmentFailure?.(frameRate); }
    async configureQuality(id: string, custom: CustomScreenShareQuality) {
      await rtcMocks.nativeConfigured(id, custom);
      this.needsFrameRateRecovery = false;
    }
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
    startupTiming?: { pluginLoadMs: number; captureReadyMs: number; graphReadyMs: number };
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
      const format = await this.desktop!.startNativeScreenAudio(sourceId, sessionId);
      this.startupTiming = { pluginLoadMs: format.pluginLoadMs, captureReadyMs: format.captureReadyMs, graphReadyMs: 20 };
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

beforeEach(() => {
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    close = vi.fn(async () => { this.state = 'closed'; });
  });
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
    disconnect(): Promise<void>;
  };
}

async function waitForSharedAudio() {
  await vi.waitFor(() => expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeDefined());
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


function beginRemoteControlApproval(rtc: ReturnType<typeof useRtcRoom>, identity = 'viewer-a', publicVideo = true) {
  const request = rtc.remoteControlRequest.value!;
  const approving = rtc.allowRemoteControl('monitor:1:0', publicVideo);
  receiveRemoteControl(identity, { type: 'controllerReady', requestId: request.requestId });
  return approving;
}

async function deliverControlGrant(rtc: ReturnType<typeof useRtcRoom>, identity: string,
  message: Extract<RemoteControlMessage, { type: 'allow' }>) {
  if (rtc.remoteControlPending.value?.requestId === message.requestId) {
    receiveRemoteControl(identity, { type: 'accept', requestId: message.requestId });
    await vi.waitFor(() => expect(rtcMocks.sentPackets.some(({ payload }) => {
      const packet = JSON.parse(new TextDecoder().decode(payload));
      return packet.type === 'controllerReady' && packet.requestId === message.requestId;
    })).toBe(true));
  }
  receiveRemoteControl(identity, message);
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
    sampleRate: 48000, channels: 2, bitsPerSample: 32, nominalChunkMs: 10, pluginLoadMs: 12, captureReadyMs: 340,
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
      listNativeVideoSources: async () => ({ revision: 1, sources: [
        { sourceId: 'monitor:1:0', kind: 'monitor', title: 'DISPLAY1', width: 1920, height: 1080, primary: true },
        { sourceId: 'window:test:0', kind: 'window', title: '测试窗口', width: 1280, height: 720, primary: false },
      ] }),
      recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
  it('节流资格只属于已发布的当前房间，重连或远控恢复高清，旧会话警告不污染新房间', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    type DemandSession = { canReduceFrameRate(): boolean; reportFrameRateFailure(frameRate: number): void };
    const publishing = deferred<void>();
    try {
      await rtc.join('demand-room');
      rtcMocks.published.mockImplementation((_track, options) => options?.source === Track.Source.ScreenShare
        ? publishing.promise : Promise.resolve());
      const starting = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.nativeVideoInstances).toHaveLength(1));
      const session = rtcMocks.nativeVideoInstances[0] as DemandSession;
      expect(session.canReduceFrameRate()).toBe(false);
      publishing.resolve(); await starting; await waitForSharedAudio();
      expect(session.canReduceFrameRate()).toBe(true);
      mockRoom().emit('connectionStateChanged', 'reconnecting');
      expect(session.canReduceFrameRate()).toBe(false);
      mockRoom().emit('connectionStateChanged', 'connected');
      expect(session.canReduceFrameRate()).toBe(true);
      rtc.remoteControlGranting.value = true;
      expect(session.canReduceFrameRate()).toBe(false);
      rtc.remoteControlGranting.value = false;
      rtc.remoteControlOwner.value = { identity: 'controller', controlSessionId: 'control', public: true };
      expect(session.canReduceFrameRate()).toBe(false);
      rtc.remoteControlOwner.value = null;
      session.reportFrameRateFailure(30);
      expect(rtc.notice.value).toContain('采集目标仍为 30 FPS');
      const publishedCount = rtcMocks.published.mock.calls.length;
      expect(await rtc.setScreenShareQuality('standard')).toBe(true);
      expect(rtc.notice.value).toBe('');
      expect(rtcMocks.published).toHaveBeenCalledTimes(publishedCount);
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      await rtc.leave(); await rtc.join('next-demand-room');
      rtc.notice.value = '新房间提示';
      expect(session.canReduceFrameRate()).toBe(false);
      session.reportFrameRateFailure(30);
      expect(rtc.notice.value).toBe('新房间提示');
    } finally { publishing.resolve(); await rtc.leave(); scope.stop(); }
  });

  it.each(['ready', 'failed'])('视频发布不等待声音启动，声音迟到 %s 不重建画面或麦克风', async (result) => {
    configureNativeScreenDesktop({ screenAudio: true });
    const audioStart = deferred<unknown>();
    rtcMocks.nativeAudioStarts.mockReturnValueOnce(audioStart.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('video-before-audio');
      await rtc.setMediaEnabled(Track.Source.Microphone, true);
      const microphone = mockRoom().localParticipant.getTrackPublication(Track.Source.Microphone);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const video = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare);
      expect(video).toBeDefined();
      expect(rtc.screenShareActive.value).toBe(true);
      expect(rtc.busySources.value).not.toContain(Track.Source.ScreenShare);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce();
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(false);
      expect(rtcMocks.startupTiming).toHaveBeenCalledWith('window:test:0-session', 'screenVideoPublished', expect.any(Number));
      expect(rtcMocks.startupTiming.mock.calls.some(call => call[1] === 'screenAudioStartup')).toBe(false);
      if (result === 'ready') {
        audioStart.resolve({ pluginLoadMs: 12, captureReadyMs: 340 });
        await waitForSharedAudio();
        expect(rtcMocks.startupTiming).toHaveBeenLastCalledWith('window:test:0-session', 'screenAudioStartup', expect.any(Number), {
          outcome: 'published', phase: 'publish', pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: 20, publishMs: expect.any(Number),
        });
      } else {
        audioStart.reject(new Error('screenShareAudioStartTimedOut'));
        await vi.waitFor(() => expect(rtc.notice.value).toContain('仅共享画面'));
        expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
        expect(rtcMocks.startupTiming).toHaveBeenLastCalledWith('window:test:0-session', 'screenAudioStartup', expect.any(Number), {
          outcome: 'failed', phase: 'capture',
        });
      }
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(video);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.Microphone)).toBe(microphone);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
    } finally { audioStart.resolve({}); await rtc.leave(); scope.stop(); }
  });

  it('视频尚未发布成功时不启动声音，取消后清理迟到的画面且不接入声音', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    addRemoteParticipant('viewer');
    const videoPublish = deferred<void>();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('cancel-publishing-video');
      rtcMocks.published.mockImplementation((_track, options) => options?.source === Track.Source.ScreenShare
        ? videoPublish.promise : Promise.resolve());
      const sharing = rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.published.mock.calls.some(call => call[1]?.source === Track.Source.ScreenShare)).toBe(true));
      expect(rtcMocks.nativeAudioStarts).not.toHaveBeenCalled();
      rtc.cancelPendingScreenShareSelection();
      videoPublish.resolve();
      await sharing;
      expect(rtcMocks.nativeAudioStarts).not.toHaveBeenCalled();
      expect(rtcMocks.nativeStops).toHaveBeenCalledOnce();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeUndefined();
      expect(rtcMocks.startupTiming).not.toHaveBeenCalled();
      expect(rtcMocks.subscriptionPermissions.flatMap(entry =>
        (entry.permissions as Array<{ allowedTrackSids: string[] }>).flatMap(permission => permission.allowedTrackSids)))
        .not.toContain('track-2');
    } finally { videoPublish.resolve(); await rtc.leave(); scope.stop(); }
  });

  it('等待声音时可停止并重开画面，旧声音启动结果不再发布或覆盖新提示', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    const audioStart = deferred<unknown>();
    rtcMocks.nativeAudioStarts.mockReturnValueOnce(audioStart.promise);
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('stop-starting-audio');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const oldAudio = rtcMocks.nativeAudioInstances[0] as { stop(): Promise<void> };
      const stop = vi.spyOn(oldAudio, 'stop');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
      const stoppedCalls = stop.mock.calls.length;
      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:new:0', shareAudio: false });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      const video = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare);
      rtc.notice.value = '新共享提示';
      audioStart.resolve({});
      await vi.waitFor(() => expect(stop.mock.calls.length).toBeGreaterThan(stoppedCalls));
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(video);
      expect(rtc.notice.value).toBe('新共享提示');
      expect(rtcMocks.startupTiming.mock.calls.some(call => call[1] === 'screenAudioStartup')).toBe(false);
    } finally { audioStart.resolve({}); await rtc.leave(); scope.stop(); }
  });

  it('声音发布结果迟到时停止共享先撤销资格，不短暂授予声音订阅权限', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    addRemoteParticipant('viewer');
    const audioPublish = deferred<void>();
    rtcMocks.published.mockImplementation((_track, options) => options?.source === Track.Source.ScreenShareAudio
      ? audioPublish.promise : Promise.resolve());
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('stop-publishing-audio');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      await vi.waitFor(() => expect(rtcMocks.published.mock.calls.some(call => call[1]?.source === Track.Source.ScreenShareAudio)).toBe(true));
      const audioTrack = rtcMocks.published.mock.calls.find(call => call[1]?.source === Track.Source.ScreenShareAudio)![0];
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      audioPublish.resolve();
      await vi.waitFor(() => expect(rtcMocks.unpublishing).toHaveBeenCalledWith(audioTrack, true));
      await vi.waitFor(() => expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined());
      const grantedSids = rtcMocks.subscriptionPermissions.flatMap(entry =>
        (entry.permissions as Array<{ allowedTrackSids: string[] }>).flatMap(permission => permission.allowedTrackSids));
      expect(grantedSids).not.toContain('track-3');
      expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce();
    } finally { audioPublish.resolve(); await rtc.leave(); scope.stop(); }
  });

  it('房间拥有唯一混音上下文，离房失败也释放，再入房使用新上下文', async () => {
    configureNativeMicrophoneDesktop();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('playback-context')).toBe(true);
      const context = rtc.playbackContext.value!;
      expect(context).not.toBeNull();
      vi.spyOn(mockRoom(), 'disconnect').mockRejectedValueOnce(new Error('disconnect failed'));
      await expect(rtc.leave()).rejects.toThrow('disconnect failed');
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(rtc.playbackContext.value).toBeNull();
      expect(await rtc.join('next-playback-context')).toBe(true);
      expect(rtc.playbackContext.value).not.toBe(context);
    } finally { await rtc.leave(); scope.stop(); }
  });

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
      await waitForSharedAudio();
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
      expect(rtc.notice.value).toContain('仅共享画面');
      expect(rtcMocks.startupTiming).toHaveBeenLastCalledWith('window:test:0-session', 'screenAudioStartup', expect.any(Number),
        stage === 'capture' ? { outcome: 'failed', phase: 'capture' } : {
          outcome: 'failed', phase: 'publish', pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: 20, publishMs: expect.any(Number),
        });
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(true);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeDefined();
    } finally {
      await rtc.leave();
      scope.stop();
    }
  });

  it('声音等待发布时不记成功，实际发布完成后才合并启动摘要', async () => {
    configureNativeScreenDesktop();
    const publication = deferred<void>();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      await rtc.join('audio-startup-summary');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      rtcMocks.published.mockImplementation((_track, options) => options?.source === Track.Source.ScreenShareAudio
        ? publication.promise : Promise.resolve());
      const enabling = rtc.setScreenShareAudioEnabled(true);
      await vi.waitFor(() => expect(rtcMocks.published.mock.calls.some(call => call[1]?.source === Track.Source.ScreenShareAudio)).toBe(true));
      expect(rtcMocks.startupTiming.mock.calls.filter(call => call[1] === 'screenAudioStartup')).toHaveLength(0);
      publication.resolve();
      expect(await enabling).toBe(true);
      expect(rtcMocks.startupTiming.mock.calls.filter(call => call[1] === 'screenAudioStartup')).toEqual([
        ['window:test:0-session', 'screenAudioStartup', expect.any(Number), {
          outcome: 'published', phase: 'publish', pluginLoadMs: 12, captureReadyMs: 340, graphReadyMs: 20, publishMs: expect.any(Number),
        }],
      ]);
    } finally { publication.resolve(); await rtc.leave(); scope.stop(); }
  });

  it('声音启动不阻挡画质切换，拒绝重复声音操作且离房后不发布迟到结果', async () => {
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
      expect(rtc.busySources.value).not.toContain(Track.Source.ScreenShare);
      expect(await rtc.setScreenShareAudioEnabled(false)).toBe(false);
      expect(await rtc.setScreenShareQuality('custom')).toBe(true);
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
      await waitForSharedAudio();
      const audio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      receiveRemoteControl('viewer', { type: 'request', requestId: 'request' });
      expect(await beginRemoteControlApproval(rtc, 'viewer')).toBe(true);
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

      rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:2:0', shareAudio: true, quality: 'custom',
        customQuality: { resolution: 1080, fps: 30 } });
      expect(await rtc.changeScreenShareSource()).toBe(true);
      expect(rtcMocks.nativeStarts).toHaveBeenLastCalledWith('window:2:0', 30, expect.anything(), { width: 1920, height: 1080 });
      expect(rtcMocks.nativeAudioStarts).toHaveBeenLastCalledWith('window:2:0', 'window:2:0-session');
      expect(rtc.currentScreenShareQuality.value).toBe('custom');
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
      await waitForSharedAudio();
      const publishCount = rtcMocks.published.mock.calls.length;
      expect(await rtc.setScreenShareQuality('economy')).toBe(true);
      expect(rtc.currentScreenShareQuality.value).toBe('economy');
      const custom: CustomScreenShareQuality = { resolution: 1440, fps: 120 };
      expect(await rtc.setScreenShareQuality('custom', custom)).toBe(true);
      custom.fps = 30;
      expect(rtc.currentCustomScreenShareQuality.value).toEqual({ resolution: 1440, fps: 120 });
      expect(await rtc.setScreenShareQuality('custom', { resolution: 720, fps: 120 })).toBe(true);
      expect(rtcMocks.nativeConfigured).toHaveBeenLastCalledWith('custom', { resolution: 720, fps: 120 });
      expect(rtc.currentCustomScreenShareQuality.value).toEqual({ resolution: 720, fps: 120 });
      expect(await rtc.setScreenShareQuality('custom', { resolution: 720, fps: 120 })).toBe(false);
      expect(await rtc.setScreenShareQuality('custom', { resolution: 720, fps: 120, bitrateMbps: 6 })).toBe(true);
      expect(rtc.currentCustomScreenShareQuality.value.bitrateMbps).toBe(6);
      rtcMocks.nativeConfigured.mockRejectedValueOnce(new Error('bitrate rejected'));
      expect(await rtc.setScreenShareQuality('custom', { resolution: 720, fps: 120, bitrateMbps: 10 })).toBe(false);
      expect(rtc.currentCustomScreenShareQuality.value.bitrateMbps).toBe(6);
      expect(await rtc.setScreenShareQuality('custom', { resolution: 720, fps: 120 })).toBe(true);
      expect(rtc.currentCustomScreenShareQuality.value).not.toHaveProperty('bitrateMbps');
      expect(await rtc.setScreenShareQuality('economy')).toBe(true);
      expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBe(publication);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeAudioStarts).toHaveBeenCalledOnce();
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      expect(rtcMocks.nativeAudioStops).not.toHaveBeenCalled();
      expect(rtcMocks.published).toHaveBeenCalledTimes(publishCount);
      rtcMocks.nativeConfigured.mockRejectedValueOnce(new Error('configure failed'));
      expect(await rtc.setScreenShareQuality('custom')).toBe(false);
      expect(rtc.currentScreenShareQuality.value).toBe('economy');
      expect(rtc.currentCustomScreenShareQuality.value).toEqual({ resolution: 720, fps: 120 });
      expect(rtc.notice.value).toContain('保留原画质');
      const pending = deferred<void>();
      rtcMocks.nativeConfigured.mockReturnValueOnce(pending.promise);
      const changing = rtc.setScreenShareQuality('highFrameRate');
      expect(rtc.screenShareQualityBusy.value).toBe(true);
      expect(await rtc.setScreenShareQuality('custom')).toBe(false);
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
    { quality: 'custom', fps: 60, bitrate: 12_000_000, degradation: 'maintain-framerate' },
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
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:test:0', fps, { hideCursor: false, hideBorder: false },
        { width: quality === 'economy' ? 1280 : 1920, height: quality === 'economy' ? 720 : 1080 });
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

  it('选择器手动码率贯通首次原生启动与 WebRTC 发布，尺寸帧率仍采用自定义值', async () => {
    configureNativeScreenDesktop();
    const customQuality = { resolution: 1440, fps: 120, bitrateMbps: 6 } as const;
    rtcMocks.selectedSources.mockResolvedValueOnce({ sourceId: 'window:test:0', shareAudio: false, quality: 'custom', customQuality });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom({ inputGain: 1,
      processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: false },
      events: { selectNativeScreenSource: rtcMocks.selectedSources },
    }))!;
    try {
      expect(await rtc.join('manual-bitrate-room')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:test:0', 120, expect.anything(), { width: 2560, height: 1440 });
      expect(rtcMocks.published).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        source: Track.Source.ScreenShare,
        screenShareEncoding: expect.objectContaining({ maxBitrate: 6_000_000, maxFramerate: 120 }),
      }));
      expect(rtc.currentCustomScreenShareQuality.value).toEqual(customQuality);
    } finally { await rtc.leave(); scope.stop(); }
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
      await waitForSharedAudio();
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
        if (source === Track.Source.ScreenShare) await waitForSharedAudio();
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

  it.each([true, false])('未共享时接受后自动开屏，公开=%s，临时共享结束即回收且不影响语音', async (publicVideo) => {
    configureNativeScreenDesktop();
    const authorize = vi.fn().mockResolvedValue({ changed: true });
    const revoke = vi.fn().mockResolvedValue({ changed: true });
    Object.assign(window.lycanDesktop!, { authorizeNativeRemoteControl: authorize, revokeNativeRemoteControl: revoke });
    addRemoteParticipant('viewer-a');
    addRemoteParticipant('bystander');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('automatic-control');
      const microphone = mockRoom().localParticipant.getTrackPublication(Track.Source.Microphone);
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'control-request' });
      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
      const approving = rtc.allowRemoteControl('monitor:1:0', publicVideo);
      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
      receiveRemoteControl('viewer-a', { type: 'controllerReady', requestId: 'control-request' });
      expect(await approving).toBe(true);
      const video = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare) as { trackSid: string; track: unknown };
      const permissions = rtcMocks.subscriptionPermissions.at(-1)!;
      expect(permissions.allowAll).toBe(false);
      const allowed = (identity: string) => (permissions.permissions as Array<{ participantIdentity: string; allowedTrackSids: string[] }>)
        .find(entry => entry.participantIdentity === identity)!.allowedTrackSids;
      expect(allowed('viewer-a')).toContain(video.trackSid);
      expect(allowed('bystander').includes(video.trackSid)).toBe(publicVideo);
      mockRoom().emit('localTrackPublished', { ...video, trackSid: 'republished-control-video', source: Track.Source.ScreenShare });
      const newcomer = addRemoteParticipant('newcomer');
      mockRoom().emit('participantConnected', newcomer);
      const republished = rtcMocks.subscriptionPermissions.at(-1)!.permissions as Array<{ participantIdentity: string; allowedTrackSids: string[] }>;
      expect(republished.find(entry => entry.participantIdentity === 'viewer-a')!.allowedTrackSids).toContain('republished-control-video');
      expect(republished.find(entry => entry.participantIdentity === 'newcomer')!.allowedTrackSids.includes('republished-control-video')).toBe(publicVideo);
      expect(rtcMocks.nativeAudioStarts).not.toHaveBeenCalled();
      expect(await rtc.setScreenShareAudioEnabled(true)).toBe(false);
      expect(rtc.remoteControlOwner.value).toMatchObject({ identity: 'viewer-a', public: publicVideo });
      expect(rtc.screenShareAudioRestricted.value).toBe(true);
      if (!publicVideo) {
        expect(await rtc.changeScreenShareSource()).toBe(false);
        expect(rtc.notice.value).toContain('先停止控制');
      }
      expect(await rtc.revokeRemoteControl()).toBe(true);
      expect(rtcMocks.nativeStops).toHaveBeenCalledExactlyOnceWith('monitor:1:0-session');
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeUndefined();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.Microphone)).toBe(microphone);
      expect(rtc.listening.value).toBe(true);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it.each([true, false])('自动整屏启动中取消，公开=%s，迟到采集不得发布或授权', async (publicVideo) => {
    configureNativeScreenDesktop();
    const start = deferred<{ sessionId: string }>();
    rtcMocks.nativeStarts.mockReturnValueOnce(start.promise);
    const authorize = vi.fn().mockResolvedValue({ changed: true });
    Object.assign(window.lycanDesktop!, { authorizeNativeRemoteControl: authorize });
    addRemoteParticipant('viewer-a');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('cancel-before-video-start');
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'late-capture' });
      const approving = rtc.allowRemoteControl('monitor:1:0', publicVideo);
      receiveRemoteControl('viewer-a', { type: 'controllerReady', requestId: 'late-capture' });
      await vi.waitFor(() => expect(rtcMocks.nativeStarts).toHaveBeenCalledOnce());
      await rtc.rejectRemoteControl();
      start.resolve({ sessionId: 'cancelled-capture' });
      expect(await approving).toBe(false);
      expect(rtcMocks.published.mock.calls.filter(call => call[1]?.source === Track.Source.ScreenShare)).toHaveLength(0);
      expect(authorize).not.toHaveBeenCalled();
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('cancelled-capture');
      expect(rtc.screenShareActive.value).toBe(false);
    } finally { start.resolve({ sessionId: 'cancelled-capture' }); await rtc.leave(); scope.stop(); }
  });

  it('恢复原共享的采集中主动停止，不发布迟到轨道或重新开启共享', async () => {
    configureNativeScreenDesktop();
    addRemoteParticipant('owner-a');
    const start = deferred<{ sessionId: string }>();
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('cancel-restore-start');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true, { sourceId: 'window:test:0', shareAudio: false });
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: null, control: null });
      await rtc.requestRemoteControl('owner-a');
      const pending = rtc.remoteControlPending.value!;
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'owner-video', requestId: pending.requestId,
        shareSessionId: 'owner-share', controlSessionId: 'owner-control' });
      rtcMocks.nativeStarts.mockReturnValueOnce(start.promise);
      const exiting = rtc.exitRemoteControl();
      await vi.waitFor(() => expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(2));
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      start.resolve({ sessionId: 'cancelled-restore' });
      await exiting;
      expect(rtcMocks.published.mock.calls.filter(call => call[1]?.source === Track.Source.ScreenShare)).toHaveLength(1);
      expect(rtc.screenShareActive.value).toBe(false);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('cancelled-restore');
    } finally { start.resolve({ sessionId: 'cancelled-restore' }); await rtc.leave(); scope.stop(); }
  });

  it('远控画面等待发布时取消，迟到 SID 不获得订阅权限且只清理本次采集', async () => {
    configureNativeScreenDesktop();
    const publication = deferred<void>();
    rtcMocks.published.mockImplementation((_track, options) => options?.source === Track.Source.ScreenShare
      ? publication.promise : Promise.resolve());
    const authorize = vi.fn();
    Object.assign(window.lycanDesktop!, { authorizeNativeRemoteControl: authorize });
    addRemoteParticipant('viewer-a'); addRemoteParticipant('bystander');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('cancel-pending-screen-publish');
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'pending-publish' });
      const approving = beginRemoteControlApproval(rtc);
      await vi.waitFor(() => expect(rtcMocks.published.mock.calls
        .filter(call => call[1]?.source === Track.Source.ScreenShare)).toHaveLength(1));
      await rtc.rejectRemoteControl();
      publication.resolve();
      expect(await approving).toBe(false);
      expect(authorize).not.toHaveBeenCalled();
      expect(rtcMocks.subscriptionPermissions.every(entry => (entry.permissions as Array<{ allowedTrackSids: string[] }>)
        .every(permission => !permission.allowedTrackSids.includes('track-2')))).toBe(true);
      expect(rtcMocks.nativeStops).toHaveBeenCalledExactlyOnceWith('monitor:1:0-session');
      expect(rtc.screenShareActive.value).toBe(false);
    } finally { publication.resolve(); await rtc.leave(); scope.stop(); }
  });

  it('私密控制替换旧公开窗口，撤销后恢复原来源、画质与声音，而不是放宽私密 SID', async () => {
    configureNativeScreenDesktop({ screenAudio: true });
    let sequence = 0;
    rtcMocks.nativeStarts.mockImplementation(async (sourceId: string) => ({ sessionId: `${sourceId}-${++sequence}` }));
    Object.assign(window.lycanDesktop!, {
      authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      revokeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
    });
    addRemoteParticipant('viewer-a'); addRemoteParticipant('bystander');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('restore-original');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true, { sourceId: 'window:test:0', shareAudio: true,
        quality: 'custom', customQuality: { resolution: 720, fps: 30, bitrateMbps: 4 } });
      await waitForSharedAudio();
      const original = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare);
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'replace' });
      expect(await beginRemoteControlApproval(rtc, 'viewer-a', false)).toBe(true);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('window:test:0-1');
      const privateVideo = mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare) as { trackSid: string };
      expect(privateVideo).not.toBe(original);
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
      expect(await rtc.revokeRemoteControl()).toBe(true);
      await waitForSharedAudio();
      expect(rtcMocks.nativeStarts.mock.calls.map(call => call[0])).toEqual(['window:test:0', 'monitor:1:0', 'window:test:0']);
      expect(rtcMocks.nativeStarts).toHaveBeenLastCalledWith('window:test:0', 30, expect.anything(), { width: 1280, height: 720 });
      expect(rtc.currentScreenShareQuality.value).toBe('custom');
      const last = rtcMocks.subscriptionPermissions.at(-1)!.permissions as Array<{ allowedTrackSids: string[] }>;
      expect(last.every(entry => !entry.allowedTrackSids.includes(privateVideo.trackSid))).toBe(true);
      expect(rtcMocks.nativeAudioStarts).toHaveBeenLastCalledWith('window:test:0', 'window:test:0-3');
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('原生撤销失败时不恢复原共享，拒绝输入并阻止新授权；确认清理后才恢复', async () => {
    configureNativeScreenDesktop();
    const revoke = vi.fn().mockRejectedValueOnce(new Error('nativeReleaseFailed')).mockResolvedValue({ changed: true });
    const input = vi.fn();
    Object.assign(window.lycanDesktop!, {
      authorizeNativeRemoteControl: vi.fn().mockResolvedValue({ changed: true }),
      revokeNativeRemoteControl: revoke, sendNativeRemoteInput: input,
    });
    addRemoteParticipant('viewer-a'); addRemoteParticipant('other');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('cleanup-before-restore');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true, { sourceId: 'window:test:0', shareAudio: false });
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'private-control' });
      expect(await beginRemoteControlApproval(rtc, 'viewer-a', false)).toBe(true);
      const control = rtc.remoteControlOwner.value!;
      expect(await rtc.revokeRemoteControl()).toBe(false);
      expect(rtc.remoteControlCleanupPending.value).toBe(true);
      expect(rtc.notice.value).toContain('尚未释放');
      receiveRemoteControl('viewer-a', { type: 'input', shareSessionId: 'monitor:1:0-session',
        controlSessionId: control.controlSessionId, sequence: 1, input: { kind: 'keyDown', key: 'letterA' } });
      receiveRemoteControl('other', { type: 'request', requestId: 'must-deny' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(input).not.toHaveBeenCalled();
      expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(2);
      expect(await rtc.retryRemoteControlCleanup()).toBe(true);
      expect(rtc.remoteControlCleanupPending.value).toBe(false);
      expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(3);
      expect(rtcMocks.nativeStarts.mock.calls.at(-1)![0]).toBe('window:test:0');
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('控制方接受前保留自己的共享，接受后暂停，正常退出恢复；主动停止后不再自动恢复', async () => {
    configureNativeScreenDesktop();
    addRemoteParticipant('owner-a');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('controller-restore');
      const captureSettings = { hideCursor: true, hideBorder: false, windowMethod: 'wgc' as const };
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true, { sourceId: 'window:test:0', shareAudio: false, captureSettings });
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: null, control: null });
      await rtc.requestRemoteControl('owner-a');
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      const request = rtc.remoteControlPending.value!;
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', requestId: request.requestId,
        shareSessionId: 'target-screen', controlSessionId: 'first-control' });
      expect(rtcMocks.nativeStops).toHaveBeenCalledOnce();
      expect(rtc.screenShareActive.value).toBe(false);
      await rtc.exitRemoteControl();
      expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(2);
      expect(rtcMocks.nativeStarts).toHaveBeenLastCalledWith('window:test:0', 60, captureSettings,
        { width: 1920, height: 1080 });
      expect(rtc.screenShareActive.value).toBe(true);
      await rtc.requestRemoteControl('owner-a');
      const next = rtc.remoteControlPending.value!;
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', requestId: next.requestId,
        shareSessionId: 'next-screen', controlSessionId: 'second-control' });
      await rtc.setMediaEnabled(Track.Source.ScreenShare, false);
      await rtc.exitRemoteControl();
      expect(rtcMocks.nativeStarts).toHaveBeenCalledTimes(2);
      expect(rtc.screenShareActive.value).toBe(false);
      expect(rtc.listening.value).toBe(true);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('拒绝失效显示器不新建采集，授权 IPC 失败也必须确认撤销', async () => {
    configureNativeScreenDesktop();
    const revoke = vi.fn().mockResolvedValue({ changed: true });
    Object.assign(window.lycanDesktop!, {
      authorizeNativeRemoteControl: vi.fn().mockRejectedValue(new Error('ipcTimeout')),
      revokeNativeRemoteControl: revoke,
    });
    addRemoteParticipant('viewer-a');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('invalid-monitor');
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'expired' });
      const invalid = rtc.allowRemoteControl('monitor:expired:0', false);
      receiveRemoteControl('viewer-a', { type: 'controllerReady', requestId: 'expired' });
      expect(await invalid).toBe(false);
      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'ipc-failed' });
      expect(await beginRemoteControlApproval(rtc)).toBe(false);
      expect(revoke).toHaveBeenCalledOnce();
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(rtc.screenShareActive.value).toBe(false);
    } finally { await rtc.leave(); scope.stop(); }
  });

  it('入房查询当前远控能力，不要求对方已经共享整屏，忽略外房成员消息', async () => {
    configureNativeMicrophoneDesktop();
    addRemoteParticipant('owner-a');
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      expect(await rtc.join('remote-control-query')).toBe(true);
      expect(rtcMocks.sentPackets.some(({ payload }) =>
        JSON.parse(new TextDecoder().decode(payload)).type === 'queryState')).toBe(true);
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: null, control: null });
      expect(rtc.remoteControlAvailable.value['owner-a']).toBe(true);
      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      receiveRemoteControl('outsider', { type: 'state', available: true, share: null, control: null });
      expect(rtc.remoteControlAvailable.value['outsider']).toBeUndefined();
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
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: { shareSessionId: 'share-a', kind: 'monitor' }, control: null});
      expect(rtc.remoteControlShares.value['owner-a']).toEqual({ shareSessionId: 'share-a', kind: 'monitor' });

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      const firstRequest = rtc.remoteControlPending.value!;
      await rtc.cancelPendingRemoteControl('owner-a');
      await rtc.cancelPendingRemoteControl('owner-a');
      expect(rtc.remoteControlPending.value).toBeNull();
      expect(rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'cancel')).toHaveLength(1);
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', shareSessionId: 'share-a',
        requestId: firstRequest.requestId, controlSessionId: 'late-control' });
      expect(rtc.remoteControlActive.value).toBeNull();

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      const nextRequest = rtc.remoteControlPending.value!;
      expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', shareSessionId: 'share-a',
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
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: { shareSessionId: 'share-a', kind: 'monitor' }, control: null});
      await rtc.requestRemoteControl('owner-a');
      const request = rtc.remoteControlPending.value!;
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', shareSessionId: 'share-a',
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
      const owner = addRemoteParticipant('owner-a', true);
      expect(owner).toBeTruthy();
      receiveRemoteControl('owner-a', { type: 'state', available: true, share: { shareSessionId: 'share-a', kind: 'monitor' }, control: null});
      receiveRemoteControl('owner-b', { type: 'state', available: true, share: { shareSessionId: 'share-b', kind: 'monitor'  }, control: null});

      expect(await rtc.requestRemoteControl('owner-a')).toBe(true);
      expect(await rtc.requestRemoteControl('owner-b')).toBe(false);
      const request = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .reverse().find((message) => message.type === 'request');
      await deliverControlGrant(rtc, 'owner-a', { type: 'allow', trackSid: 'target-video', shareSessionId: 'share-a', requestId: request.requestId, controlSessionId: 'control-a' });
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
      await deliverControlGrant(rtc, 'owner-b', { type: 'allow', trackSid: 'target-video', shareSessionId: 'share-b',
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-a' });
      expect(rtc.remoteControlRequest.value?.identity).toBe('viewer-a');
      const room = mockRoom();
      room.remoteParticipants.delete('viewer-a');
      room.emit('participantDisconnected', { identity: 'viewer-a' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      receiveRemoteControl('viewer-b', { type: 'request', requestId: 'request-b' });
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-a' });
      const allowing = beginRemoteControlApproval(rtc);
      await vi.waitFor(() => expect(authorizeNative).toHaveBeenCalledTimes(1));
      expect(rtc.remoteControlGranting.value).toBe(true);
      receiveRemoteControl('viewer-a', { type: 'cancel', requestId: 'request-a' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      authorization.resolve({ changed: true });

      expect(await allowing).toBe(false);
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(revokeNative).toHaveBeenCalledTimes(1);
      receiveRemoteControl('viewer-b', { type: 'request', requestId: 'request-b' });
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-a' });
      const oldAllow = beginRemoteControlApproval(rtc);
      await vi.waitFor(() => expect(authorizeNative).toHaveBeenCalledTimes(1));
      await rtc.leave();

      expect(await rtc.join('remote-owner-room-b')).toBe(true);
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();

      oldAuthorization.resolve({ changed: true });
      expect(await oldAllow).toBe(false);
      expect(rtcMocks.nativeStops).toHaveBeenCalledWith('share-a');
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(mockRoom().localParticipant.getTrackPublication(Track.Source.ScreenShare)).toBeTruthy();

      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-b2' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-a', requestId: 'request-b2' });
      expect(await beginRemoteControlApproval(rtc)).toBe(true);
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'allow-request' });

      expect(await beginRemoteControlApproval(rtc)).toBe(false);
      expect(authorizeNative).toHaveBeenCalledTimes(1);
      expect(revokeNative).toHaveBeenCalledWith('allow-failure-share', expect.any(String));
      expect(rtc.remoteControlOwner.value).toBeNull();
      expect(rtc.remoteControlRequest.value).toBeNull();
      expect(rtc.remoteControlCleanupPending.value).toBe(false);

      receiveRemoteControl('viewer-b', { type: 'request', requestId: 'next-request' });
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      receiveRemoteControl('viewer-a', { type: 'request', requestId: 'request-a' });
      receiveRemoteControl('viewer-b', { type: 'request', requestId: 'request-b' });
      expect(rtc.remoteControlRequest.value).toEqual({ identity: 'viewer-a', requestId: 'request-a' });
      await beginRemoteControlApproval(rtc);
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

      receiveRemoteControl('viewer-a', { type: 'revoke', shareSessionId: 'stale-share',
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
      receiveRemoteControl('owner-c', { type: 'state', available: true, share: { shareSessionId: 'other-share', kind: 'monitor'  }, control: null});
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
        expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('monitor:1:0', 60, { hideCursor: false, hideBorder: false }, { width: 1920, height: 1080 });
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      await waitForSharedAudio();
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
      await vi.waitFor(() => expect(rtcMocks.nativeAudioStops).toHaveBeenCalledOnce());
      expect(rtcMocks.nativeStops).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(rtc.notice.value).toContain('仅共享画面'));
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      await vi.waitFor(() => expect(rtc.notice.value).toContain('仅共享画面'));
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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
      await waitForSharedAudio();
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
        recordScreenShareStartupTiming: rtcMocks.startupTiming,
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

  it.each([
    ['obsCaptureGameDetectionFailed', '无法确认所选程序的共享方式'],
    ['obsGameBindingUnavailable', '游戏采集组件版本不匹配'],
    ['obsGameTargetMismatch', '游戏绘制窗口与所选窗口不符'],
  ])('游戏采集错误 %s 展示可操作提示，不发布画面', async (code, message) => {
    rtcMocks.token.mockResolvedValue({ serverUrl: 'wss://example.test', token: 'test-token' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { lycanDesktop: {
        getNativeMediaCapabilities: async () => ({ videoCapture: { available: false, reason: code } }),
        listNativeVideoSources: vi.fn(), startNativeVideo: rtcMocks.nativeStarts, stopNativeVideo: rtcMocks.nativeStops,
      } },
    });
    const scope = effectScope();
    const rtc = scope.run(() => useRtcRoom())!;
    try {
      await rtc.join('group-2');
      await rtc.setMediaEnabled(Track.Source.ScreenShare, true);
      expect(rtc.notice.value).toContain(message);
      expect(rtcMocks.published).not.toHaveBeenCalled();
      expect(rtcMocks.nativeStarts).not.toHaveBeenCalled();
    } finally { scope.stop(); }
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
      expect(rtcMocks.nativeStarts).toHaveBeenCalledWith('window:room-b:0', 60, { hideCursor: false, hideBorder: false }, { width: 1920, height: 1080 });
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
        .filter((message) => message.type === 'state' && message.share);
      expect(packetsBeforeOldPublish).toHaveLength(1);
      const roomAPermissionsBeforeLatePublish = rtcMocks.subscriptionPermissions
        .filter((entry) => entry.room === roomA).length;

      delayedPublish.resolve(undefined);
      await oldTask;
      expect(rtcMocks.subscriptionPermissions.filter((entry) => entry.room === roomA))
        .toHaveLength(roomAPermissionsBeforeLatePublish);
      const sharePackets = rtcMocks.sentPackets.map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)))
        .filter((message) => message.type === 'state' && message.share);
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

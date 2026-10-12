interface DetectedActivity {
  type: 'GAME';
  name: string;
  startedAt: string;
}

interface NativeVideoSource {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
  width: number;
  height: number;
  primary: boolean;
  monitorOrigin?: { x: number; y: number };
}

interface NativeCaptureDiagnostics {
  state: 'idle' | 'starting' | 'running' | 'stopping';
  sessionId: string | null;
  available: boolean;
  sourceKind: 'monitor' | 'window' | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesReceived: number | null;
  framesProcessed: number | null;
  droppedNotifications: number | null;
  rawCaptureFps: number | null;
  probeProcessedFps: number | null;
  videoOutputFps: number | null;
  videoOutputDroppedFrames: number | null;
  rawFrameIntervalP50Ms: number | null;
  rawFrameIntervalP95Ms: number | null;
  rawFrameIntervalP99Ms: number | null;
  rawTimestampAnomalies: number | null;
  lastFrameAgeMs: number | null;
  sizeChanges: number | null;
  framePoolRecreates: number | null;
  lastCaptureError: string | null;
  stopDurationMs: number | null;
  captureSuspended: boolean | null;
  microphoneCaptureDroppedChunks: number;
  screenShareAudio: {
    state: 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
    sessionId: string | null;
    sourceKind: 'monitor' | 'window' | null;
    sampleRate: number | null;
    channels: number | null;
    packetsReceived: number | null;
    framesReceived: number | null;
    silentPackets: number | null;
    droppedAudioChunks: number | null;
    lastError: string | null;
  };
}

interface NativeScreenAudioChunk {
  sessionId: string;
  sequence: number;
  frames: number;
  sampleRate: number;
  channels: 2;
  pcm: Uint8Array;
}

interface NativeMicrophoneChunk {
  sessionId: string;
  sequence: number;
  frames: number;
  sampleRate: number;
  channels: 1;
  pcm: Uint8Array;
}

interface StartupUpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'ready';
  version: string;
  supported: boolean;
  message: string;
  nextVersion?: string;
  percent?: number;
  error?: boolean;
}

interface Window {
  lycanDesktop?: {
    copyText(text: string): Promise<void>;
    runStartupUpdate(): Promise<StartupUpdateState>;
    getUpdateState(): Promise<StartupUpdateState>;
    skipStartupUpdate(): Promise<void>;
    onUpdateState(callback: (state: StartupUpdateState) => void): () => void;
    clearSession(): Promise<void>;
    getAccessLink(): Promise<import('./auth/accountAccess').AccessOffer | null>;
    prepareAccessLink(offer: import('./auth/accountAccess').AccessOffer): Promise<void>;
    onAccessLink(callback: (offer: import('./auth/accountAccess').AccessOffer) => void): () => void;
    getServerSettings(): Promise<{ apiUrl: string; editable: boolean }>;
    setServerAddress(value: string): Promise<void>;
    minimize(): void;
    isMaximized(): Promise<boolean>;
    getProcessMetrics(): Promise<{ cpuPercent: number; memoryMb: number }>;
    getSystemIdleState(): Promise<{ state: 'active' | 'idle' | 'locked' | 'unknown'; idleSeconds: number }>;
    getAutoStart(): Promise<{ supported: boolean; enabled: boolean }>;
    setAutoStart(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;
    getCurrentActivity(): Promise<DetectedActivity | null>;
    getNativeMediaCapabilities(): Promise<Record<string, { available: boolean; reason: string }>>;
    listNativeVideoSources(): Promise<{ revision: number; discoveryId: string; sources: NativeVideoSource[] }>;
    getNativeVideoSourceThumbnails(sources: NativeVideoSource[]): Promise<{ sourceId: string; thumbnail: string }[]>;
    startNativeCaptureProbe(sourceId: string): Promise<{ sessionId: string; changed: boolean }>;
    stopNativeCaptureProbe(sessionId: string): Promise<{ changed: boolean }>;
    getScreenShareSupport(): Promise<{ hideCursor: boolean; hideBorder: boolean }>;
    startNativeVideo(sourceId: string, maxFps: number, settings: { hideCursor: boolean; hideBorder: boolean }): Promise<{ sessionId: string; changed: boolean }>;
    stopNativeVideo(sessionId: string): Promise<{ changed: boolean }>;
    configureNativeVideo(sessionId: string, maxFps: number): Promise<{ changed: boolean }>;
    authorizeNativeRemoteControl(sessionId: string, controlSessionId: string, controllerIdentity: string): Promise<{ changed: boolean }>;
    sendNativeRemoteInput(sessionId: string, controlSessionId: string, controllerIdentity: string, sequence: number,
      input: import('./rtc/remoteControl').RemoteControlInput): Promise<{ changed: boolean; dropped?: boolean }>;
    revokeNativeRemoteControl(sessionId: string, controlSessionId: string): Promise<{ changed: boolean }>;
    onNativeVideoError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
    onNativeVideoSuspended(callback: (status: { sessionId: string; suspended: boolean }) => void): () => void;
    startNativeScreenAudio(sourceId: string, sessionId: string): Promise<{
      sampleRate: number; channels: 2; bitsPerSample: 32; nominalChunkMs: 10;
    }>;
    stopNativeScreenAudio(sessionId: string): Promise<{ changed: boolean }>;
    onNativeScreenAudioChunk(callback: (chunk: NativeScreenAudioChunk) => void): () => void;
    acknowledgeNativeScreenAudioChunk(sessionId: string, sequence: number, droppedChunks: number): void;
    onNativeScreenAudioError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
    startNativeMicrophone(sessionId: string, settings: import('./rtc/nativeMicrophoneAudio').NativeMicrophoneSettings): Promise<{
      sampleRate: 48000; channels: 1; bitsPerSample: 32; nominalChunkMs: 10;
    }>;
    configureNativeMicrophone(sessionId: string, settings: import('./rtc/nativeMicrophoneAudio').NativeMicrophoneSettings): Promise<{ changed: boolean }>;
    stopNativeMicrophone(sessionId: string): Promise<{ changed: boolean }>;
    onNativeMicrophoneChunk(callback: (chunk: NativeMicrophoneChunk) => void): () => void;
    acknowledgeNativeMicrophoneChunk(sessionId: string, sequence: number, droppedChunks: number): void;
    onNativeMicrophoneError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
    getNativeMediaDiagnostics(): Promise<NativeCaptureDiagnostics>;
    onActivityChange(callback: (activity: DetectedActivity | null) => void): () => void;
    toggleMaximize(): void;
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
    close(): void;
    finishClose(): void;
    openExternal(url: string): Promise<void>;
    onClose(callback: () => void): () => void;
  };
}

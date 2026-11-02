interface RecordingSettings {
  directory: string;
  applicationAudio: boolean;
  microphone: boolean;
  friends: boolean;
  replaySeconds: 30 | 60 | 120;
  videoHeight: 720 | 1080 | 1440;
  videoFps: 30 | 60 | 120;
}
interface DesktopRecordingStatus {
  holdingResources: boolean;
  phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'saved' | 'failed';
  recordingId: string | null;
  startedAt: number | null;
  bytes: number;
  error: string | null;
  saved: boolean;
  continuing: boolean;
  applicationAudio: boolean;
  mediaId?: string | null;
  mediaVoices?: boolean;
  replay?: {
    id: string | null;
    holdingResources: boolean;
    phase: 'idle' | 'starting' | 'buffering' | 'stopping' | 'failed';
    seconds: number;
    saving: boolean;
    error: string | null;
    lastSavedId: string | null;
    warming?: boolean;
    lastSavedDuringWarmup?: boolean;
  };
}
interface RecordingLibraryEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  bytes: number;
  state: 'recording' | 'saved' | 'interrupted';
  availability: 'available' | 'missing' | 'changed' | 'unavailable';
}

interface DesktopProcessMetrics {
  cpuPercent: number;
  memoryMb: number;
  entries: { role: 'electron-Browser' | 'electron-Tab' | 'electron-GPU' | 'electron-Utility' | 'electron-other'
    | 'obs' | 'obs-audio' | 'media' | 'activity'; state: 'running' | 'stopped' | 'unavailable';
    workingSetMiB: number | null; privateCommitMiB: number | null }[];
}

interface DetectedActivity {
  type: 'GAME' | 'MUSIC';
  name: string;
  startedAt: string;
}

interface ActivityMapping {
  executable: string;
  name: string;
}

interface ActivityWindow {
  executable: string;
  title: string;
}

interface NativeVideoSource {
  sourceId: string;
  kind: 'monitor' | 'window';
  title: string;
  width: number;
  height: number;
  primary: boolean;
  windowId?: string;
  monitorOrigin?: { x: number; y: number };
}

interface ObsRenderDiagnostics {
  configuration: number;
  elapsedMs: number;
  totalFrames: number;
  laggedFrames: number;
  activeFps: number | null;
  averageRenderMs: number | null;
}

interface NativeCaptureDiagnostics {
  helperVersion: string;
  captureBackend: 'obsLibobs' | null;
  state: 'idle' | 'starting' | 'running' | 'stopping';
  sessionId: string | null;
  available: boolean;
  sourceKind: 'monitor' | 'window' | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesReceived: number | null;
  framesProcessed: number | null;
  obsBridgeDroppedFrames: number | null;
  obsRender: ObsRenderDiagnostics | null;
  recording?: Pick<DesktopRecordingStatus, 'phase' | 'holdingResources'> & { applicationAudio: boolean; microphone: boolean; friends: boolean;
    replay?: Pick<NonNullable<DesktopRecordingStatus['replay']>, 'phase' | 'holdingResources' | 'saving'> };
  captureSuspended: boolean | null;
  microphoneCaptureDroppedChunks: number | null;
  microphoneCapture?: { sourceState: number; sourceFrames: number; framesReceived: number;
    pushToTalk?: boolean; transmissionAllowed?: boolean } | null;
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
  transmissionEpoch: number;
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
  lycanAudioShortcuts?: {
    begin(): Promise<string>;
    configure(owner: string, bindings: import('./settings/useAudioShortcuts').AudioShortcutBindings, pushToTalk: boolean): Promise<void>;
    readHold(owner: string, roomId: string, sequence: number): Promise<boolean>;
    onHold(callback: (event: { owner: string; roomId: string; sequence: number; held: boolean }) => void): () => void;
    activate(owner: string, roomId: string | null): Promise<void>;
    capture(owner: string, enabled: boolean): Promise<void>;
    end(owner: string): Promise<void>;
    onAction(callback: (event: { owner: string; roomId: string | null; action: 'microphone' | 'listening' | 'replay'; replayId?: string }) => void): () => void;
    onError(callback: (event: { owner: string; message: string }) => void): () => void;
  };
  lycanViewerWindow?: {
    ready(): Promise<import('./viewing/viewerPage').ViewerWindowState>;
    setPinned(enabled: boolean): Promise<import('./viewing/viewerPage').ViewerWindowState>;
    toggleFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
    onState(callback: (state: import('./viewing/viewerPage').ViewerWindowState) => void): () => void;
    onDisarm(callback: () => void): () => void;
  };
  lycanVoiceOverlay?: import('./overlay/types').VoiceOverlayBridge;
  lycanOverlayView?: {
    ready(): Promise<void>;
    onView(callback: (view: import('./overlay/types').VoiceOverlayView) => void): () => void;
  };
  lycanDesktop?: {
    copyText(text: string): Promise<void>;
    runStartupUpdate(): Promise<StartupUpdateState>;
    getUpdateState(): Promise<StartupUpdateState>;
    checkUpdates(): Promise<StartupUpdateState>;
    restartForUpdate(): Promise<void>;
    skipStartupUpdate(): Promise<void>;
    onUpdateState(callback: (state: StartupUpdateState) => void): () => void;
    clearSession(): Promise<void>;
    returnToAccountEntry(): Promise<void>;
    getAutoLogin(accountId: string): Promise<{ enabled: boolean; manualEntryRequired: boolean }>;
    setAutoLogin(accountId: string, enabled: boolean, manualEntryRequired: boolean): Promise<boolean>;
    getAccessLink(): Promise<import('./auth/accountAccess').AccessOffer | null>;
    parseAccessLink(value: string): Promise<import('./auth/accountAccess').AccessOffer>;
    prepareAccessLink(offer: import('./auth/accountAccess').AccessOffer): Promise<void>;
    onAccessLink(callback: (offer: import('./auth/accountAccess').AccessOffer) => void): () => void;
    getServerSettings(): Promise<{ apiUrl: string; editable: boolean }>;
    setServerAddress(value: string): Promise<void>;
    minimize(): void;
    getWindowVisibility(): Promise<boolean>;
    focusViewerWindow(id: string): Promise<void>;
    onWindowVisibility(callback: (visible: boolean) => void): () => void;
    onViewerClosed(callback: (closed: { id: string; failed: boolean }) => void): () => void;
    isMaximized(): Promise<boolean>;
    prepareCapture(): Promise<void>;
    getRecordingSettings(): Promise<RecordingSettings>;
    configureRecording(settings: Omit<RecordingSettings, 'directory' | 'replaySeconds'>): Promise<RecordingSettings>;
    chooseRecordingDirectory(): Promise<RecordingSettings>;
    failRecordingVoice(id: string): Promise<DesktopRecordingStatus>;
    sendRecordingVoice(id: string, position: number, pcm: Uint8Array): Promise<boolean>;
    startRecording(previousId?: string): Promise<DesktopRecordingStatus>;
    stopRecording(id: string | null): Promise<DesktopRecordingStatus>;
    startReplay(): Promise<DesktopRecordingStatus>;
    saveReplay(): Promise<DesktopRecordingStatus>;
    stopReplay(): Promise<DesktopRecordingStatus>;
    configureReplay(seconds: number): Promise<RecordingSettings>;
    getRecordingStatus(): Promise<DesktopRecordingStatus>;
    revealRecording(): Promise<void>;
    getRecordingLibrary(offset?: number): Promise<{ items: RecordingLibraryEntry[]; hasMore: boolean }>;
    recordingFile(id: string, action: 'play' | 'reveal' | 'delete'): Promise<boolean>;
    onRecordingState(callback: (state: DesktopRecordingStatus) => void): () => void;
    getProcessMetrics(): Promise<DesktopProcessMetrics>;
    exportDiagnosticReport(report: string): Promise<{ saved: boolean }>;
    saveDiagnosticSnapshot(report: string): Promise<number | null>;
    getSavedDiagnosticReport(): Promise<{ kind?: 'screen-media' | 'previous-run'; startedAt: string; endedAt: string; clientVersion: string | null; savedAt: string; bytes: number } | null>;
    exportSavedDiagnosticReport(notes: string): Promise<{ saved: boolean }>;
    clearSavedDiagnosticReports(): Promise<void>;
    getSystemIdleState(): Promise<{ state: 'active' | 'idle' | 'locked' | 'unknown'; idleSeconds: number }>;
    getAutoStart(): Promise<{ supported: boolean; enabled: boolean }>;
    setAutoStart(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;
    getTraySettings(): Promise<{ supported: boolean; enabled: boolean; error: string }>;
    setCloseToTray(enabled: boolean): Promise<{ supported: boolean; enabled: boolean; error: string }>;
    getCurrentActivity(): Promise<DetectedActivity | null>;
    listActivityWindows(): Promise<ActivityWindow[]>;
    configureActivityMappings(mappings: ActivityMapping[]): Promise<void>;
    getNativeMediaCapabilities(): Promise<Record<string, { available: boolean; reason: string }>>;
    listNativeVideoSources(): Promise<{ revision: number; discoveryId: string; sources: NativeVideoSource[] }>;
    prepareNativeVideoSource(sourceId: string | null): Promise<{ prepared: boolean; followGame?: 'league' }>;
    getNativeVideoSourceThumbnails(sources: NativeVideoSource[]): Promise<{ sourceId: string; thumbnail: string }[]>;
    getScreenShareSupport(): Promise<{ hideCursor: boolean; hideBorder: boolean }>;
    startNativeVideo(sourceId: string, maxFps: number, settings: { hideCursor: boolean; hideBorder: boolean;
      windowMethod?: 'auto' | 'game'; followGame?: 'league' }, resolution: { width: number; height: number }): Promise<{ sessionId: string; changed: boolean; gameFollowId?: string }>;
    findNativeGameSource(id: string): Promise<{ sourceId: string | null }>;
    switchNativeGameVideo(id: string, sourceId: string, maxFps: number, settings: import('./settings/screenSharePreferences').ScreenSharePreferences,
      resolution: { width: number; height: number }): Promise<{ sessionId: string; changed: boolean; gameFollowId?: string }>;
    endNativeGameFollow(id: string): Promise<void>;
    stopNativeVideo(sessionId: string): Promise<{ changed: boolean }>;
    configureNativeVideo(sessionId: string, maxFps: number, resolution?: { width: number; height: number }, deliveryOnly?: boolean): Promise<{ changed: boolean }>;
    authorizeNativeRemoteControl(sessionId: string, controlSessionId: string, controllerIdentity: string): Promise<{ changed: boolean }>;
    sendNativeRemoteInput(sessionId: string, controlSessionId: string, controllerIdentity: string, sequence: number,
      input: import('./rtc/remoteControl').RemoteControlInput): Promise<{ changed: boolean; dropped?: boolean }>;
    revokeNativeRemoteControl(sessionId: string, controlSessionId: string): Promise<{ changed: boolean }>;
    onNativeVideoError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
    onNativeVideoSuspended(callback: (status: { sessionId: string; suspended: boolean }) => void): () => void;
    recordScreenShareStartupTiming(sessionId: string,
      stage: 'screenVideoFirstFrame' | 'screenVideoStartupFailed' | 'screenAudioStartup' | 'screenVideoPublished', durationMs: number,
      audioTiming?: { outcome: 'published' | 'failed'; phase: 'capture' | 'graph' | 'publish';
        pluginLoadMs?: number; captureReadyMs?: number; graphReadyMs?: number; publishMs?: number } | { code: string }): void;
    startNativeScreenAudio(sourceId: string, sessionId: string): Promise<{
      sampleRate: number; channels: 2; bitsPerSample: 32; nominalChunkMs: 10;
      pluginLoadMs: number; captureReadyMs: number;
    }>;
    stopNativeScreenAudio(sessionId: string): Promise<{ changed: boolean }>;
    onNativeScreenAudioChunk(callback: (chunk: NativeScreenAudioChunk) => void): () => void;
    acknowledgeNativeScreenAudioChunk(sessionId: string, sequence: number, droppedChunks: number): void;
    onNativeScreenAudioError(callback: (failure: { sessionId: string; code: string }) => void): () => void;
    listMicrophoneDevices(): Promise<{ id: string; label: string }[]>;
    startNativeMicrophone(sessionId: string, settings: import('./rtc/nativeMicrophoneAudio').NativeMicrophoneSettings, deviceId: string, pushToTalk: boolean): Promise<{
      sampleRate: 48000; channels: 1; bitsPerSample: 32; nominalChunkMs: 10;
    }>;
    configureNativeMicrophone(sessionId: string, settings: import('./rtc/nativeMicrophoneAudio').NativeMicrophoneSettings): Promise<{ changed: boolean }>;
    stopNativeMicrophone(sessionId: string): Promise<{ changed: boolean }>;
    setNativeMicrophoneTransmission(sessionId: string, pushToTalk: boolean, held: boolean, epoch: number): void;
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

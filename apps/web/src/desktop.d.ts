interface CaptureRequest {
  requestId: string;
  sources: { id: string; name: string; thumbnail: string; type: 'screen' | 'window' }[];
}

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
  rawFrameIntervalP50Ms: number | null;
  rawFrameIntervalP95Ms: number | null;
  rawFrameIntervalP99Ms: number | null;
  rawTimestampAnomalies: number | null;
  lastFrameAgeMs: number | null;
  sizeChanges: number | null;
  lastCaptureError: string | null;
  stopDurationMs: number | null;
}

interface Window {
  lycanDesktop?: {
    clearSession(): Promise<void>;
    minimize(): void;
    isMaximized(): Promise<boolean>;
    getProcessMetrics(): Promise<{ cpuPercent: number; memoryMb: number }>;
    getSystemIdleState(): Promise<{ state: 'active' | 'idle' | 'locked' | 'unknown'; idleSeconds: number }>;
    getAutoStart(): Promise<{ supported: boolean; enabled: boolean }>;
    setAutoStart(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;
    getCurrentActivity(): Promise<DetectedActivity | null>;
    getNativeMediaCapabilities(): Promise<Record<string, { available: boolean; reason: string }>>;
    listNativeVideoSources(): Promise<{ revision: number; sources: NativeVideoSource[] }>;
    startNativeCaptureProbe(sourceId: string): Promise<{ sessionId: string; changed: boolean }>;
    stopNativeCaptureProbe(sessionId: string): Promise<{ changed: boolean }>;
    getNativeMediaDiagnostics(): Promise<NativeCaptureDiagnostics>;
    onActivityChange(callback: (activity: DetectedActivity | null) => void): () => void;
    toggleMaximize(): void;
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
    close(): void;
    finishClose(): void;
    openExternal(url: string): Promise<void>;
    selectSource(requestId: string, sourceId: string | null): void;
    onSources(callback: (request: CaptureRequest) => void): () => void;
    onClose(callback: () => void): () => void;
  };
}

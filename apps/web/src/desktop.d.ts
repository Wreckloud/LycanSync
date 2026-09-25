interface CaptureRequest {
  requestId: string;
  sources: { id: string; name: string; thumbnail: string; type: 'screen' | 'window' }[];
}

interface DetectedActivity {
  type: 'GAME';
  name: string;
  startedAt: string;
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

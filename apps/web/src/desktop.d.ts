interface CaptureRequest {
  requestId: string;
  sources: { id: string; name: string; thumbnail: string; type: 'screen' | 'window' }[];
}

interface Window {
  lycanDesktop?: {
    clearSession(): Promise<void>;
    minimize(): void;
    isMaximized(): Promise<boolean>;
    getProcessMetrics(): Promise<{ cpuPercent: number; memoryMb: number }>;
    toggleMaximize(): void;
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
    close(): void;
    finishClose(): void;
    selectSource(requestId: string, sourceId: string | null): void;
    onSources(callback: (request: CaptureRequest) => void): () => void;
    onClose(callback: () => void): () => void;
  };
}

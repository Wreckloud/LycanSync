interface CaptureRequest {
  requestId: string;
  sources: { id: string; name: string; thumbnail: string }[];
}

interface Window {
  lycanDesktop?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    finishClose(): void;
    selectSource(requestId: string, sourceId: string | null): void;
    onSources(callback: (request: CaptureRequest) => void): () => void;
    onClose(callback: () => void): () => void;
  };
}

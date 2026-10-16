export interface VoiceOverlaySettings {
  enabled: boolean;
  mode: 'all' | 'speaking';
  scale: number;
  width: number;
  displayId: number | null;
  x: number;
  y: number;
  includeInCapture: boolean;
}

export interface VoiceOverlayMember {
  identity: string;
  name: string;
  microphone: boolean;
  listening: boolean;
  speaking: boolean;
}

export interface VoiceOverlaySnapshot {
  sequence: number;
  roomId: string | null;
  status: 'connected' | 'reconnecting' | 'hidden';
  members: VoiceOverlayMember[];
  portraits?: { identity: string; avatar: string }[];
}

export interface VoiceOverlayBridge {
  begin(): Promise<string>;
  configure(owner: string, settings: VoiceOverlaySettings): Promise<VoiceOverlaySettings>;
  update(owner: string, snapshot: VoiceOverlaySnapshot): Promise<void>;
  edit(owner: string, enabled: boolean): Promise<boolean>;
  end(owner: string): Promise<void>;
  displays(): Promise<{ id: number; label: string }[]>;
  onError(callback: (message: string) => void): () => void;
  onPlacement(callback: (settings: VoiceOverlaySettings) => void): () => void;
  onEditingChange(callback: (editing: boolean) => void): () => void;
}

export interface VoiceOverlayView {
  settings: VoiceOverlaySettings;
  editing: boolean;
  status: VoiceOverlaySnapshot['status'];
  members: (VoiceOverlayMember & { visible: boolean })[];
  portraits?: { identity: string; avatar: string }[];
}

import { VideoPreset } from 'livekit-client';

export const SCREEN_SHARE_QUALITIES = [
  { id: 'highFrameRate', label: '高帧率', description: '1080p · 120 FPS', width: 1920, height: 1080, fps: 120, bitrate: 20_000_000 },
  { id: 'text', label: '文字清晰', description: '1080p · 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  { id: 'standard', label: '标准', description: '1080p · 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
  { id: 'economy', label: '节省流量', description: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
] as const;

export type ScreenShareQualityId = typeof SCREEN_SHARE_QUALITIES[number]['id'];
const STORAGE_KEY = 'lycansync.screen-share-quality';

export function screenShareQuality(id: ScreenShareQualityId) {
  const quality = SCREEN_SHARE_QUALITIES.find((quality) => quality.id === id);
  if (!quality) throw new Error('invalidScreenShareQuality');
  return quality;
}

export function screenShareVideoPreset(id: ScreenShareQualityId) {
  const quality = screenShareQuality(id);
  return new VideoPreset(quality.width, quality.height, quality.bitrate, quality.fps, 'medium');
}

export function screenShareDegradationPreference(id: ScreenShareQualityId): RTCDegradationPreference {
  screenShareQuality(id);
  if (id === 'text') return 'maintain-resolution';
  if (id === 'economy') return 'balanced';
  return 'maintain-framerate';
}

export function screenShareThumbnailPreset() {
  return new VideoPreset(640, 360, 1_000_000, 30, 'high');
}

export function readScreenShareQuality(): ScreenShareQualityId {
  const stored = localStorage.getItem(STORAGE_KEY);
  return SCREEN_SHARE_QUALITIES.find((quality) => quality.id === stored)?.id ?? 'standard';
}

export function saveScreenShareQuality(id: ScreenShareQualityId) {
  screenShareQuality(id);
  localStorage.setItem(STORAGE_KEY, id);
}

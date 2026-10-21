import { VideoPreset } from 'livekit-client';

// 推荐值是待实测校准的编码上限；固定模式与自定义共用同一张表。
const RECOMMENDED_BITRATES = {
  360: { 30: 1_000_000, 60: 1_500_000, 120: 2_000_000, 180: 3_000_000 },
  720: { 30: 3_000_000, 60: 5_000_000, 120: 8_000_000, 180: 10_000_000 },
  1080: { 30: 8_000_000, 60: 12_000_000, 120: 20_000_000, 180: 24_000_000 },
  1440: { 30: 12_000_000, 60: 20_000_000, 120: 30_000_000, 180: 40_000_000 },
} as const;

export const SCREEN_SHARE_QUALITIES = [
  { id: 'highFrameRate', label: '高帧率', description: '1080p · 120 FPS', width: 1920, height: 1080, fps: 120, bitrate: RECOMMENDED_BITRATES[1080][120] },
  { id: 'custom', label: '自定义', description: '自行选择分辨率和帧率', width: 1920, height: 1080, fps: 60, bitrate: RECOMMENDED_BITRATES[1080][60] },
  { id: 'standard', label: '标准', description: '1080p · 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: RECOMMENDED_BITRATES[1080][60] },
  { id: 'economy', label: '节省流量', description: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: RECOMMENDED_BITRATES[720][30] },
] as const;

export type ScreenShareQualityId = typeof SCREEN_SHARE_QUALITIES[number]['id'];
const STORAGE_KEY = 'lycansync.screen-share-quality';

export const SCREEN_SHARE_RESOLUTIONS = [1440, 1080, 720, 360] as const;
export const SCREEN_SHARE_FRAME_RATES = [180, 120, 60, 30] as const;
export const SCREEN_SHARE_BITRATE_MIN_MBPS = 0.5;
export const SCREEN_SHARE_BITRATE_MAX_MBPS = 50;
export const SCREEN_SHARE_BITRATE_STEP_MBPS = 0.5;
export interface CustomScreenShareQuality {
  resolution: typeof SCREEN_SHARE_RESOLUTIONS[number];
  fps: typeof SCREEN_SHARE_FRAME_RATES[number];
  bitrateMbps?: number;
}
export const DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY: CustomScreenShareQuality = { resolution: 1080, fps: 60 };

export function validateCustomScreenShareQuality(value: CustomScreenShareQuality): CustomScreenShareQuality {
  if (!value || !SCREEN_SHARE_RESOLUTIONS.includes(value.resolution) || !SCREEN_SHARE_FRAME_RATES.includes(value.fps)) {
    throw new Error('invalidCustomScreenShareQuality');
  }
  if (value.bitrateMbps !== undefined && (!Number.isFinite(value.bitrateMbps)
      || value.bitrateMbps < SCREEN_SHARE_BITRATE_MIN_MBPS || value.bitrateMbps > SCREEN_SHARE_BITRATE_MAX_MBPS
      || !Number.isInteger(value.bitrateMbps / SCREEN_SHARE_BITRATE_STEP_MBPS))) {
    throw new Error('invalidScreenShareBitrate');
  }
  // 缺省即推荐；不能把计算出的推荐值存成手动值，否则后续修改尺寸不会跟随更新。
  return { resolution: value.resolution, fps: value.fps,
    ...(value.bitrateMbps !== undefined ? { bitrateMbps: value.bitrateMbps } : {}) };
}

export function screenShareQuality(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY) {
  const quality = SCREEN_SHARE_QUALITIES.find((quality) => quality.id === id);
  if (!quality) throw new Error('invalidScreenShareQuality');
  if (id === 'custom') {
    const { resolution, fps, bitrateMbps } = validateCustomScreenShareQuality(custom);
    const bitrate = bitrateMbps !== undefined ? bitrateMbps * 1_000_000 : RECOMMENDED_BITRATES[resolution][fps];
    return { ...quality, width: resolution * 16 / 9, height: resolution, fps, bitrate,
      description: `${resolution}p · ${fps} FPS` };
  }
  return quality;
}

export function screenShareVideoPreset(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY) {
  const quality = screenShareQuality(id, custom);
  return new VideoPreset(quality.width, quality.height, quality.bitrate, quality.fps, 'medium');
}

export function screenShareDegradationPreference(id: ScreenShareQualityId): RTCDegradationPreference {
  screenShareQuality(id);
  if (id === 'economy') return 'balanced';
  return 'maintain-framerate';
}

export function screenShareThumbnailPreset() {
  return new VideoPreset(640, 360, 1_000_000, 30, 'high');
}

export function readScreenShareQuality(): { quality: ScreenShareQualityId; customQuality: CustomScreenShareQuality } {
  const stored = localStorage.getItem(STORAGE_KEY);
  // 仅迁移已保存的旧选择，不保留旧文字模式的采集或编码分支。
  if (stored === 'text') return { quality: 'custom', customQuality: { resolution: 1080, fps: 30 } };
  if (!stored || SCREEN_SHARE_QUALITIES.some(quality => quality.id === stored)) {
    return { quality: stored ? stored as ScreenShareQualityId : 'standard', customQuality: { ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY } };
  }
  let preference: { quality?: ScreenShareQualityId; customQuality?: CustomScreenShareQuality };
  try { preference = JSON.parse(stored); } catch { throw new Error('invalidScreenShareQualityPreference'); }
  if (!preference || !SCREEN_SHARE_QUALITIES.some(quality => quality.id === preference.quality)) {
    throw new Error('invalidScreenShareQualityPreference');
  }
  return { quality: preference.quality!, customQuality: validateCustomScreenShareQuality(preference.customQuality!) };
}

export function saveScreenShareQuality(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY) {
  const customQuality = validateCustomScreenShareQuality(custom);
  screenShareQuality(id, customQuality);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ quality: id, customQuality }));
}

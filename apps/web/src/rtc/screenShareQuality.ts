import { VideoPreset } from 'livekit-client';

// 自定义档的码率上限按输出像素数和所选帧率分档。
const RECOMMENDED_BITRATES = {
  720: { 30: 3_000_000, 60: 5_000_000, 120: 8_000_000 },
  1080: { 30: 8_000_000, 60: 12_000_000, 120: 20_000_000 },
  1440: { 30: 12_000_000, 60: 20_000_000, 120: 30_000_000 },
} as const;

export const SCREEN_SHARE_QUALITIES = [
  { id: 'highFrameRate', guidance: '适合射击、竞速等快速运动的游戏，优先保持转视角时的流畅度。', label: '游戏', description: '1080p · 60 FPS · 上限 10 Mbps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
  { id: 'standard', guidance: '适合日常共享、绘画和文档，优先保留文字与笔画细节。', label: '标准', description: '1080p · 60 FPS · 上限 6 Mbps', width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 },
  { id: 'economy', guidance: '适合带宽有限或波动时共享，以较低帧率保留画面细节。', label: '稳定', description: '720p · 30 FPS · 上限 2 Mbps', width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
  { id: 'custom', guidance: '分享小字或绘画时可选 30 FPS，优先保留细节。60 和 120 FPS 优先保持流畅。', label: '自定义', description: '自行选择分辨率和帧率', width: 1920, height: 1080, fps: 60, bitrate: RECOMMENDED_BITRATES[1080][60] },
] as const;

export type ScreenShareQualityId = typeof SCREEN_SHARE_QUALITIES[number]['id'];
const STORAGE_KEY = 'lycansync.screen-share-quality';

export const SCREEN_SHARE_RESOLUTIONS = [1440, 1080, 720] as const;
export const SCREEN_SHARE_FRAME_RATES = [120, 60, 30] as const;
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

function customScreenShareBitrate(custom: CustomScreenShareQuality, frame?: { width: number; height: number }) {
  if (custom.bitrateMbps !== undefined) return custom.bitrateMbps * 1_000_000;
  let resolution = custom.resolution;
  if (frame && frame.width > 0 && frame.height > 0) {
    const pixels = frame.width * frame.height;
    if (pixels <= 1280 * 720) resolution = 720;
    else if (pixels <= 1920 * 1080 && resolution === 1440) resolution = 1080;
  }
  return RECOMMENDED_BITRATES[resolution][custom.fps];
}

export function screenShareQuality(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY,
  frame?: { width: number; height: number }) {
  const quality = SCREEN_SHARE_QUALITIES.find((quality) => quality.id === id);
  if (!quality) throw new Error('invalidScreenShareQuality');
  if (id === 'custom') {
    const { resolution, fps } = validateCustomScreenShareQuality(custom);
    const bitrate = customScreenShareBitrate(custom, frame);
    return { ...quality, width: resolution * 16 / 9, height: resolution, fps, bitrate,
      description: `${resolution}p · ${fps} FPS` };
  }
  return quality;
}

export function screenShareVideoPreset(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY,
  frame?: { width: number; height: number }) {
  const quality = screenShareQuality(id, custom, frame);
  return new VideoPreset(quality.width, quality.height, quality.bitrate, quality.fps, 'medium');
}

export function screenShareDegradationPreference(id: ScreenShareQualityId, custom?: CustomScreenShareQuality): RTCDegradationPreference {
  const profile = screenShareQuality(id, custom);
  if (id === 'standard' || id === 'economy' || (id === 'custom' && profile.fps === 30)) return 'maintain-resolution';
  return 'maintain-framerate';
}

export function screenShareContentHint(id: ScreenShareQualityId, custom?: CustomScreenShareQuality) {
  return screenShareDegradationPreference(id, custom) === 'maintain-resolution' ? 'detail' : 'motion';
}

export const SCREEN_SHARE_LOWER_LAYER_FPS = 30;

export function canPublishScreenShareMiddleLayer(id: ScreenShareQualityId, dimensions?: { width: number; height: number }) {
  if (!dimensions || id !== 'standard') return false;
  const { width, height } = dimensions;
  const shortSide = Math.min(width, height);
  // 标准档增加中层前，预览的 1/3 和热切游戏后的 1/2 都须能精确缩成偶数像素。
  return shortSide >= 960 && shortSide <= 1080 && width % 12 === 0 && height % 12 === 0;
}

export function screenShareThumbnailPreset(dimensions?: { width: number; height: number }) {
  let width = 640, height = 360;
  if (dimensions) {
    const shortSide = Math.min(dimensions.width, dimensions.height);
    const divisor = Math.round(shortSide / height);
    // LiveKit 按预设短边计算缩放比；分数倍缩放可能让 H.264 主层也退回软编。
    if (divisor > 1 && shortSide % divisor === 0) {
      width = Math.round(dimensions.width / divisor);
      height = Math.round(dimensions.height / divisor);
    }
  }
  return new VideoPreset(width, height, 1_000_000, SCREEN_SHARE_LOWER_LAYER_FPS, 'high');
}

export function screenShareLowerLayers(dimensions: { width: number; height: number }, middle: boolean, mainBitrate: number,
  preference?: RTCDegradationPreference) {
  const thumbnail = screenShareThumbnailPreset(dimensions);
  if (!middle) {
    thumbnail.encoding.maxBitrate = Math.min(thumbnail.encoding.maxBitrate, Math.floor(mainBitrate / 2));
    return [thumbnail];
  }
  const { width, height } = dimensions;
  // 标准优先保留 720p；已协商三层时热切游戏，用半尺寸给快速运动留余量。
  const motion = preference === 'maintain-framerate';
  const motionHalfSize = motion && width % 4 === 0 && height % 4 === 0;
  const shortSide = Math.min(width, height);
  const twoThirds = shortSide >= 960 && shortSide <= 1080 && width % 3 === 0 && height % 3 === 0;
  const divisor = twoThirds && !motionHalfSize ? 1.5 : 2;
  const midRate = Math.min(motion ? 1_500_000 : 2_000_000, Math.floor(mainBitrate / 2));
  const mid = new VideoPreset(width / divisor, height / divisor, midRate, SCREEN_SHARE_LOWER_LAYER_FPS);
  // 热切档保留已协商的 RID 数量，小画面需要拉开预览和中层，避免编码两份相同的画面。
  const preview = Math.min(thumbnail.width, thumbnail.height) < Math.min(mid.width, mid.height)
    ? thumbnail : new VideoPreset(width / 4, height / 4, thumbnail.encoding.maxBitrate, SCREEN_SHARE_LOWER_LAYER_FPS, 'high');
  preview.encoding.maxBitrate = Math.min(preview.encoding.maxBitrate, Math.floor(midRate / 2));
  return [preview, mid];
}

export function readScreenShareQuality(): { quality: ScreenShareQualityId; customQuality: CustomScreenShareQuality } {
  const stored = localStorage.getItem(STORAGE_KEY);
  // 仅迁移已保存的旧选择，不保留旧文字模式的采集或编码分支。
  if (stored === 'text') return { quality: 'custom', customQuality: { resolution: 1080, fps: 30 } };
  if (!stored || SCREEN_SHARE_QUALITIES.some(quality => quality.id === stored)) {
    return { quality: stored ? stored as ScreenShareQualityId : 'standard', customQuality: { ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY } };
  }
  let preference: { quality?: ScreenShareQualityId; customQuality?: Omit<CustomScreenShareQuality, 'resolution' | 'fps'> & { resolution: number; fps: number } };
  try { preference = JSON.parse(stored); } catch { throw new Error('invalidScreenShareQualityPreference'); }
  if (!preference || !SCREEN_SHARE_QUALITIES.some(quality => quality.id === preference.quality)) {
    throw new Error('invalidScreenShareQualityPreference');
  }
  // 只迁移已移除的旧档位，保留手动码率；读取时不提前写入偏好。
  const customQuality = preference.customQuality;
  if (customQuality?.resolution === 360) customQuality.resolution = 720;
  if (customQuality?.fps === 180) customQuality.fps = 120;
  return { quality: preference.quality!, customQuality: validateCustomScreenShareQuality(customQuality as CustomScreenShareQuality) };
}

export function saveScreenShareQuality(id: ScreenShareQualityId, custom = DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY) {
  const customQuality = validateCustomScreenShareQuality(custom);
  screenShareQuality(id, customQuality);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ quality: id, customQuality }));
}

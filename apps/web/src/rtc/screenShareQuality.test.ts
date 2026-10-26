import { afterEach, expect, it, vi } from 'vitest';
import { SCREEN_SHARE_QUALITIES, SCREEN_SHARE_RESOLUTIONS, SCREEN_SHARE_FRAME_RATES,
  readScreenShareQuality, saveScreenShareQuality, screenShareDegradationPreference, screenShareQuality, screenShareVideoPreset } from './screenShareQuality';

afterEach(() => vi.unstubAllGlobals());

it('画质保留三个预设，自定义固定在最后，帧率最高 120', () => {
  expect(SCREEN_SHARE_QUALITIES.map((quality) => quality.id)).toEqual(['highFrameRate', 'standard', 'economy', 'custom']);
  expect(SCREEN_SHARE_FRAME_RATES).toEqual([120, 60, 30]);
  expect(SCREEN_SHARE_RESOLUTIONS).toEqual([1440, 1080, 720]);
});

it('自定义及常用画质优先保留帧率，节省流量使用平衡策略', () => {
  expect(screenShareDegradationPreference('standard')).toBe('maintain-framerate');
  expect(screenShareDegradationPreference('highFrameRate')).toBe('maintain-framerate');
  expect(screenShareDegradationPreference('custom')).toBe('maintain-framerate');
  expect(screenShareDegradationPreference('economy')).toBe('balanced');
  expect(() => screenShareDegradationPreference('unknown' as never)).toThrow('invalidScreenShareQuality');
});

it('restores only known presets and remembers the confirmed selection', () => {
  let stored: string | null = null;
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  expect(readScreenShareQuality()).toEqual({ quality: 'standard', customQuality: { resolution: 1080, fps: 60 } });
  stored = 'text';
  expect(readScreenShareQuality()).toEqual({ quality: 'custom', customQuality: { resolution: 1080, fps: 30 } });
  const custom = { resolution: 1440, fps: 120 } as const;
  saveScreenShareQuality('custom', custom);
  expect(readScreenShareQuality()).toEqual({ quality: 'custom', customQuality: custom });
  saveScreenShareQuality('highFrameRate', custom);
  expect(readScreenShareQuality()).toEqual({ quality: 'highFrameRate', customQuality: custom });
  expect(screenShareVideoPreset(readScreenShareQuality().quality).encoding.maxFramerate).toBe(120);
  expect(() => saveScreenShareQuality('unknown' as never)).toThrow('invalidScreenShareQuality');
  expect(JSON.parse(stored!)).toEqual({ quality: 'highFrameRate', customQuality: custom });
  stored = 'removedPreset';
  expect(() => readScreenShareQuality()).toThrow('invalidScreenShareQualityPreference');
});

it('keeps capture resolution, encoder framerate and bitrate consistent for each preset', () => {
  for (const id of ['economy', 'standard', 'highFrameRate', 'custom'] as const) {
    const quality = screenShareQuality(id);
    const preset = screenShareVideoPreset(id);
    expect(preset.width).toBe(quality.width);
    expect(preset.height).toBe(quality.height);
    expect(preset.encoding.maxFramerate).toBe(quality.fps);
    expect(preset.encoding.maxBitrate).toBe(quality.bitrate);
  }
});

it('全部自定义组合贯通尺寸、帧率及有限码率，不接受额外档位', () => {
  for (const resolution of SCREEN_SHARE_RESOLUTIONS) {
    for (const fps of SCREEN_SHARE_FRAME_RATES) {
      const profile = screenShareQuality('custom', { resolution, fps });
      const preset = screenShareVideoPreset('custom', { resolution, fps });
      expect([preset.width, preset.height]).toEqual([resolution * 16 / 9, resolution]);
      expect(preset.encoding.maxFramerate).toBe(fps);
      expect(preset.encoding.maxBitrate).toBe(profile.bitrate);
      expect(profile.bitrate).toBeGreaterThan(0);
      expect(profile.bitrate).toBeLessThanOrEqual(30_000_000);
    }
  }
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { setItem });
  for (const custom of [{ resolution: 2160, fps: 60 }, { resolution: 360, fps: 30 }, { resolution: 1080, fps: 90 }, { resolution: 1440, fps: 180 }]) {
    expect(() => saveScreenShareQuality('custom', custom as never)).toThrow('invalidCustomScreenShareQuality');
  }
  expect(setItem).not.toHaveBeenCalled();
});

it.each(['custom', 'standard'])('旧 180 配置在 %s 下读取为 120，保留尺寸及手动码率，不提前写入', (quality) => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ quality,
    customQuality: { resolution: 1440, fps: 180, bitrateMbps: 25 } }), setItem });
  expect(readScreenShareQuality()).toEqual({ quality, customQuality: { resolution: 1440, fps: 120, bitrateMbps: 25 } });
  expect(setItem).not.toHaveBeenCalled();
  saveScreenShareQuality('custom', readScreenShareQuality().customQuality);
  expect(JSON.parse(setItem.mock.calls[0][1]).customQuality.fps).toBe(120);
});

it('未手动设码率的旧 180 配置沿用新的推荐值，其他非法配置仍明确失败', () => {
  let customQuality = { resolution: 1440, fps: 180 };
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ quality: 'custom', customQuality }) });
  expect(screenShareQuality('custom', readScreenShareQuality().customQuality).bitrate).toBe(30_000_000);
  customQuality = { resolution: 2160, fps: 180 };
  expect(() => readScreenShareQuality()).toThrow('invalidCustomScreenShareQuality');
  customQuality = { resolution: 1440, fps: 144 };
  expect(() => readScreenShareQuality()).toThrow('invalidCustomScreenShareQuality');
});

it.each([['custom', 30], ['standard', 60], ['custom', 180]])('旧 360p 配置在 %s、%s FPS 下迁到 720p，保留手动码率', (quality, fps) => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ quality,
    customQuality: { resolution: 360, fps, bitrateMbps: 6 } }), setItem });
  const preference = readScreenShareQuality();
  expect(preference).toEqual({ quality, customQuality: { resolution: 720, fps: fps === 180 ? 120 : fps, bitrateMbps: 6 } });
  expect(setItem).not.toHaveBeenCalled();
  saveScreenShareQuality(preference.quality, preference.customQuality);
  expect(JSON.parse(setItem.mock.calls[0][1]).customQuality).toEqual(preference.customQuality);
});

it('固定模式与相同尺寸帧率的自定义共用推荐码率，手动上限不影响固定模式', () => {
  for (const id of ['highFrameRate', 'standard', 'economy'] as const) {
    const preset = screenShareQuality(id);
    const custom = { resolution: preset.height, fps: preset.fps };
    expect(screenShareQuality('custom', custom).bitrate).toBe(preset.bitrate);
    expect(screenShareQuality(id, { ...custom, bitrateMbps: 6 }).bitrate).toBe(preset.bitrate);
  }
});

it('手动码率随自定义配置记忆，切换固定模式不丢失，恢复推荐后跟随尺寸帧率', () => {
  let stored: string | null = null;
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  const custom = { resolution: 1080, fps: 60, bitrateMbps: 6 } as const;
  saveScreenShareQuality('custom', custom);
  expect(readScreenShareQuality().customQuality).toEqual(custom);
  saveScreenShareQuality('standard', custom);
  expect(readScreenShareQuality().customQuality.bitrateMbps).toBe(6);
  const larger = { ...custom, resolution: 1440, fps: 120 } as const;
  expect(screenShareVideoPreset('custom', larger).encoding.maxBitrate).toBe(6_000_000);
  saveScreenShareQuality('custom', { resolution: larger.resolution, fps: larger.fps });
  expect(readScreenShareQuality().customQuality).not.toHaveProperty('bitrateMbps');
  expect(screenShareVideoPreset('custom', readScreenShareQuality().customQuality).encoding.maxBitrate).toBe(30_000_000);
});

it.each([0, -1, 0.1, 0.75, 50.5, NaN, Infinity, '6', null])('非法码率 %s 不写入偏好', (bitrateMbps) => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { setItem });
  expect(() => saveScreenShareQuality('custom', { resolution: 1080, fps: 60, bitrateMbps } as never)).toThrow('invalidScreenShareBitrate');
  expect(setItem).not.toHaveBeenCalled();
});

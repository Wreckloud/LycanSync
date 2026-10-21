import { afterEach, expect, it, vi } from 'vitest';
import { SCREEN_SHARE_QUALITIES, SCREEN_SHARE_RESOLUTIONS, SCREEN_SHARE_FRAME_RATES,
  readScreenShareQuality, saveScreenShareQuality, screenShareDegradationPreference, screenShareQuality, screenShareVideoPreset } from './screenShareQuality';

afterEach(() => vi.unstubAllGlobals());

it('画质按高帧率、自定义、标准、节省流量排列', () => {
  expect(SCREEN_SHARE_QUALITIES.map((quality) => quality.id)).toEqual(['highFrameRate', 'custom', 'standard', 'economy']);
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
  const custom = { resolution: 1440, fps: 180 } as const;
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
      expect(profile.bitrate).toBeLessThanOrEqual(40_000_000);
    }
  }
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { setItem });
  for (const custom of [{ resolution: 2160, fps: 60 }, { resolution: 1080, fps: 90 }]) {
    expect(() => saveScreenShareQuality('custom', custom as never)).toThrow('invalidCustomScreenShareQuality');
  }
  expect(setItem).not.toHaveBeenCalled();
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
  const larger = { ...custom, resolution: 1440, fps: 180 } as const;
  expect(screenShareVideoPreset('custom', larger).encoding.maxBitrate).toBe(6_000_000);
  saveScreenShareQuality('custom', { resolution: larger.resolution, fps: larger.fps });
  expect(readScreenShareQuality().customQuality).not.toHaveProperty('bitrateMbps');
  expect(screenShareVideoPreset('custom', readScreenShareQuality().customQuality).encoding.maxBitrate).toBe(40_000_000);
});

it.each([0, -1, 0.1, 0.75, 50.5, NaN, Infinity, '6', null])('非法码率 %s 不写入偏好', (bitrateMbps) => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { setItem });
  expect(() => saveScreenShareQuality('custom', { resolution: 1080, fps: 60, bitrateMbps } as never)).toThrow('invalidScreenShareBitrate');
  expect(setItem).not.toHaveBeenCalled();
});

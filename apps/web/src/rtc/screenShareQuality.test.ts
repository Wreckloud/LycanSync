import { afterEach, expect, it, vi } from 'vitest';
import { readScreenShareQuality, saveScreenShareQuality, screenShareQuality, screenShareVideoPreset } from './screenShareQuality';

afterEach(() => vi.unstubAllGlobals());

it('restores only known presets and remembers the confirmed selection', () => {
  let stored: string | null = 'removedPreset';
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  expect(readScreenShareQuality()).toBe('standard');
  saveScreenShareQuality('highFrameRate');
  expect(readScreenShareQuality()).toBe('highFrameRate');
  expect(screenShareVideoPreset(readScreenShareQuality()).encoding.maxFramerate).toBe(120);
  expect(() => saveScreenShareQuality('unknown' as never)).toThrow('invalidScreenShareQuality');
  expect(stored).toBe('highFrameRate');
});

it('keeps capture resolution, encoder framerate and bitrate consistent for each preset', () => {
  for (const id of ['economy', 'standard', 'highFrameRate', 'text'] as const) {
    const quality = screenShareQuality(id);
    const preset = screenShareVideoPreset(id);
    expect(preset.width).toBe(quality.width);
    expect(preset.height).toBe(quality.height);
    expect(preset.encoding.maxFramerate).toBe(quality.fps);
    expect(preset.encoding.maxBitrate).toBe(quality.bitrate);
  }
});

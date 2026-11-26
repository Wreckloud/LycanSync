import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { BACKGROUND_SHARE_GAIN } from './rtc/audioPreferences';
import { setRemotePlaybackVolume } from './rtc/remotePlaybackVolume';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf8');
const volumeStart = source.indexOf('function shareVolume(');
const volumeEnd = source.indexOf('function requestParticipantControl(', volumeStart);
const toggleStart = source.indexOf('function toggleSharedAudio(');
const toggleEnd = source.indexOf('function previewGroup(', toggleStart);
const script = transpileModule(source.slice(volumeStart, volumeEnd) + source.slice(toggleStart, toggleEnd), {}).outputText;

it('逐路共享声音开关立即作用于该声音轨，不修改人声、其他共享或总音量；停止收听不被绕过', () => {
  const microphone = { setVolume: vi.fn() }, screen = { setVolume: vi.fn() }, other = { setVolume: vi.fn() };
  const context = {
    Track, BACKGROUND_SHARE_GAIN, setRemotePlaybackVolume, SHARE_VOLUME_MAX: 1, viewingWindows: { value: null }, mutedShares: { value: [] as string[] }, listening: { value: true },
    shareLevels: new Map([['A', 0.5]]), audioOutput: { available: { value: true } },
    screenShareVolume: { value: 0.2 }, outputVolume: { value: 0.8 },
    remoteAudioTracks: { value: [
      { participantIdentity: 'A', source: Track.Source.Microphone, track: microphone },
      { participantIdentity: 'A', source: Track.Source.ScreenShareAudio, track: screen },
      { participantIdentity: 'B', source: Track.Source.ScreenShareAudio, track: other },
    ] },
    toggleSharedAudio: undefined as unknown as (identity: string) => void,
  };
  runInNewContext(script, context);
  context.toggleSharedAudio('A');
  expect(screen.setVolume).toHaveBeenLastCalledWith(0);
  expect([...context.mutedShares.value]).toEqual(['A']);
  context.toggleSharedAudio('A');
  expect(screen.setVolume.mock.lastCall![0]).toBeCloseTo(0.08 * BACKGROUND_SHARE_GAIN);
  context.listening.value = false;
  context.toggleSharedAudio('A'); context.toggleSharedAudio('A');
  expect(screen.setVolume).toHaveBeenLastCalledWith(0);
  expect(microphone.setVolume).not.toHaveBeenCalled(); expect(other.setVolume).not.toHaveBeenCalled();
  expect(context.outputVolume.value).toBe(0.8); expect(context.screenShareVolume.value).toBe(0.2);
});

it('聚焦其他人的画面时伴奏仍使用平时音量', () => {
  const context = { BACKGROUND_SHARE_GAIN, SHARE_VOLUME_MAX: 1, mutedShares: { value: [] },
    shareLevels: new Map(), screenShareVolume: { value: 0.35 }, outputVolume: { value: 1 },
    viewingWindows: { value: { audioFocusIdentity: 'B' } } };
  expect(runInNewContext(script + '; remoteScreenSharePlaybackVolume("A", true)', context)).toBeCloseTo(0.35);
  expect(runInNewContext(script + '; remoteScreenSharePlaybackVolume("A", false)', context)).toBe(0);
});

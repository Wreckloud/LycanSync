import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf8');
const volumeStart = source.indexOf('function remoteScreenSharePlaybackVolume(');
const volumeEnd = source.indexOf('function focusParticipantShare(', volumeStart);
const toggleStart = source.indexOf('function toggleSharedAudio(');
const toggleEnd = source.indexOf('function previewGroup(', toggleStart);
const script = transpileModule(source.slice(volumeStart, volumeEnd) + source.slice(toggleStart, toggleEnd), {}).outputText;

it('逐路共享声音开关立即作用于该声音轨，不修改人声、其他共享或总音量；停止收听不被绕过', () => {
  const microphone = { setVolume: vi.fn() }, screen = { setVolume: vi.fn() }, other = { setVolume: vi.fn() };
  const context = {
    Track, AUDIO_VOLUME_MAX: 2, mutedShares: { value: [] as string[] }, listening: { value: true },
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
  expect(screen.setVolume.mock.lastCall![0]).toBeCloseTo(0.16);
  context.listening.value = false;
  context.toggleSharedAudio('A'); context.toggleSharedAudio('A');
  expect(screen.setVolume).toHaveBeenLastCalledWith(0);
  expect(microphone.setVolume).not.toHaveBeenCalled(); expect(other.setVolume).not.toHaveBeenCalled();
  expect(context.outputVolume.value).toBe(0.8); expect(context.screenShareVolume.value).toBe(0.2);
});

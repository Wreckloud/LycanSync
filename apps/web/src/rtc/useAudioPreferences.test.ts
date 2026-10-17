import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioPreferences } from './useAudioPreferences';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

afterEach(() => vi.useRealTimers());

describe('useAudioPreferences', () => {
  it('人声平衡默认关闭，独立保存且不改动成员静音和麦克风处理', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;
    expect(preferences.voiceVolumeBalance.value).toBe(false);
    preferences.setParticipantVolume('friend', 0);
    preferences.setVoiceVolumeBalance(true);
    expect(preferences.processing.autoGainControl).toBe(true);
    expect(preferences.participantVolume('friend')).toBe(0);
    scope.stop();
    const next = effectScope();
    expect(next.run(() => useAudioPreferences('local-user', storage))!.voiceVolumeBalance.value).toBe(true);
    expect(next.run(() => useAudioPreferences('other-user', storage))!.voiceVolumeBalance.value).toBe(false);
    next.stop();
  });

  it('合并连续音量修改，并在作用域释放前保存最后状态', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;

    preferences.setInputGain(1.2);
    preferences.setInputGain(1.4);
    preferences.setParticipantVolume('user-remote', 0);
    expect(storage.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse([...storage.values.values()][0])).toMatchObject({
      inputGain: 1.4,
      participantVolumes: { 'user-remote': 0 },
    });

    preferences.setOutputVolume(1.5);
    scope.stop();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('恢复成员静音前最后一次可听音量', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;

    preferences.setParticipantVolume('user-remote', 1.4);
    expect(preferences.toggleParticipantVolume('user-remote')).toEqual({ previous: 1.4, current: 0 });
    expect(preferences.toggleParticipantVolume('user-remote')).toEqual({ previous: 0, current: 1.4 });
    scope.stop();
  });
});

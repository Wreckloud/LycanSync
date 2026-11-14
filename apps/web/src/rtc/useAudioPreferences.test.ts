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
  it('保存失败保留当前音量并显示错误，重试保存最新状态后清除错误且不再重复写入', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;
    storage.setItem.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    preferences.setInputGain(1.4);
    vi.advanceTimersByTime(150);
    expect(preferences.inputGain.value).toBe(1.4);
    expect(preferences.persistenceError.value).toBe('声音设置已生效，但未能保存。');
    expect(storage.values.size).toBe(0);
    preferences.setOutputVolume(0.6);
    preferences.retrySave();
    expect(preferences.persistenceError.value).toBe('');
    expect(JSON.parse([...storage.values.values()][0])).toMatchObject({ inputGain: 1.4, outputVolume: 0.6 });
    vi.advanceTimersByTime(1000);
    scope.stop();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('统一切换处理设置并保存，保留输入音量、成员平衡和原有存储字段', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;
    preferences.setInputGain(1.4);
    const disabled = { echoCancellation: false, noiseSuppression: false,
      autoGainControl: false, voiceEnhancement: false };
    expect(preferences.setProcessing(disabled)).toBe(true);
    expect(preferences.setProcessing(disabled)).toBe(false);
    expect(preferences.processing).toEqual(disabled);
    expect(preferences.inputGain.value).toBe(1.4);
    expect(preferences.voiceVolumeBalance.value).toBe(true);
    vi.advanceTimersByTime(150);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    scope.stop();
    const next = effectScope();
    const restored = next.run(() => useAudioPreferences('local-user', storage))!;
    expect(restored.processing).toEqual(disabled);
    expect(restored.setProcessing({ echoCancellation: true, noiseSuppression: true,
      autoGainControl: true, voiceEnhancement: true })).toBe(true);
    next.stop();
    expect(JSON.parse([...storage.values.values()][0])).toMatchObject({
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceEnhancement: true,
      inputGain: 1.4, voiceVolumeBalance: true,
    });
  });

  it('人声平衡默认开启，独立保存关闭选择且不改动成员静音和麦克风处理', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const scope = effectScope();
    const preferences = scope.run(() => useAudioPreferences('local-user', storage))!;
    expect(preferences.voiceVolumeBalance.value).toBe(true);
    preferences.setParticipantVolume('friend', 0);
    preferences.setVoiceVolumeBalance(false);
    expect(preferences.processing.autoGainControl).toBe(true);
    expect(preferences.participantVolume('friend')).toBe(0);
    scope.stop();
    const next = effectScope();
    expect(next.run(() => useAudioPreferences('local-user', storage))!.voiceVolumeBalance.value).toBe(false);
    expect(next.run(() => useAudioPreferences('other-user', storage))!.voiceVolumeBalance.value).toBe(true);
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

import { describe, expect, it } from 'vitest';
import { loadAudioPreferences, normalizeAudioVolume, saveAudioPreferences,
  unappliedCaptureProcessing } from './audioPreferences';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('audioPreferences', () => {
  it('把音量限制到 0% 至 200%，并以 5% 为步长', () => {
    expect(normalizeAudioVolume(-1)).toBe(0);
    expect(normalizeAudioVolume(1.024)).toBe(1);
    expect(normalizeAudioVolume(1.026)).toBe(1.05);
    expect(normalizeAudioVolume(3)).toBe(2);
    expect(normalizeAudioVolume(Number.NaN)).toBe(1);
  });

  it('按当前账号保存总音量、处理开关和成员音量', () => {
    const storage = memoryStorage();
    expect(saveAudioPreferences('local-user', {
      inputGain: 1.25,
      outputVolume: 0.8,
      screenShareVolume: 0.65,
      voiceVolumeBalance: true,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      voiceEnhancement: false,
      participantVolumes: { 'user-remote': 0 },
      participantLastAudibleVolumes: { 'user-remote': 1.4 },
    }, storage)).toBe(true);

    expect(loadAudioPreferences('local-user', storage)).toEqual({
      inputGain: 1.25,
      outputVolume: 0.8,
      screenShareVolume: 0.65,
      voiceVolumeBalance: true,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      voiceEnhancement: false,
      participantVolumes: { 'user-remote': 0 },
      participantLastAudibleVolumes: { 'user-remote': 1.4 },
    });
    expect(loadAudioPreferences('other-user', storage).outputVolume).toBe(1);
  });

  it('损坏的本地设置回退到安全默认值', () => {
    const storage = { getItem: () => '{broken' };
    expect(loadAudioPreferences('local-user', storage)).toMatchObject({
      inputGain: 1,
      outputVolume: 1,
      echoCancellation: true,
      noiseSuppression: true,
    });
  });

  it('保留旧版偏好并为缺少的处理开关补充默认值', () => {
    const storage = { getItem: () => JSON.stringify({ inputGain: 0.8, outputVolume: 1.2 }) };
    expect(loadAudioPreferences('local-user', storage)).toMatchObject({
      inputGain: 0.8,
      outputVolume: 1.2,
      screenShareVolume: 1,
      voiceVolumeBalance: false,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceEnhancement: true,
    });
  });

  it('只把浏览器明确报告且未采用的采集约束视为未生效', () => {
    const requested = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      voiceEnhancement: true,
    };
    expect(unappliedCaptureProcessing(requested, {
      echoCancellation: true,
      noiseSuppression: true,
    })).toEqual(['noiseSuppression']);
    expect(unappliedCaptureProcessing(requested, {})).toEqual([]);
  });
});

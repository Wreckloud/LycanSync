import { expect, it, vi } from 'vitest';
import { CALL_SOUND_EVENTS, useCallSoundPreferences } from './useCallSoundPreferences';

it('默认开启十种提示，只有一个音量，开关不修改其他事件', () => {
  const storage = { getItem: () => null, setItem: vi.fn() };
  const preferences = useCallSoundPreferences('self', storage);
  expect(CALL_SOUND_EVENTS).toHaveLength(10);
  expect(preferences.volume.value).toBe(1);
  preferences.setEnabled('microphoneOff', false);
  preferences.setVolume(0.4);
  const saved = JSON.parse(storage.setItem.mock.calls.at(-1)![1]);
  expect(saved.volume).toBe(0.4);
  expect(saved.enabled.microphoneOff).toBe(false);
  expect(saved.enabled.participantJoined).toBe(true);
  const restored = useCallSoundPreferences('self', { getItem: () => JSON.stringify(saved), setItem: vi.fn() });
  expect(restored.enabled.microphoneOff).toBe(false);
});

it('错误设置和写入失败明确反馈，当前操作仍可使用', () => {
  const preferences = useCallSoundPreferences('self', { getItem: () => '{bad', setItem: () => { throw new Error('denied'); } });
  expect(preferences.error.value).toContain('无法读取');
  preferences.setCustomEntrances(false);
  expect(preferences.customEntrances.value).toBe(false);
  expect(preferences.error.value).toContain('未能保存');
});

it('升级保留原音量和事件开关，只默认开启新录制提示，移除收听事件', () => {
  const oldEvents = Object.fromEntries(CALL_SOUND_EVENTS.filter(event => !event.id.startsWith('recording')).map(event => [event.id, false]));
  const saved = { volume: 0.3, customEntrances: false, enabled: { ...oldEvents, listeningOn: true, listeningOff: true } };
  const storage = { getItem: () => JSON.stringify(saved), setItem: vi.fn() };
  const preferences = useCallSoundPreferences('self', storage);
  expect(preferences.error.value).toBe('');
  expect(preferences.volume.value).toBe(0.3);
  expect(preferences.customEntrances.value).toBe(false);
  expect(preferences.enabled.joined).toBe(false);
  expect(preferences.enabled.recordingStarted).toBe(true);
  expect(preferences.enabled.recordingStopped).toBe(true);
  expect(preferences.enabled).not.toHaveProperty('listeningOn');
  preferences.setEnabled('recordingStarted', false);
  const next = JSON.parse(storage.setItem.mock.calls[0][1]);
  expect(next.enabled).not.toHaveProperty('listeningOff');
  expect(next.enabled.recordingStarted).toBe(false);
});

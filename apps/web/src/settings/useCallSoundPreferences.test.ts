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
  expect(preferences.error.value).toContain('无法保存');
});

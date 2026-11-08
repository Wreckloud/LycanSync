import { expect, it, vi } from 'vitest';
import { usePresencePreference } from './usePresencePreference';

const desktop = (apiUrl = 'https://friends.test') => ({ getServerSettings: vi.fn(async () => ({ apiUrl, editable: true })) });

it('恢复偏好前保持隐身，缺省在线，按服务器和账号分别保存', async () => {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const preference = usePresencePreference('self', desktop(), storage);
  expect(preference.ready.value).toBe(false);
  expect(preference.mode.value).toBe('invisible');
  await preference.loaded;
  expect(preference.mode.value).toBe('online');
  preference.setMode('invisible');
  expect(storage.setItem).toHaveBeenCalledWith('lycansync.presence-mode.v1.["https://friends.test","self"]', 'invisible');
  await usePresencePreference('other', desktop('https://second.test'), storage).loaded;
  expect(storage.getItem).toHaveBeenLastCalledWith('lycansync.presence-mode.v1.["https://second.test","other"]');
});

it('重新打开恢复隐身，不重置为在线', async () => {
  const preference = usePresencePreference('self', desktop(), { getItem: () => 'invisible', setItem: vi.fn() });
  await preference.loaded;
  expect(preference.mode.value).toBe('invisible');
  expect(preference.error.value).toBe('');
});

it.each(['broken', 'denied'])('偏好损坏或读取失败时不公开在线状态：%s', async failure => {
  const preference = usePresencePreference('self', desktop(), { getItem: () => {
    if (failure === 'denied') throw new Error('denied');
    return failure;
  }, setItem: vi.fn() });
  await preference.loaded;
  expect(preference.mode.value).toBe('invisible');
  expect(preference.error.value).toContain('无法读取');
});

it('写入失败保留当前选择，明确提示不能恢复偏好', async () => {
  const preference = usePresencePreference('self', desktop(), { getItem: () => null, setItem: () => { throw new Error('denied'); } });
  await preference.loaded;
  preference.setMode('invisible');
  expect(preference.mode.value).toBe('invisible');
  expect(preference.error.value).toContain('未能保存');
});

it('无法确定服务器时保持隐身，不写入其他账号的存储键', async () => {
  const storage = { getItem: vi.fn(), setItem: vi.fn() };
  const preference = usePresencePreference('self', { getServerSettings: async () => { throw new Error('unavailable'); } }, storage);
  await preference.loaded;
  expect(preference.mode.value).toBe('invisible');
  preference.setMode('online');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(preference.error.value).toContain('未能保存');
});

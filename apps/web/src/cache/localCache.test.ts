import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { clearLocalContentCache, createAccountCache } from './localCache';

beforeEach(async () => {
  vi.stubGlobal('window', { location: { origin: 'https://first.example' } });
  await clearLocalContentCache();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function cache(user = 'alice') {
  const result = createAccountCache(user);
  result.allowGroups(['group']);
  return result;
}

it('重建账号缓存仍能读取历史，但不同账号或服务器不能串用', async () => {
  await cache().write('messages', 'group', { messages: ['first'] });
  expect(await cache().read('messages', 'group')).toEqual({ messages: ['first'] });
  expect(await cache('bob').read('messages', 'group')).toBeNull();
  vi.stubGlobal('window', { location: { origin: 'https://second.example' } });
  expect(await cache().read('messages', 'group')).toBeNull();
});

it('成员资格未确认时不读写，撤销资格删除本群历史与图片', async () => {
  const first = createAccountCache('alice');
  await first.write('members', 'group', { nickname: '不应写入' });
  first.allowGroups(['group']);
  expect(await first.read('members', 'group')).toBeNull();
  await first.write('messages', 'group', { text: '历史' });
  await first.write('image', 'group', new Blob(['image']), 'picture');
  await first.revokeGroup('group');
  expect(await first.read('messages', 'group')).toBeNull();
  first.allowGroups(['group']);
  expect(await first.read('image', 'group', 'picture')).toBeNull();
  expect(await first.read('messages', 'group')).toBeNull();
});

it('清除后旧实例与尚未完成的账号解析均不能重新落盘', async () => {
  let complete!: (value: { apiUrl: string }) => void;
  vi.stubGlobal('window', { lycanDesktop: { getServerSettings: () => new Promise(resolve => { complete = resolve; }) } });
  const first = cache();
  const pending = first.write('messages', 'group', ['old']);
  await clearLocalContentCache();
  complete({ apiUrl: 'https://first.example' });
  await pending;
  vi.stubGlobal('window', { location: { origin: 'https://first.example' } });
  expect(await cache().read('messages', 'group')).toBeNull();
});

it('总预算跨账号共享，按最近使用淘汰；不会读取全部图片来统计大小', async () => {
  const first = cache();
  const second = cache('bob');
  const image = new Blob(['small fixture']);
  vi.spyOn(image, 'size', 'get').mockReturnValue(60 * 1024 * 1024);
  await first.write('image', 'group', image, 'first');
  await second.write('image', 'group', image, 'second');
  expect(await first.read('image', 'group', 'first')).toBeNull();
  expect(await second.read('image', 'group', 'second')).toBeInstanceOf(Blob);
});

it('过期缓存不作为历史返回，删除时同时移除内容和大小记录', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const first = cache();
  await first.write('messages', 'group', ['history']);
  now.mockReturnValue(1_000 + 31 * 24 * 60 * 60_000);
  expect(await first.read('messages', 'group')).toBeNull();
  const db = await openDB('lycan-content-cache', 1);
  expect(await db.count('entries')).toBe(0);
  expect(await db.count('contents')).toBe(0);
  db.close();
});

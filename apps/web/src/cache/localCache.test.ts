import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { clearLocalContentCache, clearOtherAccountContentCaches, createAccountCache, getLocalContentCacheUsage } from './localCache';

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

it('清除前尚未完成的账号解析不能重新落盘', async () => {
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

it('清理当前账号不删除其他账号，现有实例之后仍能缓存新内容', async () => {
  const first = cache();
  const second = cache('bob');
  await first.write('messages', 'group', ['first']);
  await second.write('messages', 'group', ['second']);
  expect((await getLocalContentCacheUsage('alice')).bytes).toBeGreaterThan(0);
  expect((await getLocalContentCacheUsage()).entries).toBe(2);
  await clearLocalContentCache('alice');
  expect(await first.read('messages', 'group')).toBeNull();
  expect(await second.read('messages', 'group')).toEqual(['second']);
  expect(await getLocalContentCacheUsage('alice')).toEqual({ bytes: 0, entries: 0 });
  await first.write('messages', 'group', ['new']);
  expect(await first.read('messages', 'group')).toEqual(['new']);
});

it('退出立即停用旧实例，迟到结果和再次授权不能恢复写入', async () => {
  const first = cache();
  await first.write('messages', 'group', ['saved']);
  const late = first.write('messages', 'group', ['late']);
  first.dispose();
  first.allowGroups(['group']);
  await late;
  await first.write('messages', 'group', ['disposed']);
  expect(await first.read('messages', 'group')).toBeNull();
  expect(await cache().read('messages', 'group')).toEqual(['saved']);
});

it('仅移除损坏的单条图片，不影响其他图片和聊天记录', async () => {
  const first = cache();
  await first.write('messages', 'group', ['saved']);
  await first.write('image', 'group', new Blob(['bad']), 'bad');
  await first.write('image', 'group', new Blob(['good']), 'good');
  await first.discard('image', 'group', 'bad');
  expect(await first.read('image', 'group', 'bad')).toBeNull();
  expect(await first.read('image', 'group', 'good')).toBeInstanceOf(Blob);
  expect(await first.read('messages', 'group')).toEqual(['saved']);
});

it('重新认证进入后清理其他账号和服务器的残留，保留当前账号缓存', async () => {
  const first = cache();
  await first.write('messages', 'group', ['first']);
  first.dispose();
  const other = cache('bob');
  await other.write('messages', 'group', ['second']);
  other.dispose();
  vi.stubGlobal('window', { location: { origin: 'https://second.example' } });
  const current = cache();
  await current.write('messages', 'group', ['current server']);
  await clearOtherAccountContentCaches('alice', new AbortController().signal);
  expect(await current.read('messages', 'group')).toEqual(['current server']);
  expect((await getLocalContentCacheUsage()).entries).toBe(1);
});

it('登录实例取消后不再执行迟到的其他账号清理', async () => {
  const current = cache('bob');
  await current.write('messages', 'group', ['keep']);
  const controller = new AbortController();
  const clearing = clearOtherAccountContentCaches('alice', controller.signal);
  controller.abort();
  await clearing;
  expect(await current.read('messages', 'group')).toEqual(['keep']);
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

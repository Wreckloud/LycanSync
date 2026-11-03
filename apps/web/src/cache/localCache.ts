import { openDB, type DBSchema } from 'idb';
import type { InjectionKey } from 'vue';

type CacheKind = 'messages' | 'members' | 'image';
interface CacheEntry {
  key: string;
  account: string;
  groupId: string;
  kind: CacheKind;
  bytes: number;
  touchedAt: number;
}
interface CacheDatabase extends DBSchema {
  entries: { key: string; value: CacheEntry; indexes: { touchedAt: number; account: string } };
  contents: { key: string; value: unknown };
}

export interface AccountCache {
  allowGroups(groupIds: string[]): void;
  revokeGroup(groupId: string): Promise<void>;
  read<T>(kind: CacheKind, groupId: string, id?: string): Promise<T | null>;
  write(kind: CacheKind, groupId: string, value: unknown, id?: string): Promise<void>;
}

export const ACCOUNT_CACHE: InjectionKey<AccountCache> = Symbol('account-cache');
const CACHE_BUDGET_BYTES = 100 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 2_000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
let database: ReturnType<typeof openDatabase> | undefined;
let generation = 0;
let warned = false;

function openDatabase() {
  return openDB<CacheDatabase>('lycan-content-cache', 1, {
    upgrade(db) {
      const entries = db.createObjectStore('entries', { keyPath: 'key' });
      entries.createIndex('touchedAt', 'touchedAt');
      entries.createIndex('account', 'account');
      db.createObjectStore('contents');
    },
    blocking() { void database?.then(db => db.close()); database = undefined; },
    terminated() { database = undefined; },
  });
}

async function getDatabase() {
  database ??= openDatabase();
  try { return await database; }
  catch (error) { database = undefined; throw error; }
}

function reportCacheFailure() {
  if (warned) return;
  warned = true;
  // 缓存失败只影响复用，不输出账号、群组、消息或异常正文。
  console.warn('local content cache unavailable');
}

async function accountKey(userId: string) {
  const server = window.lycanDesktop ? (await window.lycanDesktop.getServerSettings()).apiUrl : window.location.origin;
  return JSON.stringify([new URL(server).origin, userId]);
}

export function createAccountCache(userId: string): AccountCache {
  const createdGeneration = generation;
  const account = accountKey(userId).catch(() => { reportCacheFailure(); return null; });
  let allowed = new Set<string>();
  const usable = (groupId: string) => createdGeneration === generation && allowed.has(groupId);
  const key = (owner: string, kind: CacheKind, groupId: string, id = '') => JSON.stringify([owner, groupId, kind, id]);
  return {
    allowGroups(groupIds) { allowed = new Set(groupIds); },
    async revokeGroup(groupId) {
      allowed.delete(groupId);
      try {
        const owner = await account;
        if (!owner) return;
        const db = await getDatabase();
        const tx = db.transaction(['entries', 'contents'], 'readwrite');
        const entries = tx.objectStore('entries');
        for (const entry of await entries.index('account').getAll(owner)) {
          if (entry.groupId !== groupId) continue;
          await entries.delete(entry.key);
          await tx.objectStore('contents').delete(entry.key);
        }
        await tx.done;
      } catch { reportCacheFailure(); }
    },
    async read<T>(kind: CacheKind, groupId: string, id = ''): Promise<T | null> {
      if (!usable(groupId)) return null;
      try {
        const owner = await account;
        if (!owner || !usable(groupId)) return null;
        const db = await getDatabase();
        if (!usable(groupId)) return null;
        const tx = db.transaction(['entries', 'contents'], 'readwrite');
        const entryKey = key(owner, kind, groupId, id);
        const entry = await tx.objectStore('entries').get(entryKey);
        let value: unknown = null;
        if (entry && entry.touchedAt > Date.now() - CACHE_MAX_AGE_MS) {
          value = await tx.objectStore('contents').get(entryKey);
          await tx.objectStore('entries').put({ ...entry, touchedAt: Date.now() });
        } else if (entry) {
          await tx.objectStore('entries').delete(entryKey);
          await tx.objectStore('contents').delete(entryKey);
        }
        await tx.done;
        return usable(groupId) ? (value as T | undefined) ?? null : null;
      } catch { reportCacheFailure(); return null; }
    },
    async write(kind, groupId, value, id = '') {
      if (!usable(groupId)) return;
      try {
        const serialized = value instanceof Blob ? null : JSON.stringify(value);
        const stored = serialized === null ? value : JSON.parse(serialized);
        const bytes = value instanceof Blob ? value.size : new TextEncoder().encode(serialized!).byteLength;
        if (bytes > CACHE_BUDGET_BYTES) return;
        const owner = await account;
        if (!owner || !usable(groupId)) return;
        const db = await getDatabase();
        if (!usable(groupId)) return;
        const tx = db.transaction(['entries', 'contents'], 'readwrite');
        const entries = tx.objectStore('entries');
        const contents = tx.objectStore('contents');
        const entryKey = key(owner, kind, groupId, id);
        // 只遍历小型元数据，不把全部图片读入内存；预算在同一写事务内维护。
        const metadata = await entries.index('touchedAt').getAll();
        let used = metadata.reduce((sum, entry) => sum + (entry.key === entryKey ? 0 : entry.bytes), 0);
        let count = metadata.filter(entry => entry.key !== entryKey).length;
        const cutoff = Date.now() - CACHE_MAX_AGE_MS;
        for (const entry of metadata) {
          if (entry.key === entryKey) continue;
          if (entry.touchedAt >= cutoff && used + bytes <= CACHE_BUDGET_BYTES && count < CACHE_MAX_ENTRIES) continue;
          await entries.delete(entry.key);
          await contents.delete(entry.key);
          used -= entry.bytes;
          count--;
        }
        await entries.put({ key: entryKey, account: owner, groupId, kind, bytes, touchedAt: Date.now() });
        await contents.put(stored, entryKey);
        await tx.done;
      } catch { reportCacheFailure(); }
    },
  };
}

export async function clearLocalContentCache() {
  // 先撤销旧实例的写资格，避免清除凭据后迟到的请求重新落盘。
  generation++;
  const db = await getDatabase();
  const tx = db.transaction(['entries', 'contents'], 'readwrite');
  await Promise.all([tx.objectStore('entries').clear(), tx.objectStore('contents').clear(), tx.done]);
}

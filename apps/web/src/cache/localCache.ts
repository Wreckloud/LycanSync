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
  readonly revision: number;
  dispose(): void;
  allowGroups(groupIds: string[]): void;
  revokeGroup(groupId: string): Promise<void>;
  discard(kind: CacheKind, groupId: string, id?: string): Promise<void>;
  read<T>(kind: CacheKind, groupId: string, id?: string): Promise<T | null>;
  write(kind: CacheKind, groupId: string, value: unknown, id?: string): Promise<void>;
}

export const ACCOUNT_CACHE: InjectionKey<AccountCache> = Symbol('account-cache');
const CACHE_BUDGET_BYTES = 100 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 2_000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
let database: ReturnType<typeof openDatabase> | undefined;
let generation = 0;
let clearing = 0;
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
  const account = accountKey(userId).catch(() => { reportCacheFailure(); return null; });
  let disposed = false;
  let permissionsRevision = 0;
  let allowed = new Set<string>();
  const usable = (groupId: string) => !disposed && !clearing && allowed.has(groupId);
  const operation = (groupId: string) => {
    const started = generation;
    const permissions = permissionsRevision;
    const available = usable(groupId);
    return () => available && started === generation && permissions === permissionsRevision && usable(groupId);
  };
  const key = (owner: string, kind: CacheKind, groupId: string, id = '') => JSON.stringify([owner, groupId, kind, id]);
  return {
    get revision() { return generation; },
    dispose() { disposed = true; allowed.clear(); },
    allowGroups(groupIds) {
      if (disposed) return;
      const next = new Set(groupIds);
      if ([...allowed].some(groupId => !next.has(groupId))) permissionsRevision++;
      allowed = next;
    },
    async revokeGroup(groupId) {
      permissionsRevision++;
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
    async discard(kind, groupId, id = '') {
      try {
        const owner = await account;
        if (!owner) return;
        const db = await getDatabase();
        const tx = db.transaction(['entries', 'contents'], 'readwrite');
        const entryKey = key(owner, kind, groupId, id);
        await tx.objectStore('entries').delete(entryKey);
        await tx.objectStore('contents').delete(entryKey);
        await tx.done;
      } catch { reportCacheFailure(); }
    },
    async read<T>(kind: CacheKind, groupId: string, id = ''): Promise<T | null> {
      const current = operation(groupId);
      if (!current()) return null;
      try {
        const owner = await account;
        if (!owner || !current()) return null;
        const db = await getDatabase();
        if (!current()) return null;
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
        return current() ? (value as T | undefined) ?? null : null;
      } catch { reportCacheFailure(); return null; }
    },
    async write(kind, groupId, value, id = '') {
      const current = operation(groupId);
      if (!current()) return;
      try {
        const serialized = value instanceof Blob ? null : JSON.stringify(value);
        const stored = serialized === null ? value : JSON.parse(serialized);
        const bytes = value instanceof Blob ? value.size : new TextEncoder().encode(serialized!).byteLength;
        if (bytes > CACHE_BUDGET_BYTES) return;
        const owner = await account;
        if (!owner || !current()) return;
        const db = await getDatabase();
        if (!current()) return;
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
        if (current()) {
          await entries.put({ key: entryKey, account: owner, groupId, kind, bytes, touchedAt: Date.now() });
          await contents.put(stored, entryKey);
        }
        await tx.done;
      } catch { reportCacheFailure(); }
    },
  };
}

export async function getLocalContentCacheUsage(userId?: string) {
  const owner = userId ? await accountKey(userId) : undefined;
  const db = await getDatabase();
  const entries = owner ? await db.getAllFromIndex('entries', 'account', owner) : await db.getAll('entries');
  return { bytes: entries.reduce((total, entry) => total + entry.bytes, 0), entries: entries.length };
}

export async function clearOtherAccountContentCaches(userId: string, signal: AbortSignal) {
  const owner = await accountKey(userId);
  if (signal.aborted) return;
  const db = await getDatabase();
  if (signal.aborted) return;
  const tx = db.transaction(['entries', 'contents'], 'readwrite');
  for (const entry of await tx.objectStore('entries').getAll()) {
    if (signal.aborted) { tx.abort(); break; }
    if (entry.account === owner) continue;
    await tx.objectStore('entries').delete(entry.key);
    await tx.objectStore('contents').delete(entry.key);
  }
  await tx.done;
}

export async function clearLocalContentCache(userId?: string) {
  // 撤销清理前的异步读写；清理完成后仍允许当前账号发起新的缓存请求。
  generation++;
  clearing++;
  try {
    const owner = userId ? await accountKey(userId) : undefined;
    const db = await getDatabase();
    const tx = db.transaction(['entries', 'contents'], 'readwrite');
    if (owner) {
      for (const entry of await tx.objectStore('entries').index('account').getAll(owner)) {
        await tx.objectStore('entries').delete(entry.key);
        await tx.objectStore('contents').delete(entry.key);
      }
    } else {
      await tx.objectStore('entries').clear();
      await tx.objectStore('contents').clear();
    }
    await tx.done;
  } finally { clearing--; }
}

import { effectScope, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../auth/authApi';
import type { AccountCache } from '../cache/localCache';
import { findMessages, type ChatMessage, type ChatMessagePage } from './chatApi';
import { useGroupMessages } from './useGroupMessages';

vi.mock('./chatApi', () => ({ findMessages: vi.fn() }));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function message(id: string): ChatMessage {
  return { id, senderUserId: 'friend', senderNickname: '朋友', type: 'TEXT', content: id,
    createdAt: '2026-11-11T12:00:00Z', attachment: null };
}

function setup() {
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const scope = effectScope(); scopes.push(scope);
  const cache: AccountCache = { revision: 0, read: vi.fn().mockResolvedValue(null), write: vi.fn(),
    discard: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn(), dispose: vi.fn() };
  const scroll: Parameters<typeof useGroupMessages>[0]['scroll'] = {
    list: ref({} as HTMLElement), atBottom: ref(false), followingScroll: ref(false), unreadMessageIds: ref<string[]>([]),
    scrollToBottom: vi.fn().mockResolvedValue(undefined), updateReadMessages: vi.fn(),
    preserveHistoryPosition: vi.fn(() => vi.fn()), finishHistoryLoad: vi.fn(),
    resetReadingPosition: vi.fn(() => { scroll.unreadMessageIds.value = []; }),
  };
  const initialLoad = vi.fn();
  const messages = scope.run(() => useGroupMessages({ getGroupId: () => 'group', getUserId: () => 'self',
    cache, scroll, onInitialLoad: initialLoad }))!;
  return { scope, cache, scroll, messages, initialLoad };
}

it.each([400, 403, 404])('刷新确认不可用（%s）后，取消历史并阻止迟到历史恢复内容', async status => {
  const f = setup();
  vi.mocked(findMessages).mockResolvedValueOnce({ messages: [message('base')], hasMore: true });
  await f.messages.refresh();
  let finish!: (page: ChatMessagePage) => void;
  vi.mocked(findMessages).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const history = f.messages.loadOlder();
  const signal = vi.mocked(findMessages).mock.calls.at(-1)![2]!;
  f.scroll.unreadMessageIds.value = ['unread'];
  vi.mocked(findMessages).mockRejectedValueOnce(new ApiRequestError(status, 'unavailable', '无法读取群聊'));
  await f.messages.refresh();
  expect(signal.aborted).toBe(true);
  expect(f.messages.loadingOlder.value).toBe(false);
  expect(f.messages.hasMore.value).toBe(false);
  expect(f.scroll.unreadMessageIds.value).toEqual([]);
  finish({ messages: [message('late-history')], hasMore: true });
  await history;
  expect(f.messages.messages.value).toEqual([]);
  expect(f.messages.initialLoaded.value).toBe(false);
  expect(f.messages.pollError.value).toBe('无法读取群聊');
  expect(f.cache.revokeGroup).toHaveBeenCalledTimes(status === 400 ? 0 : 1);
});

it('临时网络故障保留消息和正在读取的历史，重试继续使用已确认游标', async () => {
  const f = setup();
  vi.mocked(findMessages).mockResolvedValueOnce({ messages: [message('base')], hasMore: true });
  await f.messages.refresh();
  let finish!: (page: ChatMessagePage) => void;
  vi.mocked(findMessages).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const history = f.messages.loadOlder();
  const signal = vi.mocked(findMessages).mock.calls.at(-1)![2]!;
  vi.mocked(findMessages).mockRejectedValueOnce(new Error('连接中断'));
  await f.messages.refresh();
  expect(signal.aborted).toBe(false);
  expect(f.messages.messages.value.map(item => item.id)).toEqual(['base']);
  finish({ messages: [message('older')], hasMore: false }); await history;
  vi.mocked(findMessages).mockResolvedValueOnce({ messages: [message('new')], hasMore: false });
  await f.messages.refresh();
  expect(vi.mocked(findMessages).mock.calls.at(-1)![1]).toEqual({ afterMessageId: 'base' });
  expect(f.messages.messages.value.map(item => item.id)).toEqual(['older', 'base', 'new']);
  expect(f.cache.revokeGroup).not.toHaveBeenCalled();
});

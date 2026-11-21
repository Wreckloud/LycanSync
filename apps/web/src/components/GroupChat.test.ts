import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatScroll } from '../chat/useChatScroll';
import { useGroupMessages } from '../chat/useGroupMessages';
import { createChatTransfers, CHAT_TRANSFERS } from '../chat/useChatTransfers';
import { declareFile, sendFile as requestFile, sendMessage as requestMessage, findMessages as requestMessages, stopFile } from '../chat/chatApi';
import type { ChatMessage, ChatMessagePage } from '../chat/chatApi';
import type { AccountCache } from '../cache/localCache';
import { formatFullMessageTime, formatMessageDateDivider, formatMessageTime, localDateKey } from '../chat/messageTime';
import { useLoadingHint } from './useLoadingHint';
import { chatMediaFormat, formatAttachmentSize } from '../chat/chatMedia';
import defaultAvatar from '../../../../services/api/src/main/resources/account/default.png';

vi.mock('../chat/chatApi', () => ({ findMessages: vi.fn(), declareFile: vi.fn(), sendFile: vi.fn(), sendMessage: vi.fn(), stopFile: vi.fn() }));

const script = parse(readFileSync(new URL('./GroupChat.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('GroupChat.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function message(id: string): ChatMessage {
  return { id, senderUserId: 'self', senderNickname: '自己', type: 'TEXT', content: id,
    createdAt: '2026-10-14T12:00:00Z', attachment: null };
}

function setup(cache: AccountCache | null = null) {
  const scope = effectScope();
  const props = reactive({ group: { id: 'first', name: '群聊' }, members: [], user: { id: 'self', nickname: '自己' }, syncError: '', recordingAttachment: undefined as RecordingLibraryEntry | undefined });
  const findMessages = vi.fn(async (_groupId: string, _cursor?: unknown, _signal?: AbortSignal): Promise<ChatMessagePage> =>
    ({ messages: [], hasMore: false }));
  vi.mocked(requestMessages).mockImplementation(findMessages);
  const sendMessage = vi.fn(async (_groupId: string, _text: string, _image?: File, _signal?: AbortSignal, _id?: string) => message('sent'));
  const sendFile = vi.fn(async (_groupId: string, _file: File, _text: string, id: string, _signal: AbortSignal) => message(id));
  vi.mocked(requestMessage).mockImplementation(sendMessage);
  vi.mocked(requestFile).mockImplementation((groupId, file, content, _attempt, signal, _progress, id) =>
    sendFile(groupId, file as File, content, id!, signal));
  vi.mocked(declareFile).mockImplementation(async (_group, id, _attempt, file) => ({ ...message(id), type: 'FILE',
    attachment: { id, fileName: file.name, byteSize: file.size, contentType: '', transferStatus: 'PENDING' } }));
  const body = {};
  const document = { visibilityState: 'visible', removeEventListener: vi.fn(), body, activeElement: body as unknown };
  const scrollPreference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const window = { removeEventListener: vi.fn(), matchMedia: () => scrollPreference };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const emit = vi.fn();
  const fetchRecording = vi.fn(async (_source: string, _options: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetchRecording);
  const transfers = createChatTransfers({ ...props.user, avatar: '', administrator: false }, id => emit('messageSent', id));
  const uploadLimits = vi.fn(async () => ({ maxFileBytes: 512 * 1024 ** 2 }));
  // 真实组件的任务、监听和销毁；只替换网络、DOM 与图片边界，不启动浏览器或传输文件。
  const chat = scope.run(() => runInNewContext(`${compiled}\n({ ...synchronization, ...scroll, handleVisibilityChange, submit, enqueueFiles, attachmentKind, pendingPreview,
    text, error, syncError, retrySync, pendingAttachments, initialLoadingHint, historyLoadingHint, refreshCalendar, calendarNow, senderName, senderAvatar, messageInput,
    setScrollPreference: value => { Object.assign(scrollPreference, value); } })`, {
    computed, ref, watch, nextTick, onScopeDispose, useLoadingHint, useComposerHeight: () => () => {}, onMounted: () => {}, defineProps: () => props, defineEmits: () => emit,
    inject: (key: symbol) => key === CHAT_TRANSFERS ? transfers : cache, CHAT_TRANSFERS, ACCOUNT_CACHE: Symbol(), uploadLimits,
    sendMessage, sendFile, compressChatImage: vi.fn(), defaultAvatar,
    formatFullMessageTime, formatMessageDateDivider, formatMessageTime, localDateKey,
    AbortController, ReadableStream, crypto, fetch: fetchRecording, setTimeout, clearTimeout, Error, Date, chatMediaFormat, formatAttachmentSize,
    document, window, scrollPreference, useChatScroll, useGroupMessages, URL: { revokeObjectURL: vi.fn(), createObjectURL: vi.fn(() => 'blob:preview') },
  })) as {
    enqueueFiles(files: File[], compress: boolean): Promise<void>;
    attachmentKind(item: unknown): string | undefined;
    pendingPreview: { value: unknown };
    senderName(message: ChatMessage): string; senderAvatar(message: ChatMessage): string;
    messageInput: { value: unknown };
    refresh: () => Promise<number | null>; submit: (restoreFocus?: boolean) => Promise<void>;
    loadOlder: () => Promise<void>; handleVisibilityChange: () => void; list: { value: HTMLElement | null };
    historyError: { value: string };
    initialLoaded: { value: boolean }; initialLoadingHint: { value: boolean }; historyLoadingHint: { value: boolean };
    refreshing: { value: boolean }; pollError: { value: string };
    syncError: { value: string | undefined }; retrySync(): void;
    atBottom: { value: boolean }; unseenMessages: { value: number }; retryRefresh(): Promise<void> | undefined;
    unreadMessageIds: { value: string[] }; showMessageJump: { value: boolean }; messageJumpLabel: { value: string };
    jumpToMessages(): Promise<void>; updateReadMessages(): void; onScroll(): void;
    refreshCalendar(): void; calendarNow: { value: Date };
    scrollToBottom(behavior?: ScrollBehavior, force?: boolean): Promise<void>; onScrollEnd(): void;
    onWheel(event: WheelEvent): void; stopAnimatedScroll(): void;
    setScrollPreference(value: { matches: boolean; removeEventListener: ReturnType<typeof vi.fn> }): void;
    messages: { value: ChatMessage[] }; text: { value: string }; error: { value: string };
    pendingAttachments: { value: Array<{ id: string; kind: 'FILE'; file: File; previewUrl: string;
      state: 'pending' | 'uploading' | 'failed' | 'sent'; progress: number; error: string }> };
  };
  return { scope, props, chat, findMessages, sendMessage, sendFile, fetchRecording, document, emit, transfers, uploadLimits };
}

it('注销消息忽略旧头像与昵称缓存，显示注册使用的默认头像', () => {
  const f = setup();
  try {
    const closed = { ...message('closed'), senderNickname: '旧昵称', senderAvatar: 'https://example.com/old.png', senderDeletedAt: '2026-11-15T00:00:00Z' };
    expect(f.chat.senderName(closed)).toBe('账号已注销');
    expect(f.chat.senderAvatar(closed)).toBe(defaultAvatar);
    expect(f.chat.senderName(message('active'))).toBe('自己');
  } finally { f.scope.stop(); }
});

it('消息与成员同步失败只选取一条顶部反馈，重试同时恢复两处同步且保留草稿', async () => {
  const f = setup();
  try {
    await f.chat.refresh();
    f.chat.text.value = '保留草稿';
    f.props.syncError = '无法读取群组资料';
    expect(f.chat.syncError.value).toBe('无法读取群组资料');
    f.findMessages.mockRejectedValueOnce(new Error('消息同步失败'));
    await f.chat.refresh();
    expect(f.chat.syncError.value).toBe('消息同步失败');
    f.chat.retrySync();
    expect(f.emit).toHaveBeenCalledWith('retrySync');
    await vi.waitFor(() => expect(f.chat.pollError.value).toBe(''));
    expect(f.chat.syncError.value).toBe('无法读取群组资料');
    f.props.syncError = '';
    expect(f.chat.syncError.value).toBe('');
    expect(f.chat.text.value).toBe('保留草稿');
  } finally { f.scope.stop(); }
});

it('首次消息读取失败保留原读取区反馈，不在标题重复展示成员错误', async () => {
  const f = setup();
  try {
    f.props.syncError = '暂时无法更新成员状态。';
    f.findMessages.mockRejectedValueOnce(new Error('消息暂时无法读取'));
    await f.chat.refresh();
    expect(f.chat.initialLoaded.value).toBe(false);
    expect(f.chat.pollError.value).toBe('消息暂时无法读取');
    expect(f.chat.syncError.value).toBe('');
    f.chat.retrySync();
    expect(f.emit).toHaveBeenCalledWith('retrySync');
    await vi.waitFor(() => expect(f.chat.initialLoaded.value).toBe(true));
  } finally { f.scope.stop(); }
});

it('空聊天也保存确认快照，返回时沿用已知空状态并直接同步新消息', async () => {
  const cache = { read: vi.fn().mockResolvedValue(null), write: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const first = setup(cache);
  await first.chat.refresh();
  first.scope.stop();
  expect(cache.write).toHaveBeenCalledWith('messages', 'first', { messages: [], hasMore: false });
  vi.mocked(cache.read).mockResolvedValueOnce({ messages: [], hasMore: false });
  const next = setup(cache);
  const page = deferred<ChatMessagePage>();
  next.findMessages.mockReturnValueOnce(page.promise);
  try {
    const reading = next.chat.refresh();
    await vi.waitFor(() => expect(next.findMessages).toHaveBeenCalledOnce());
    expect(next.chat.initialLoaded.value).toBe(true);
    expect(next.chat.initialLoadingHint.value).toBe(false);
    page.resolve({ messages: [message('new')], hasMore: false });
    await reading;
    expect(next.chat.messages.value.map(message => message.id)).toEqual(['new']);
    expect(next.findMessages).toHaveBeenCalledTimes(1);
  } finally { next.scope.stop(); }
});

it('短暂读取磁盘期间不显示加载字样，缓存到达即展示并取消加载提示', async () => {
  vi.useFakeTimers();
  const cached = deferred<{ messages: ChatMessage[]; hasMore: boolean }>();
  const page = deferred<ChatMessagePage>();
  const cache = { read: vi.fn().mockReturnValue(cached.promise), write: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  f.findMessages.mockReturnValueOnce(page.promise);
  try {
    const reading = f.chat.refresh();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.chat.initialLoadingHint.value).toBe(false);
    cached.resolve({ messages: [message('cached')], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.chat.messages.value.map(message => message.id)).toEqual(['cached']);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.chat.initialLoadingHint.value).toBe(false);
    page.resolve({ messages: [], hasMore: false });
    await reading;
  } finally { f.scope.stop(); vi.useRealTimers(); }
});

it('命中历史先展示已确认快照，随后按最后游标补齐新消息并更新缓存', async () => {
  const cache = { read: vi.fn().mockResolvedValue({ messages: [message('cached')], hasMore: true }),
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  const page = deferred<ChatMessagePage>();
  f.findMessages.mockReturnValueOnce(page.promise);
  try {
    const refreshing = f.chat.refresh();
    await vi.waitFor(() => expect(f.findMessages).toHaveBeenCalledOnce());
    expect(f.chat.messages.value.map(message => message.id)).toEqual(['cached']);
    expect(f.findMessages).toHaveBeenCalledWith('first', { afterMessageId: 'cached' }, expect.any(AbortSignal), false);
    page.resolve({ messages: [message('new')], hasMore: false });
    await refreshing;
    expect(f.chat.messages.value.map(message => message.id)).toEqual(['cached', 'new']);
    expect(cache.write).not.toHaveBeenCalled();
    f.scope.stop();
    expect(cache.write).toHaveBeenCalledWith('messages', 'first', { messages: [message('cached'), message('new')], hasMore: true });
  } finally { f.scope.stop(); }
});

it('切群销毁后迟到的缓存不能展示，也不能发起旧群网络读取', async () => {
  const cached = deferred<{ messages: ChatMessage[]; hasMore: boolean }>();
  const cache = { read: vi.fn().mockReturnValue(cached.promise), write: vi.fn(),
    revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  const refreshing = f.chat.refresh();
  f.scope.stop();
  cached.resolve({ messages: [message('old')], hasMore: false });
  await refreshing;
  expect(f.findMessages).not.toHaveBeenCalled();
  expect(f.chat.messages.value).toEqual([]);
});

it('命中缓存后首次联网被隐藏取消，恢复时直接同步并只通知一次加载完成', async () => {
  const cache = { read: vi.fn().mockResolvedValue({ messages: [message('cached')], hasMore: false }),
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  const page = deferred<ChatMessagePage>();
  f.findMessages.mockReturnValueOnce(page.promise);
  try {
    const reading = f.chat.refresh();
    await vi.waitFor(() => expect(f.findMessages).toHaveBeenCalledOnce());
    f.document.visibilityState = 'hidden';
    f.chat.handleVisibilityChange();
    page.resolve({ messages: [], hasMore: false });
    await reading;
    expect(f.emit).not.toHaveBeenCalled();
    f.document.visibilityState = 'visible';
    await f.chat.retryRefresh();
    expect(f.findMessages).toHaveBeenLastCalledWith('first', { afterMessageId: 'cached' }, expect.any(AbortSignal), false);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('initialLoad', 'first');
    await f.chat.refresh();
    expect(f.emit).toHaveBeenCalledTimes(1);
  } finally { f.scope.stop(); }
});

it('历史落后较多时只补取最近一页，不拼接有缺口的缓存历史', async () => {
  const cache = { read: vi.fn().mockResolvedValue({ messages: [message('old')], hasMore: false }),
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn(), revision: 0, dispose: vi.fn(), discard: vi.fn() } as AccountCache;
  const f = setup(cache);
  try {
    f.findMessages.mockResolvedValueOnce({ messages: Array.from({ length: 31 }, (_, index) => message(`missed-${index}`)), hasMore: false })
      .mockResolvedValueOnce({ messages: [message('latest')], hasMore: true });
    await f.chat.refresh();
    expect(f.findMessages).toHaveBeenCalledTimes(2);
    expect(f.findMessages.mock.calls[1][1]).toBeUndefined();
    expect(f.chat.messages.value.map(message => message.id)).toEqual(['latest']);
  } finally { f.scope.stop(); }
});

it('首批消息失败也通知初始等待结束，保留区域内重试；取消的旧请求不通知', async () => {
  const { scope, chat, findMessages, emit } = setup();
  const old = deferred<ChatMessagePage>();
  const current = deferred<ChatMessagePage>();
  findMessages.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  try {
    const first = chat.refresh();
    const second = chat.refresh();
    old.resolve({ messages: [], hasMore: false });
    await first;
    expect(emit).not.toHaveBeenCalled();
    current.reject(new Error('消息暂时不可用'));
    await second;
    expect(emit).toHaveBeenCalledExactlyOnceWith('initialLoad', 'first');
    expect(chat.pollError.value).toBe('消息暂时不可用');
    expect(chat.initialLoaded.value).toBe(false);
  } finally { scope.stop(); }
});

it.each([false, true])('首批快照迟于本机发送，保留服务端顺序并去重（快照含本机消息：%s）', async (includesSent) => {
  const { scope, chat, findMessages } = setup();
  try {
    const page = deferred<ChatMessagePage>();
    findMessages.mockReturnValueOnce(page.promise);
    const refreshing = chat.refresh();
    chat.text.value = '新消息';
    await chat.submit();
    page.resolve({ messages: [message('older'), ...(includesSent ? [message('sent'), message('newer')] : [])], hasMore: true });
    await refreshing;
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(includesSent ? ['older', 'sent', 'newer'] : ['older', 'sent']);
    await chat.refresh();
    expect(findMessages.mock.calls.at(-1)?.[1]).toEqual({ afterMessageId: includesSent ? 'newer' : 'older' });
  } finally { scope.stop(); }
});

it('首次读取失败不伪装为空会话，手动重试期间不重复创建请求', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockRejectedValueOnce(new Error('读取失败'));
    await chat.refresh();
    expect(chat.initialLoaded.value).toBe(false);
    expect(chat.pollError.value).toBe('读取失败');
    const pending = deferred<ChatMessagePage>();
    findMessages.mockReturnValueOnce(pending.promise);
    const retry = chat.retryRefresh();
    chat.retryRefresh();
    expect(findMessages).toHaveBeenCalledTimes(2);
    expect(chat.refreshing.value).toBe(true);
    pending.resolve({ messages: [], hasMore: false });
    await retry;
    expect(chat.initialLoaded.value).toBe(true);
    expect(chat.refreshing.value).toBe(false);
    expect(chat.pollError.value).toBe('');
  } finally { scope.stop(); }
});

it('阅读历史时只累计新取得的消息数，重复快照不重复计数', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('cursor')], hasMore: false });
    await chat.refresh();
    await nextTick();
    chat.atBottom.value = false;
    const incoming = { ...message('new'), senderUserId: 'friend' };
    findMessages.mockResolvedValueOnce({ messages: [incoming, incoming, message('own')], hasMore: false });
    await chat.refresh();
    expect(chat.atBottom.value).toBe(false);
    expect(chat.unseenMessages.value).toBe(1);
    findMessages.mockResolvedValueOnce({ messages: [incoming], hasMore: false });
    await chat.refresh();
    expect(chat.unseenMessages.value).toBe(1);
  } finally { scope.stop(); }
});

it.each(['wheel', 'reduce'] as const)('平滑滚动未到底就被%s打断，保留新消息数，到底后再清零', async interruptedBy => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 3000, clientHeight: 600, scrollTop: 200,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }), querySelectorAll: () => [],
      scrollTo: vi.fn((options: ScrollToOptions) => {
        if (options.behavior === 'auto') element.scrollTop = Math.min(options.top!, 2400);
      }) };
    chat.list.value = element as unknown as HTMLElement;
    chat.atBottom.value = false;
    chat.unreadMessageIds.value = ['one', 'two', 'three', 'four', 'five'];
    await chat.scrollToBottom('smooth', true);
    expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(2200);
    expect(chat.atBottom.value).toBe(false);
    expect(chat.unseenMessages.value).toBe(5);
    element.scrollTop = 700;
    if (interruptedBy === 'reduce') {
      chat.setScrollPreference({ matches: true, removeEventListener: vi.fn() });
      chat.stopAnimatedScroll();
      expect(element.scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'auto' });
    } else {
      chat.onWheel({ deltaY: -100 } as WheelEvent);
      chat.onScrollEnd();
    }
    expect(chat.atBottom.value).toBe(false);
    expect(chat.unseenMessages.value).toBe(5);
    element.scrollTop = 2400;
    chat.onScrollEnd();
    expect(chat.atBottom.value).toBe(true);
    expect(chat.unseenMessages.value).toBe(0);
  } finally { scope.stop(); }
});

it('减少动态效果的即时定位确实到底后清零', async () => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 3000, clientHeight: 600, scrollTop: 200,
      scrollTo: vi.fn((options: ScrollToOptions) => { element.scrollTop = Math.min(options.top!, 2400); }) };
    chat.list.value = element as unknown as HTMLElement;
    chat.atBottom.value = false;
    chat.unreadMessageIds.value = ['one', 'two', 'three', 'four', 'five'];
    chat.setScrollPreference({ matches: true, removeEventListener: vi.fn() });
    await chat.scrollToBottom('smooth', true);
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'auto' });
    expect(chat.atBottom.value).toBe(true);
    expect(chat.unseenMessages.value).toBe(0);
  } finally { scope.stop(); }
});

it('向上翻历史不显示回到最新；向下返回且超过一屏才显示', () => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 3000, clientHeight: 600, scrollTop: 2400,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
    chat.list.value = element as HTMLElement;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 500;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 700;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(true);
    element.scrollTop = 650;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 1790;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(true);
    element.scrollTop = 1800;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 1799;
    chat.onScroll();
    element.scrollTop = 1801;
    chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
  } finally { scope.stop(); }
});

it('向下累计48像素才显示，向上返回后重新累计，不因小幅滚动反复触发', () => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 3000, clientHeight: 600, scrollTop: 2400,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
    chat.list.value = element as HTMLElement;
    chat.onScroll();
    element.scrollTop = 500; chat.onScroll();
    for (const top of [501, 510, 547]) {
      element.scrollTop = top; chat.onScroll();
      expect(chat.showMessageJump.value).toBe(false);
    }
    element.scrollTop = 548; chat.onScroll();
    expect(chat.showMessageJump.value).toBe(true);
    expect(chat.messageJumpLabel.value).toBe('回到最新');
    element.scrollTop = 500; chat.onScroll();
    element.scrollTop = 530; chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 520; chat.onScroll();
    element.scrollTop = 567; chat.onScroll();
    expect(chat.showMessageJump.value).toBe(false);
    element.scrollTop = 568; chat.onScroll();
    expect(chat.showMessageJump.value).toBe(true);
  } finally { scope.stop(); }
});

it.each([false, true])('跳转首条未读，不跳过后续未读，减少动态效果：%s', async reduce => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('cursor')], hasMore: false });
    await chat.refresh();
    await nextTick();
    const positions = new Map([['first', 1200], ['second', 2100], ['third', 2700]]);
    const element = { scrollHeight: 4000, clientHeight: 600, scrollTop: 200,
      getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
      querySelectorAll: () => [...positions].map(([id, top]) => ({ dataset: { messageId: id },
        getBoundingClientRect: () => ({ top: 100 + top - element.scrollTop, bottom: 180 + top - element.scrollTop }) })),
      scrollTo: vi.fn((options: ScrollToOptions) => {
        if (options.behavior === 'auto') element.scrollTop = options.top!;
      }) };
    chat.list.value = element as unknown as HTMLElement;
    chat.atBottom.value = false;
    chat.setScrollPreference({ matches: reduce, removeEventListener: vi.fn() });
    const incoming = ['first', 'second'].map(id => ({ ...message(id), senderUserId: 'friend' }));
    findMessages.mockResolvedValueOnce({ messages: incoming, hasMore: false });
    await chat.refresh();
    expect(chat.showMessageJump.value).toBe(true);
    expect(chat.messageJumpLabel.value).toBe('2 条新消息 · 跳转到未读');
    await chat.jumpToMessages();
    expect(element.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: reduce ? 'auto' : 'smooth' });
    if (!reduce) {
      expect(chat.unseenMessages.value).toBe(2);
      // 动画尚未抵达时的新消息不能把“跳转未读”改成“跟随到底”。
      findMessages.mockResolvedValueOnce({ messages: [{ ...message('third'), senderUserId: 'friend' }], hasMore: false });
      await chat.refresh();
      expect(element.scrollTo).toHaveBeenCalledTimes(1);
      expect(chat.unseenMessages.value).toBe(3);
      element.scrollTop = 1200;
      chat.onScrollEnd();
    }
    expect(chat.unreadMessageIds.value).toEqual(reduce ? ['second'] : ['second', 'third']);
    expect(chat.atBottom.value).toBe(false);
    element.scrollTop = 3400;
    chat.onScrollEnd();
    expect(chat.unseenMessages.value).toBe(0);
  } finally { scope.stop(); }
});

it('未读定位中途被打断不清零；手动读到其中一条只移除该条', async () => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 4000, clientHeight: 600, scrollTop: 100,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      querySelectorAll: () => [1500, 2500].map((top, index) => ({ dataset: { messageId: String(index) },
        getBoundingClientRect: () => ({ top: top - element.scrollTop, bottom: top + 80 - element.scrollTop }) })),
      scrollTo: vi.fn() };
    chat.list.value = element as unknown as HTMLElement;
    chat.unreadMessageIds.value = ['0', '1'];
    await chat.jumpToMessages();
    element.scrollTop = 500;
    chat.onWheel({ deltaY: -100 } as WheelEvent);
    chat.onScrollEnd();
    expect(chat.unseenMessages.value).toBe(2);
    element.scrollTop = 1500;
    chat.onScroll();
    expect(chat.unreadMessageIds.value).toEqual(['1']);
  } finally { scope.stop(); }
});

it('语音覆盖下的消息不能误标已读，定位时避开覆盖区域', async () => {
  const { scope, chat } = setup();
  try {
    const element = { scrollHeight: 3000, clientHeight: 600, scrollTop: 500,
      parentElement: { closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 400 }) }) }) },
      getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
      querySelectorAll: () => [{ dataset: { messageId: 'covered' },
        getBoundingClientRect: () => ({ top: 700 - element.scrollTop, bottom: 780 - element.scrollTop }) }],
      scrollTo: vi.fn((options: ScrollToOptions) => { element.scrollTop = options.top!; }) };
    chat.list.value = element as unknown as HTMLElement;
    chat.unreadMessageIds.value = ['covered'];
    chat.updateReadMessages();
    expect(chat.unseenMessages.value).toBe(1);
    chat.setScrollPreference({ matches: true, removeEventListener: vi.fn() });
    await chat.jumpToMessages();
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'auto' });
    expect(chat.unseenMessages.value).toBe(0);
  } finally { scope.stop(); }
});

it('午夜更新日历基准，后台取消日历任务，销毁后不残留计时器', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 30, 23, 59, 59));
  const { scope, chat, document } = setup();
  try {
    chat.refreshCalendar();
    expect(chat.calendarNow.value.getDate()).toBe(30);
    vi.advanceTimersByTime(1100);
    expect(chat.calendarNow.value.getDate()).toBe(31);
    expect(vi.getTimerCount()).toBe(1);
    document.visibilityState = 'hidden';
    chat.handleVisibilityChange();
    expect(vi.getTimerCount()).toBe(0);
    document.visibilityState = 'visible';
    chat.refreshCalendar();
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally { scope.stop(); vi.useRealTimers(); }
});

it('超限文件在读取文件流前提示 MiB，其他合法附件仍可添加', async () => {
  const f = setup();
  try {
    f.uploadLimits.mockResolvedValue({ maxFileBytes: 1024 ** 2 });
    await f.chat.enqueueFiles([new File([new Uint8Array(1024 ** 2 + 1)], 'large.bin'), new File(['ok'], 'ok.txt')], false);
    expect(f.chat.error.value).toContain('上限 1 MiB');
    expect(f.chat.pendingAttachments.value.map(item => item.file.name)).toEqual(['ok.txt']);
    expect(f.sendFile).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

it('文件上传时可连续发文字，上传完成更新原消息', async () => {
  const f = setup();
  try {
    const upload = deferred<ChatMessage>();
    f.sendFile.mockReturnValueOnce(upload.promise);
    await f.chat.enqueueFiles([new File(['video'], 'clip.bin')], false);
    const id = f.chat.pendingAttachments.value[0].id;
    await f.chat.submit();
    expect(f.chat.pendingAttachments.value).toHaveLength(0);
    f.chat.text.value = '下一条';
    await f.chat.submit();
    await vi.waitFor(() => expect(f.chat.messages.value.map(entry => entry.id)).toEqual([id, 'sent']));
    expect(f.transfers.outgoing.has(id)).toBe(true);
    upload.resolve(message(id));
    await vi.waitFor(() => expect(f.transfers.outgoing.has(id)).toBe(false));
    expect(f.chat.messages.value.map(entry => entry.id)).toEqual([id, 'sent']);
  } finally { f.scope.stop(); }
});

it('增量响应重复带回游标或同批消息时不重复插入，仍保留本机未被快照覆盖的消息', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('older'), message('cursor')], hasMore: false });
    await chat.refresh();
    chat.text.value = '本机消息'; await chat.submit();
    findMessages.mockResolvedValueOnce({ messages: [message('cursor'), message('new'), message('new')], hasMore: false });
    expect(await chat.refresh()).toBe(1);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['older', 'cursor', 'new', 'sent']);
  } finally { scope.stop(); }
});

it('本机发送不推进查询游标，超过一页的未读消息逐批补齐', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('cursor')], hasMore: false });
    await chat.refresh();
    chat.text.value = '本机最新消息';
    await chat.submit();
    const firstPage = Array.from({ length: 31 }, (_, index) => message(`remote-${index + 1}`));
    const secondPage = [message('remote-32'), message('remote-33'), message('sent')];
    findMessages.mockImplementation(async (_group, cursor) => {
      const after = (cursor as { afterMessageId: string }).afterMessageId;
      return { messages: after === 'cursor' ? firstPage : after === 'remote-31' ? secondPage : [], hasMore: false };
    });
    await chat.refresh();
    await chat.refresh();
    expect(findMessages.mock.calls.slice(-2).map((entry) => entry[1])).toEqual([
      { afterMessageId: 'cursor' }, { afterMessageId: 'remote-31' },
    ]);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['cursor', ...firstPage.map((entry) => entry.id),
      ...secondPage.map((entry) => entry.id)]);
  } finally { scope.stop(); }
});

it('增量轮询迟于本机发送，旧游标之后按服务端顺序合并', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('cursor')], hasMore: false });
    await chat.refresh();
    const page = deferred<ChatMessagePage>();
    findMessages.mockReturnValueOnce(page.promise);
    const refreshing = chat.refresh();
    chat.text.value = '新消息';
    await chat.submit();
    page.resolve({ messages: [message('remote-before-send'), message('sent'), message('remote-after-send')], hasMore: false });
    await refreshing;
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['cursor', 'remote-before-send', 'sent', 'remote-after-send']);
    await chat.refresh();
    expect(findMessages.mock.calls.at(-1)?.[1]).toEqual({ afterMessageId: 'remote-after-send' });
  } finally { scope.stop(); }
});

it('切群后旧查询中止，已发送的附件继续上传', async () => {
  const f = setup();
  const page = deferred<ChatMessagePage>();
  const upload = deferred<ChatMessage>();
  f.findMessages.mockReturnValueOnce(page.promise);
  f.sendFile.mockReturnValueOnce(upload.promise);
  const refresh = f.chat.refresh();
  await f.chat.enqueueFiles([new File(['a'], 'a.dat')], false);
  await f.chat.submit();
  await vi.waitFor(() => expect(f.sendFile).toHaveBeenCalledOnce());
  const signal = f.sendFile.mock.calls[0][4];
  f.scope.stop();
  expect(f.findMessages.mock.calls[0][2]?.aborted).toBe(true);
  expect(signal.aborted).toBe(false);
  page.resolve({ messages: [], hasMore: false });
  upload.resolve(message('done'));
  await refresh;
  await vi.waitFor(() => expect(f.transfers.outgoing.size).toBe(0));
});

it('取消上传后可在原消息重试，重复提交输入框不会再次上传', async () => {
  const f = setup();
  try {
    const upload = deferred<ChatMessage>();
    f.sendFile.mockReturnValueOnce(upload.promise);
    await f.chat.enqueueFiles([new File(['file'], 'retry.bin')], false);
    const id = f.chat.pendingAttachments.value[0].id;
    await f.chat.submit();
    await vi.waitFor(() => expect(f.sendFile).toHaveBeenCalledOnce());
    const job = f.transfers.outgoing.get(id)!;
    job.controller.abort();
    upload.reject(new Error('aborted'));
    await vi.waitFor(() => expect(job.error).toBe('已取消上传'));
    await f.chat.submit();
    expect(f.sendFile).toHaveBeenCalledTimes(1);
    await f.transfers.retry(job);
    await vi.waitFor(() => expect(f.sendFile).toHaveBeenCalledTimes(2));
    expect(f.sendFile.mock.calls.map(call => call[3])).toEqual([id, id]);
  } finally { f.scope.stop(); }
});

it('重试正在确认上一轮上传状态时，取消后不再启动新上传', async () => {
  const f = setup();
  try {
    f.sendFile.mockRejectedValueOnce(new Error('传输中断'));
    f.transfers.enqueue('first', '', { id: 'retry-cancel', kind: 'FILE', file: new File(['file'], 'retry.bin'), previewUrl: '' });
    const job = f.transfers.outgoing.get('retry-cancel')!;
    await vi.waitFor(() => expect(job.state).toBe('failed'));
    const cleaned = deferred<void>();
    vi.mocked(stopFile).mockReturnValueOnce(cleaned.promise);
    const retry = f.transfers.retry(job);
    job.controller.abort();
    cleaned.resolve();
    await retry;
    expect(job.state).toBe('failed');
    expect(job.error).toBe('已取消上传');
    expect(f.sendFile).toHaveBeenCalledOnce();
  } finally { f.transfers.dispose(); f.scope.stop(); }
});

it('历史失败保持原消息，重试按原游标去重并保持可见锚点，到底后不再请求', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('three'), message('four')], hasMore: true });
    await chat.refresh();
    await nextTick();
    const anchor = { getBoundingClientRect: () => ({ top: chat.messages.value.length === 2 ? 100 : 180, bottom: 200 }) };
    const list = { scrollTop: 120, scrollHeight: 1000, clientHeight: 200,
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }), querySelectorAll: () => [anchor] };
    chat.list.value = list as unknown as HTMLElement;
    findMessages.mockRejectedValueOnce(new Error('历史读取失败'));
    await chat.loadOlder();
    expect(chat.historyError.value).toBe('历史读取失败');
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['three', 'four']);
    findMessages.mockResolvedValueOnce({ messages: [message('one'), message('two'), message('three')], hasMore: false });
    await chat.loadOlder();
    expect(findMessages.mock.calls.slice(-2).map((entry) => entry[1])).toEqual([
      { beforeMessageId: 'three' }, { beforeMessageId: 'three' },
    ]);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['one', 'two', 'three', 'four']);
    expect(list.scrollTop).toBe(200);
    expect(chat.historyError.value).toBe('');
    const requests = findMessages.mock.calls.length;
    await chat.loadOlder();
    expect(findMessages).toHaveBeenCalledTimes(requests);
  } finally { scope.stop(); }
});

it('隐藏页面取消历史等待，迟到结果不写入，返回后可以重新读取', async () => {
  const { scope, chat, findMessages, document } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('current')], hasMore: true });
    await chat.refresh();
    await nextTick();
    chat.list.value = { scrollTop: 120, scrollHeight: 1000, clientHeight: 200 } as HTMLElement;
    const oldPage = deferred<ChatMessagePage>();
    findMessages.mockReturnValueOnce(oldPage.promise);
    const reading = chat.loadOlder();
    const signal = findMessages.mock.calls.at(-1)?.[2]!;
    document.visibilityState = 'hidden';
    chat.handleVisibilityChange();
    expect(signal.aborted).toBe(true);
    oldPage.resolve({ messages: [message('stale')], hasMore: false });
    await reading;
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['current']);
    document.visibilityState = 'visible';
    findMessages.mockResolvedValueOnce({ messages: [], hasMore: false });
    await chat.loadOlder();
    expect(findMessages.mock.calls.at(-1)?.[1]).toEqual({ beforeMessageId: 'current' });
    expect(chat.historyError.value).toBe('');
  } finally { scope.stop(); }
});

it('群聊接收录像只加入附件并保留文字，点击发送才读取上传', async () => {
  const f = setup();
  try {
    f.chat.text.value = '原有草稿';
    f.props.recordingAttachment = { id: 'recording-id', sessionId: 'session', createdAt: 1,
      durationMs: 2000, width: 100, height: 100, bytes: 42, state: 'saved', availability: 'available', fileName: '饥荒联机版.mkv' };
    await nextTick();
    await vi.waitFor(() => expect(f.chat.pendingAttachments.value).toHaveLength(1));
    expect(f.chat.pendingAttachments.value[0]!.file.name).toBe('饥荒联机版.mkv');
    expect(f.chat.text.value).toBe('原有草稿');
    expect(f.sendFile).not.toHaveBeenCalled();
    expect(f.fetchRecording).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith('recordingConsumed');
    f.sendFile.mockImplementationOnce(async (_group, file, _content, id) => {
      const reader = file.stream().getReader();
      expect(Array.from((await reader.read()).value!)).toEqual([1, 2, 3]);
      expect((await reader.read()).done).toBe(true);
      return message(id);
    });
    await f.chat.submit();
    await vi.waitFor(() => expect(f.sendFile).toHaveBeenCalledOnce());
    expect(f.sendFile.mock.calls[0]![0]).toBe('first');
    expect(f.fetchRecording.mock.calls[0]![0]).toBe('lycan://app/recordings/recording-id');
    await vi.waitFor(() => expect(f.fetchRecording.mock.calls[0]![1].signal!.aborted).toBe(true));
  } finally { f.scope.stop(); }
});

it('加号附件按图片视频音频分类，普通文件不建立预览 URL', async () => {
  const f = setup();
  try {
    const files = ['cover.png', 'clip.mkv', 'voice.mp3', 'archive.zip'].map(name => new File(['fixture'], name));
    await f.chat.enqueueFiles(files, false);
    expect(f.chat.pendingAttachments.value.map(item => f.chat.attachmentKind(item))).toEqual(['image', 'video', 'audio', undefined]);
    expect(f.chat.pendingAttachments.value.map(item => item.previewUrl)).toEqual(['blob:preview', 'blob:preview', 'blob:preview', '']);
    expect(f.sendFile).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});
it('回车发送结束等输入框恢复可用后聚焦，发送失败仍可继续编辑', async () => {
  for (const failed of [false, true]) {
    const f = setup();
    try {
      const focus = vi.fn();
      f.chat.messageInput.value = { isConnected: true, closest: () => null, focus };
      f.chat.text.value = '连续发送';
      if (failed) f.sendMessage.mockRejectedValueOnce(new Error('发送失败'));
      await f.chat.submit(true);
      expect(f.chat.text.value).toBe('');
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      if (!failed) expect(f.emit).toHaveBeenCalledWith('messageSent', 'first');
      else expect(f.emit).not.toHaveBeenCalledWith('messageSent', 'first');
    } finally { f.scope.stop(); }
  }
});

it('等待发送时用户聚焦其他控件，不抢回输入焦点', async () => {
  const f = setup();
  try {
    const focus = vi.fn();
    f.chat.messageInput.value = { isConnected: true, closest: () => null, focus };
    f.chat.text.value = '等待发送';
    const response = deferred<ChatMessage>();
    f.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.chat.submit(true);
    f.document.activeElement = { otherControl: true };
    response.resolve(message('sent'));
    await sending;
    expect(focus).not.toHaveBeenCalled();
  } finally { f.scope.stop(); }
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { ChatMessage, ChatMessagePage } from '../chat/chatApi';
import type { AccountCache } from '../cache/localCache';
import { formatFullMessageTime, formatMessageDate, formatMessageTime, localDateKey } from '../chat/messageTime';

const script = parse(readFileSync(new URL('./GroupChat.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('GroupChat.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

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
  const props = reactive({ group: { id: 'first', name: '群聊' }, members: [], user: { id: 'self', nickname: '自己' } });
  const findMessages = vi.fn(async (_groupId: string, _cursor?: unknown, _signal?: AbortSignal): Promise<ChatMessagePage> =>
    ({ messages: [], hasMore: false }));
  const sendMessage = vi.fn(async (_groupId: string, _text: string, _image?: File, _signal?: AbortSignal, _id?: string) => message('sent'));
  const sendFile = vi.fn(async (_groupId: string, _file: File, _text: string, id: string, _signal: AbortSignal) => message(id));
  const document = { visibilityState: 'visible', removeEventListener: vi.fn() };
  const emit = vi.fn();
  // 真实组件的任务、监听和销毁；只替换网络、DOM 与图片边界，不启动浏览器或传输文件。
  const chat = scope.run(() => runInNewContext(`${compiled}\n({ refresh, loadOlder, handleVisibilityChange, submit, cancelUpload,
    list, messages, text, busy, error, historyError, pendingAttachments,
    initialLoaded, refreshing, pollError, atBottom, unseenMessages, retryRefresh,
    unreadMessageIds, showMessageJump, messageJumpLabel, jumpToMessages, updateReadMessages,
    scrollToBottom, onScroll, onScrollEnd, onWheel, stopAnimatedScroll, refreshCalendar, calendarNow,
    setScrollPreference: value => { scrollPreference = value; } })`, {
    computed, ref, nextTick, onScopeDispose, onMounted: () => {}, defineProps: () => props, defineEmits: () => emit,
    inject: () => cache, ACCOUNT_CACHE: Symbol(), ApiRequestError: class extends Error {},
    findMessages, sendMessage, sendFile, compressChatImage: vi.fn(), messagePollDelay: () => 8000,
    formatFullMessageTime, formatMessageDate, formatMessageTime, localDateKey,
    AbortController, setTimeout, clearTimeout, Error, Date,
    document,
    window: { removeEventListener: vi.fn() }, URL: { revokeObjectURL: vi.fn() },
  })) as {
    refresh: () => Promise<number | null>; submit: () => Promise<void>; cancelUpload: () => void;
    loadOlder: () => Promise<void>; handleVisibilityChange: () => void; list: { value: HTMLElement | null };
    historyError: { value: string };
    initialLoaded: { value: boolean }; refreshing: { value: boolean }; pollError: { value: string };
    atBottom: { value: boolean }; unseenMessages: { value: number }; retryRefresh(): Promise<void> | undefined;
    unreadMessageIds: { value: string[] }; showMessageJump: { value: boolean }; messageJumpLabel: { value: string };
    jumpToMessages(): Promise<void>; updateReadMessages(): void; onScroll(): void;
    refreshCalendar(): void; calendarNow: { value: Date };
    scrollToBottom(behavior?: ScrollBehavior, force?: boolean): Promise<void>; onScrollEnd(): void;
    onWheel(event: WheelEvent): void; stopAnimatedScroll(): void;
    setScrollPreference(value: { matches: boolean; removeEventListener: ReturnType<typeof vi.fn> }): void;
    messages: { value: ChatMessage[] }; text: { value: string }; busy: { value: boolean }; error: { value: string };
    pendingAttachments: { value: Array<{ id: string; kind: 'FILE'; file: File; previewUrl: string;
      state: 'pending' | 'uploading' | 'failed' | 'sent'; progress: number; error: string }> };
  };
  return { scope, props, chat, findMessages, sendMessage, sendFile, document, emit };
}

it('命中历史先展示已确认快照，随后按最后游标补齐新消息并更新缓存', async () => {
  const cache = { read: vi.fn().mockResolvedValue({ messages: [message('cached')], hasMore: true }),
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn() } as AccountCache;
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
    revokeGroup: vi.fn(), allowGroups: vi.fn() } as AccountCache;
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
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn() } as AccountCache;
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
    write: vi.fn(), revokeGroup: vi.fn(), allowGroups: vi.fn() } as AccountCache;
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

it('附件失败由附件保留错误，不再重复写入输入区错误', async () => {
  const { scope, chat, sendFile } = setup();
  try {
    chat.pendingAttachments.value = [{ id: 'upload', kind: 'FILE', file: new File(['data'], 'file.bin'),
      previewUrl: '', state: 'pending', progress: 0, error: '' }];
    sendFile.mockRejectedValueOnce(new Error('文件发送失败'));
    await chat.submit();
    expect(chat.pendingAttachments.value[0].state).toBe('failed');
    expect(chat.pendingAttachments.value[0].error).toBe('文件发送失败');
    expect(chat.error.value).toBe('');
  } finally { scope.stop(); }
});

it('文字发送失败保留草稿与错误，允许明确重试', async () => {
  const { scope, chat, sendMessage } = setup();
  try {
    chat.text.value = '未发送内容';
    sendMessage.mockRejectedValueOnce(new Error('服务器暂时不可用'));
    await chat.submit();
    expect(chat.text.value).toBe('未发送内容');
    expect(chat.error.value).toBe('服务器暂时不可用');
    expect(chat.busy.value).toBe(false);
    await chat.submit();
    expect(chat.text.value).toBe('');
    expect(chat.messages.value).toHaveLength(1);
  } finally { scope.stop(); }
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

it('切群销毁旧聊天并创建新实例，取消旧请求且不带入旧草稿或迟到结果', async () => {
  const { scope, chat, findMessages, sendMessage } = setup();
  const current = setup();
  try {
    const oldPage = deferred<ChatMessagePage>();
    const oldSend = deferred<ChatMessage>();
    findMessages.mockReturnValueOnce(oldPage.promise);
    sendMessage.mockReturnValueOnce(oldSend.promise);
    const refreshing = chat.refresh();
    chat.text.value = '旧群内容';
    const sending = chat.submit();
    const pollSignal = findMessages.mock.calls[0][2]!;
    const sendSignal = sendMessage.mock.calls[0][3]!;
    scope.stop();
    expect(pollSignal.aborted).toBe(true);
    expect(sendSignal.aborted).toBe(true);
    oldPage.resolve({ messages: [message('old')], hasMore: false });
    oldSend.resolve(message('old-sent'));
    await Promise.all([refreshing, sending]);
    expect(chat.messages.value).toHaveLength(0);
    expect(chat.error.value).toBe('');
    expect(current.chat.messages.value).toHaveLength(0);
    expect(current.chat.text.value).toBe('');
    expect(current.chat.error.value).toBe('');
  } finally { scope.stop(); current.scope.stop(); }
});

it('批量文件失败后仅重试未成功项，并沿用原请求ID', async () => {
  const { scope, chat, sendFile } = setup();
  try {
    chat.pendingAttachments.value = ['one', 'two'].map((id) => ({ id, kind: 'FILE', file: new File([id], `${id}.bin`),
      previewUrl: '', state: 'pending', progress: 0, error: '' }));
    sendFile.mockResolvedValueOnce(message('one')).mockRejectedValueOnce(new Error('上传失败'));
    await chat.submit();
    expect(chat.pendingAttachments.value.map((entry) => entry.state)).toEqual(['sent', 'failed']);
    await chat.submit();
    expect(sendFile.mock.calls.map((entry) => entry[3])).toEqual(['one', 'two', 'two']);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(chat.pendingAttachments.value).toHaveLength(0);
  } finally { scope.stop(); }
});

it('主动取消上传保留同一请求ID待重试，不显示服务器失败', async () => {
  const { scope, chat, sendFile } = setup();
  try {
    chat.pendingAttachments.value = [{ id: 'upload', kind: 'FILE', file: new File(['data'], 'file.bin'),
      previewUrl: '', state: 'pending', progress: 0, error: '' }];
    const pending = deferred<ChatMessage>();
    sendFile.mockReturnValueOnce(pending.promise);
    const sending = chat.submit();
    chat.cancelUpload();
    expect(sendFile.mock.calls[0][4].aborted).toBe(true);
    pending.reject(new Error('request aborted'));
    await sending;
    expect(chat.error.value).toBe('');
    expect(chat.pendingAttachments.value[0].state).toBe('pending');
    expect(chat.pendingAttachments.value[0].error).toBe('已取消，可继续发送');
    await chat.submit();
    expect(sendFile.mock.calls.map((entry) => entry[3])).toEqual(['upload', 'upload']);
    expect(chat.messages.value).toHaveLength(1);
  } finally { scope.stop(); }
});

it('历史失败保持原消息，重试按原游标去重并保持可见锚点，到底后不再请求', async () => {
  const { scope, chat, findMessages } = setup();
  try {
    findMessages.mockResolvedValueOnce({ messages: [message('three'), message('four')], hasMore: true });
    await chat.refresh();
    await nextTick();
    const anchor = { getBoundingClientRect: () => ({ top: chat.messages.value.length === 2 ? 100 : 180, bottom: 200 }) };
    const list = { scrollTop: 120, scrollHeight: 1000, clientHeight: 200,
      getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [anchor] };
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

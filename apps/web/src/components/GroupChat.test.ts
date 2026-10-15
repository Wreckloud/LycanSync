import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, nextTick, onScopeDispose, reactive, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { ChatMessage, ChatMessagePage } from '../chat/chatApi';

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

function setup() {
  const scope = effectScope();
  const props = reactive({ group: { id: 'first', name: '群聊' }, members: [], user: { id: 'self', nickname: '自己' } });
  const findMessages = vi.fn(async (_groupId: string, _cursor?: unknown, _signal?: AbortSignal): Promise<ChatMessagePage> =>
    ({ messages: [], hasMore: false }));
  const sendMessage = vi.fn(async (_groupId: string, _text: string, _image?: File, _signal?: AbortSignal, _id?: string) => message('sent'));
  const sendFile = vi.fn(async (_groupId: string, _file: File, _text: string, id: string, _signal: AbortSignal) => message(id));
  const document = { visibilityState: 'visible', removeEventListener: vi.fn() };
  // 真实组件的任务、监听和销毁；只替换网络、DOM 与图片边界，不启动浏览器或传输文件。
  const chat = scope.run(() => runInNewContext(`${compiled}\n({ refresh, loadOlder, handleVisibilityChange, submit, cancelUpload,
    list, messages, text, busy, error, historyError, pendingAttachments })`, {
    computed, ref, nextTick, onScopeDispose, onMounted: () => {}, defineProps: () => props,
    findMessages, sendMessage, sendFile, compressChatImage: vi.fn(), messagePollDelay: () => 8000,
    AbortController, setTimeout, clearTimeout, Error,
    document,
    window: { removeEventListener: vi.fn() }, URL: { revokeObjectURL: vi.fn() },
  })) as {
    refresh: () => Promise<number | null>; submit: () => Promise<void>; cancelUpload: () => void;
    loadOlder: () => Promise<void>; handleVisibilityChange: () => void; list: { value: HTMLElement | null };
    historyError: { value: string };
    messages: { value: ChatMessage[] }; text: { value: string }; busy: { value: boolean }; error: { value: string };
    pendingAttachments: { value: Array<{ id: string; kind: 'FILE'; file: File; previewUrl: string;
      state: 'pending' | 'uploading' | 'failed' | 'sent'; progress: number; error: string }> };
  };
  return { scope, props, chat, findMessages, sendMessage, sendFile, document };
}

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

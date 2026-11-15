import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import type { Ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { PendingOwnerTransfer } from './OwnerTransferDialog.vue';

const descriptor = parse(readFileSync(new URL('./OwnerTransferDialog.vue', import.meta.url), 'utf8')).descriptor;
const source = ts.createSourceFile('OwnerTransferDialog.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(source.statements.filter(statement => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement)
  && !/^(watch\(|onMounted\()/.test(statement.getText(source))).map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
const offer: PendingOwnerTransfer = { userId: 'friend', nickname: '朋友', avatar: '', expiresAt: '2099-01-01T00:00:00Z' };
type Status = { administrator: boolean; outgoingTransfer: PendingOwnerTransfer | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  const scope = effectScope(); scopes.push(scope);
  const authRequest = vi.fn((_path: string, _method: string, _body: unknown, _signal: AbortSignal): Promise<unknown> =>
    Promise.resolve({ administrator: true, outgoingTransfer: offer }));
  const emit = vi.fn();
  const actions = scope.run(() => runInNewContext(`${compiled}; ({ schedule, refreshStatus, cancelTransfer, restart, select, close, search, memberScroll, selected, reading, locked, offer, ended, error, step })`, {
    defineProps: () => ({ initialOffer: offer }), defineEmits: () => emit, useBackdropDismiss: () => ({}),
    ref, computed, onScopeDispose, authRequest, AbortController, AbortSignal, Error, Date, Event, setTimeout, clearTimeout,
    document: { visibilityState: 'visible', removeEventListener: vi.fn() }, window: { dispatchEvent: vi.fn() },
  })) as {
    schedule(): void; refreshStatus(): Promise<void>; cancelTransfer(): Promise<void>; restart(): void;
    select(member: PendingOwnerTransfer): void; close(): void;
    search: Ref<string>; memberScroll: Ref<number>; selected: Ref<PendingOwnerTransfer | null>;
    reading: Ref<boolean>; locked: Ref<boolean>; offer: Ref<PendingOwnerTransfer | null>;
    ended: Ref<string>; error: Ref<string>; step: Ref<string>;
  };
  function buttonDisabled(action: string) {
    const tag = descriptor.template!.content.match(new RegExp(`<button[^>]*@click="${action}"[^>]*>`))![0];
    const expression = tag.match(/:disabled="([^"]+)"/)![1];
    return runInNewContext(expression, { locked: actions.locked.value, reading: actions.reading.value });
  }
  return { ...actions, authRequest, emit, scope, buttonDisabled };
}

it('五秒后台刷新期间按钮保持可用，刷新不会重复发出通知', async () => {
  const f = setup(); const read = deferred<Status>();
  f.authRequest.mockReturnValueOnce(read.promise);
  f.schedule(); await vi.advanceTimersByTimeAsync(5_000);
  expect(f.reading.value).toBe(true);
  expect(f.buttonDisabled('cancelTransfer')).toBe(false);
  expect(f.buttonDisabled('restart')).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.authRequest).toHaveBeenCalledTimes(1);
  read.resolve({ administrator: true, outgoingTransfer: offer });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.buttonDisabled('cancelTransfer')).toBe(false);
  expect(f.emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.authRequest).toHaveBeenCalledTimes(2);
});

it('确认接任人后返回，保留搜索、滚动位置和选中的成员', () => {
  const f = setup();
  f.step.value = 'members'; f.search.value = '朋友'; f.memberScroll.value = 520;
  f.select(offer); expect(f.step.value).toBe('confirm');
  f.close();
  expect(f.step.value).toBe('members');
  expect(f.search.value).toBe('朋友');
  expect(f.memberScroll.value).toBe(520);
  expect(f.selected.value?.userId).toBe(offer.userId);
  expect(f.authRequest).not.toHaveBeenCalled();
});

it('刷新中可撤回，提交期间禁止重复操作，迟到查询不能恢复旧转让', async () => {
  const f = setup(); const read = deferred<Status>(); const cancel = deferred<void>();
  f.authRequest.mockReturnValueOnce(read.promise).mockReturnValueOnce(cancel.promise);
  const refreshing = f.refreshStatus(); const signal = f.authRequest.mock.calls[0][3];
  const cancelling = f.cancelTransfer();
  expect(signal.aborted).toBe(true);
  expect(f.buttonDisabled('cancelTransfer')).toBe(true);
  await f.cancelTransfer(); expect(f.authRequest).toHaveBeenCalledTimes(2);
  cancel.resolve(); await cancelling;
  read.resolve({ administrator: true, outgoingTransfer: offer }); await refreshing;
  expect(f.offer.value).toBeNull();
  expect(f.ended.value).toBe('转让已撤回，你仍是服主。');
  expect(f.error.value).toBe('');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.authRequest).toHaveBeenCalledTimes(2);
});

it('撤回失败保留错误并继续刷新，取消的读取错误不覆盖操作错误', async () => {
  const f = setup(); const read = deferred<Status>();
  f.authRequest.mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error('撤回失败'));
  const refreshing = f.refreshStatus(); await f.cancelTransfer();
  read.reject(new Error('请求已取消')); await refreshing;
  expect(f.error.value).toBe('撤回失败');
  expect(f.offer.value).toEqual(offer);
  expect(f.buttonDisabled('cancelTransfer')).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.authRequest).toHaveBeenCalledTimes(3);
});

it('重新发起和卸载都会撤销后台查询，迟到结果不改变窗口状态', async () => {
  for (const leave of ['restart', 'dispose']) {
    const f = setup(); const read = deferred<Status>();
    f.authRequest.mockReturnValueOnce(read.promise);
    const refreshing = f.refreshStatus(); const signal = f.authRequest.mock.calls[0][3];
    if (leave === 'restart') f.restart(); else f.scope.stop();
    expect(signal.aborted).toBe(true);
    read.resolve({ administrator: false, outgoingTransfer: null }); await refreshing;
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.ended.value).toBe('');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.authRequest).toHaveBeenCalledTimes(1);
  }
});

it('后台查询仍及时展示交接成功或真实查询失败', async () => {
  const f = setup();
  f.authRequest.mockRejectedValueOnce(new Error('连接失败'));
  await f.refreshStatus(); expect(f.error.value).toBe('连接失败');
  f.authRequest.mockResolvedValueOnce({ administrator: false, outgoingTransfer: null });
  await f.refreshStatus();
  expect(f.error.value).toBe('');
  expect(f.offer.value).toBeNull();
  expect(f.emit).toHaveBeenCalledWith('notice', '权限已交接，你已成为普通成员。');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.authRequest).toHaveBeenCalledTimes(2);
});

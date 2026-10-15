import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccessOffer, AccessPreview } from '../auth/accountAccess';

const script = parse(readFileSync(new URL('./AccountAccessPrompt.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AccountAccessPrompt.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement)
  && !statement.getText(sourceFile).startsWith('watch(')
  && !statement.getText(sourceFile).startsWith('onMounted('))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const accessSource = ts.createSourceFile('accountAccess.ts',
  readFileSync(new URL('../auth/accountAccess.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const keyFunction = accessSource.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'redemptionKey')!.getText(accessSource).replace(/^export /, '');
const compiled = ts.transpile(`${keyFunction}\n${callbacks}`, { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); });

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup() {
  const scope = effectScope();
  scopes.push(scope);
  const values = new Map<string, string>();
  const sessionStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  const props = { offer: { server: 'https://server.test', token: 'a'.repeat(43) } as AccessOffer,
    currentUser: null, currentServer: 'https://server.test' };
  const result = { user: { id: 'member', nickname: '行者1001', avatar: '', administrator: false }, sessionToken: 'b'.repeat(43) };
  const authRequest = vi.fn(async (path: string, _method?: string, _body?: unknown): Promise<unknown> => path === 'access/preview'
    ? { kind: 'INVITE', status: 'PENDING', serverName: '测试小队' } : result);
  const emit = vi.fn();
  const warn = vi.fn();
  // 执行正式确认回调和重试凭据函数，仅替代 HTTP、存储与界面事件。
  const prompt = scope.run(() => runInNewContext(`${compiled}\n({ checkLink, join, preview, canRedeem, error, busy })`, {
    ref, computed, onScopeDispose, defineProps: () => props, defineEmits: () => emit,
    authRequest, sessionStorage, crypto: globalThis.crypto, btoa, AbortController, AbortSignal, Error,
    console: { warn }, window: {},
  })) as {
    checkLink(): Promise<void>; join(): Promise<void>; preview: { value: AccessPreview | null };
    canRedeem: { value: boolean }; error: { value: string }; busy: { value: boolean };
  };
  return { prompt, props, sessionStorage, authRequest, emit, warn, result, values, scope };
}

it('兑换成功后继续登录，并清理本页重试凭据', async () => {
  const { prompt, emit, result, sessionStorage, values } = setup();
  await prompt.checkLink();
  await prompt.join();
  expect(emit).toHaveBeenCalledWith('joined', result, 'INVITE');
  expect(sessionStorage.setItem).toHaveBeenCalledOnce();
  expect(values.size).toBe(0);
  expect(prompt.error.value).toBe('');
  expect(prompt.busy.value).toBe(false);
});

it('兑换已成功时，临时凭据删除失败仍进入账号且诊断不含凭据', async () => {
  const { prompt, emit, result, sessionStorage, warn, props } = setup();
  sessionStorage.removeItem.mockImplementation(() => { throw new Error('storage unavailable'); });
  await prompt.checkLink();
  await prompt.join();
  expect(emit).toHaveBeenCalledWith('joined', result, 'INVITE');
  expect(prompt.error.value).toBe('');
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls.flat().join(' ')).not.toContain(props.offer.token);
});

it.each(['getItem', 'setItem'] as const)('无法%s保存重试凭据时，不消耗邀请并明确提示', async (method) => {
  const { prompt, emit, authRequest, sessionStorage } = setup();
  sessionStorage[method].mockImplementation(() => { throw new Error('无法访问本页存储'); });
  await prompt.checkLink();
  await prompt.join();
  expect(authRequest.mock.calls.map(([path]) => path)).toEqual(['access/preview']);
  expect(emit).not.toHaveBeenCalled();
  expect(prompt.error.value).toBe('无法访问本页存储');
  expect(prompt.busy.value).toBe(false);
});

it('已使用链接的存储读取失败留在确认页，不让页面计算抛出异常', async () => {
  const { prompt, authRequest, sessionStorage } = setup();
  authRequest.mockResolvedValue({ kind: 'INVITE', status: 'COMPLETED', serverName: '小队' });
  sessionStorage.getItem.mockImplementation(() => { throw new Error('无法检查重试凭据'); });
  await prompt.checkLink();
  expect(prompt.canRedeem.value).toBe(false);
  expect(prompt.error.value).toBe('无法检查重试凭据');
  await prompt.join();
  expect(authRequest).toHaveBeenCalledOnce();
});

it.each([null, 'invalid', 'r'.repeat(43)])('已使用链接只允许持有有效本页重试凭据的客户端重试：%s', async (key) => {
  const { prompt, authRequest, values, props } = setup();
  authRequest.mockResolvedValue({ kind: 'RECOVERY', status: 'COMPLETED', serverName: '小队' });
  if (key !== null) values.set(`lycan:redeem:${props.offer.token}`, key);
  await prompt.checkLink();
  expect(prompt.canRedeem.value).toBe(key?.length === 43);
});

it('兑换请求失败保留原重试凭据，下一次确认复用它', async () => {
  const { prompt, authRequest, values, emit, result } = setup();
  await prompt.checkLink();
  authRequest.mockRejectedValueOnce(new Error('响应中断'));
  await prompt.join();
  expect(prompt.error.value).toBe('响应中断');
  expect(values.size).toBe(1);
  expect(emit).not.toHaveBeenCalled();
  await prompt.join();
  expect(authRequest.mock.calls[2][2]).toEqual(authRequest.mock.calls[1][2]);
  expect(emit).toHaveBeenCalledWith('joined', result, 'INVITE');
});

it('旧链接的迟到检查结果不能恢复重试资格', async () => {
  const { prompt, authRequest, props } = setup();
  const pending = deferred<AccessPreview>();
  authRequest.mockReturnValueOnce(pending.promise);
  const checking = prompt.checkLink();
  props.offer = { ...props.offer, token: 'c'.repeat(43) };
  await prompt.checkLink();
  pending.resolve({ kind: 'RECOVERY', status: 'COMPLETED', serverName: '旧小队' });
  await checking;
  expect(prompt.preview.value?.serverName).toBe('测试小队');
  expect(prompt.canRedeem.value).toBe(true);
});

it('确认页销毁后，迟到的兑换成功不再通知父页面', async () => {
  const { prompt, authRequest, scope, emit } = setup();
  await prompt.checkLink();
  const pending = deferred<unknown>();
  authRequest.mockReturnValueOnce(pending.promise);
  const joining = prompt.join();
  scope.stop();
  pending.resolve({ user: { id: 'old' } });
  await joining;
  expect(emit).not.toHaveBeenCalled();
});

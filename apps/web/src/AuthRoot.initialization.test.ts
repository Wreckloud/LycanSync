import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AuthUser } from './auth/authApi';

const script = parse(readFileSync(new URL('./AuthRoot.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AuthRoot.ts', script, ts.ScriptTarget.Latest, true);
const callbacks = sourceFile.statements.filter((statement) => ts.isFunctionDeclaration(statement)
  ? Boolean(statement.name && ['initialize', 'acceptSession', 'expired'].includes(statement.name.text))
  : statement.getText(sourceFile).startsWith('onScopeDispose('))
  .map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  let dispose!: () => void;
  const state = {
    user: ref<AuthUser | null>(null), error: ref(''), ready: ref(false), onboarding: ref(false), disposed: false,
    initializationRequest: null as AbortController | null, desktop: undefined, sessionHeartbeat: null,
    authRequest: vi.fn(async (_path: string, _method?: string, _body?: unknown, _signal?: AbortSignal): Promise<unknown> => ({ mode: 'invite' })),
    authenticatedFetch: vi.fn(async (_path: string, _options: RequestInit): Promise<Pick<Response, 'ok' | 'status' | 'json'>> => ({
      ok: false, status: 401, json: async () => null,
    })),
    setBrowserSession: vi.fn(), removeMaximizedChange: vi.fn(), removeClose: vi.fn(), removeAccessLink: vi.fn(), removeUpdateState: vi.fn(),
    window: { clearInterval: vi.fn(), removeEventListener: vi.fn() },
  };
  // 执行正式恢复、兑换接入和销毁回调；HTTP 返回顺序由测试控制。
  const app = runInNewContext(`${compiled}\n({ initialize, acceptSession, expired })`, {
    ...state, Error, AbortController, AbortSignal, onScopeDispose: (callback: () => void) => { dispose = callback; },
  }) as {
    initialize(): Promise<void>; acceptSession(result: { user: AuthUser; sessionToken: string }): void; expired(): void;
  };
  const member: AuthUser = { id: 'member', nickname: '新账号', avatar: '', administrator: false };
  return { state, app, member, dispose: () => dispose() };
}

it('正常恢复账号，并保留未登录时的普通 401 语义', async () => {
  const { state, app, member } = setup();
  await app.initialize();
  expect(state.ready.value).toBe(true);
  expect(state.error.value).toBe('');
  expect(state.user.value).toBeNull();
  state.authenticatedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => member });
  await app.initialize();
  expect(state.user.value).toEqual(member);
});

it('新的重连取消旧登录方式检查，旧响应不继续读取账号', async () => {
  const { state, app } = setup();
  const pending = deferred<unknown>();
  state.authRequest.mockReturnValueOnce(pending.promise);
  const old = app.initialize();
  const signal = state.authRequest.mock.calls[0][3]!;
  await app.initialize();
  expect(signal.aborted).toBe(true);
  pending.resolve({ mode: 'invite' });
  await old;
  expect(state.authenticatedFetch).toHaveBeenCalledOnce();
});

it('旧恢复响应正文迟到时，不能覆盖刚确认邀请的新账号', async () => {
  const { state, app, member } = setup();
  const body = deferred<AuthUser>();
  const reading = deferred<void>();
  state.authenticatedFetch.mockResolvedValue({ ok: true, status: 200, json: () => {
    reading.resolve();
    return body.promise;
  } });
  const restoring = app.initialize();
  await reading.promise;
  app.acceptSession({ user: member, sessionToken: 'b'.repeat(43) });
  body.resolve({ ...member, id: 'old-member', nickname: '旧账号' });
  await restoring;
  expect(state.user.value).toEqual(member);
  expect(state.setBrowserSession).toHaveBeenCalledWith('b'.repeat(43));
});

it('旧检查失败不覆盖新一轮重连的当前错误', async () => {
  const { state, app } = setup();
  const oldResult = deferred<unknown>();
  state.authRequest.mockReturnValueOnce(oldResult.promise).mockRejectedValueOnce(new Error('当前服务器不可用'));
  const old = app.initialize();
  await app.initialize();
  oldResult.reject(new Error('旧错误'));
  await old;
  expect(state.error.value).toBe('当前服务器不可用');
});

it('当前连接错误仍明确提示，登录方式不匹配不读取账号', async () => {
  const { state, app } = setup();
  state.authRequest.mockResolvedValue({ mode: 'test' });
  await app.initialize();
  expect(state.error.value).toBe('服务器尚未启用邀请登录，请联系服主。');
  expect(state.authenticatedFetch).not.toHaveBeenCalled();
  expect(state.ready.value).toBe(true);
});

it.each(['expired', 'dispose'] as const)('%s 后旧恢复不能重新登录或显示旧错误', async (ending) => {
  const { state, app, member, dispose } = setup();
  const body = deferred<AuthUser>();
  const reading = deferred<void>();
  state.authenticatedFetch.mockResolvedValue({ ok: true, status: 200, json: () => {
    reading.resolve();
    return body.promise;
  } });
  const restoring = app.initialize();
  await reading.promise;
  if (ending === 'dispose') dispose(); else app.expired();
  body.resolve(member);
  await restoring;
  expect(state.user.value).toBeNull();
  expect(state.error.value).toBe('');
  if (ending === 'dispose') {
    expect(state.ready.value).toBe(false);
    await app.initialize();
    expect(state.authRequest).toHaveBeenCalledOnce();
  }
});

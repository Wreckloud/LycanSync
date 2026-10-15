import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AuthSessionStatus, AuthUser } from './auth/authApi';
import { ApiRequestError } from './auth/authApi';

const script = parse(readFileSync(new URL('./AuthRoot.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AuthRoot.ts', script, ts.ScriptTarget.Latest, true);
const callbackNames = ['verifyCurrentSession', 'expired', 'logout'];
const callbacks = callbackNames.map((name) => {
  const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  if (!declaration) throw new Error(`登录回调不存在：${name}`);
  return declaration.getText(sourceFile);
}).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function setup() {
  let resolve!: (status: AuthSessionStatus) => void;
  const pending = new Promise<AuthSessionStatus>((done) => { resolve = done; });
  const user = ref<AuthUser | null>({ id: 'member', nickname: '旧昵称', avatar: '', administrator: false });
  const authRequest = vi.fn(() => pending);
  // 执行正式心跳和退出回调，只控制请求结果，不启动页面、客户端或服务器。
  const context = { user, authRequest, disposed: false, sessionHeartbeatInFlight: false,
    onboarding: ref(false), error: ref(''), logoutInProgress: false, initializationRequest: null, ApiRequestError, Error, AbortSignal,
    sendPresenceHeartbeat: vi.fn(async (): Promise<void> => undefined), setBrowserSession: vi.fn() };
  const callbacks = runInNewContext(`${compiled}\n({ verifyCurrentSession, logout })`, context) as {
    verifyCurrentSession: () => Promise<void>; logout: () => Promise<void>;
  };
  return { context, verify: callbacks.verifyCurrentSession, logout: callbacks.logout, resolve };
}

it.each(['profile', 'same-account', 'other-account', 'logout'])(
  '旧心跳成功返回不覆盖后来发生的 %s 状态', async (change) => {
    const { context, verify, resolve } = setup();
    const pending = verify();
    context.user.value = change === 'logout' ? null : {
      id: change === 'other-account' ? 'another-member' : 'member',
      nickname: change === 'profile' ? '刚保存的昵称' : '新会话昵称',
      avatar: '新头像', administrator: false,
    };
    const current = context.user.value;
    resolve({ id: 'member', nickname: '旧心跳昵称', administrator: true });
    await pending;
    expect(context.user.value).toBe(current);
    expect(context.sessionHeartbeatInFlight).toBe(false);
  },
);

it('销毁后不应用心跳结果，也不再发送请求', async () => {
  const { context, verify, resolve } = setup();
  const original = context.user.value;
  const pending = verify();
  context.disposed = true;
  resolve({ id: 'member', nickname: '迟到昵称', administrator: true });
  await pending;
  expect(context.user.value).toBe(original);
  await verify();
  expect(context.authRequest).toHaveBeenCalledTimes(1);
});

it('当前心跳更新昵称和角色，保留头像且不重复发送', async () => {
  const { context, verify, resolve } = setup();
  const pending = verify();
  await verify();
  expect(context.authRequest).toHaveBeenCalledTimes(1);
  resolve({ id: 'member', nickname: '服务端昵称', administrator: true });
  await pending;
  expect(context.user.value).toEqual({ id: 'member', nickname: '服务端昵称', avatar: '', administrator: true });
});

it('没有登录账号时不发送心跳', async () => {
  const { context, verify, resolve } = setup();
  context.user.value = null;
  resolve({ id: 'member', nickname: '旧昵称', administrator: false });
  await verify();
  expect(context.authRequest).not.toHaveBeenCalled();
});

it.each([401, 502])('退出已在服务端完成时，本机返回%s不恢复旧身份', async (status) => {
  const { context, logout } = setup();
  context.onboarding.value = true;
  context.authRequest.mockRejectedValue(new ApiRequestError(status,
    status === 401 ? 'INVALID_SESSION' : 'LOCAL_SESSION_CLEAR_FAILED', '登录已结束，但本机凭据清理失败'));
  await logout();
  expect(context.user.value).toBeNull();
  expect(context.onboarding.value).toBe(false);
  expect(context.setBrowserSession).toHaveBeenCalledWith(null);
  expect(context.logoutInProgress).toBe(false);
  expect(context.error.value).toBe(status === 401 ? '' : '登录已结束，但本机凭据清理失败');
});

it('服务端退出失败才恢复原账号，保留明确错误', async () => {
  const { context, logout } = setup();
  const original = context.user.value;
  context.authRequest.mockRejectedValue(new ApiRequestError(503, 'AUTH_SERVICE_UNAVAILABLE', '账号服务暂不可用'));
  await logout();
  expect(context.user.value).toBe(original);
  expect(context.error.value).toBe('账号服务暂不可用');
  expect(context.setBrowserSession).not.toHaveBeenCalled();
});

it('离线上报期间已接入新账号，不使用新会话发送旧退出请求', async () => {
  const { context, logout } = setup();
  let complete!: () => void;
  context.sendPresenceHeartbeat.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
  const pending = logout();
  const current = { id: 'new-member', nickname: '新账号', avatar: '', administrator: false };
  context.user.value = current;
  complete();
  await pending;
  expect(context.user.value).toEqual(current);
  expect(context.authRequest).not.toHaveBeenCalled();
  expect(context.setBrowserSession).not.toHaveBeenCalled();
  expect(context.logoutInProgress).toBe(false);
});

it.each([200, 401, 503])('旧退出返回%s时，不清除或覆盖之后接入的新账号', async (status) => {
  const { context, logout } = setup();
  let complete!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  context.authRequest.mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => { complete = resolve; });
    if (status !== 200) throw new ApiRequestError(status, 'INVALID_SESSION', '旧退出结果');
    return { id: 'member', nickname: '旧昵称', administrator: false };
  });
  const pending = logout();
  await entered;
  const current = { id: 'new-member', nickname: '新账号', avatar: '', administrator: false };
  context.user.value = current;
  context.error.value = '新状态提示';
  complete();
  await pending;
  expect(context.user.value).toEqual(current);
  expect(context.error.value).toBe('新状态提示');
  expect(context.setBrowserSession).not.toHaveBeenCalled();
  expect(context.logoutInProgress).toBe(false);
});

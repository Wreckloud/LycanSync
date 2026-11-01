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
const callbackNames = ['verifyCurrentSession', 'expired', 'requestLogout', 'confirmLogout', 'logout',
  'requestClearSession', 'clearLocalSession', 'initialize', 'acceptSession', 'completeAccess', 'enterAccount', 'changeAutoLogin'];
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
  const authRequest = vi.fn((path: string) => path === 'session' ? pending : Promise.resolve({ mode: 'invite' }));
  const context = { user, authRequest, disposed: false, sessionHeartbeatInFlight: false,
    application: ref({ prepareLogout: vi.fn(() => ({ showActivity: false, showLastOnline: true })) }),
    entryUser: ref<AuthUser | null>(null), autoLogin: ref(true), manualEntryRequired: ref(false), preferenceSaving: ref(false),
    removeConfirm: ref(false), removing: ref(false), submitting: ref(false), ready: ref(true), accessOffer: ref(null),
    onboarding: ref(false), error: ref(''), logoutTarget: ref<AuthUser | null>(null), logoutBusy: ref(false),
    logoutInProgress: false, initializationRequest: null, ApiRequestError, Error, AbortSignal, AbortController,
    desktop: { returnToAccountEntry: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
      getAutoLogin: vi.fn(async () => ({ enabled: true, manualEntryRequired: false })), setAutoLogin: vi.fn(async (_id: string, enabled: boolean) => enabled) },
    authenticatedFetch: vi.fn(async () => Response.json({ id: 'member', nickname: '服务端昵称', avatar: '', administrator: false })),
    sendPresenceHeartbeat: vi.fn(async (): Promise<void> => undefined), setBrowserSession: vi.fn() };
  const functions = runInNewContext(`${compiled}\n({ ${callbackNames.join(', ')} })`, context) as {
    verifyCurrentSession: () => Promise<void>; logout: () => Promise<void>; requestLogout: () => void; confirmLogout: () => Promise<void>;
    requestClearSession: () => void; clearLocalSession: () => Promise<void>; initialize: (automatic?: boolean) => Promise<void>;
    completeAccess: (result: { user: AuthUser }, kind: string) => Promise<void>; enterAccount: () => Promise<void>;
    changeAutoLogin: (event: unknown) => Promise<void>;
  };
  return { context, verify: functions.verifyCurrentSession, ...functions, resolve };
}

it('普通退出先确认，取消不动凭据；确认后只停止媒体并返回账号页', async () => {
  const f = setup();
  f.requestLogout();
  expect(f.context.logoutTarget.value?.id).toBe('member');
  f.context.logoutTarget.value = null;
  await f.confirmLogout();
  expect(f.context.desktop.returnToAccountEntry).not.toHaveBeenCalled();
  f.requestLogout();
  await f.confirmLogout();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('member');
  expect(f.context.application.value.prepareLogout).toHaveBeenCalledOnce();
  expect(f.context.sendPresenceHeartbeat).toHaveBeenLastCalledWith('OFFLINE', null, expect.any(AbortSignal),
    { showActivity: false, showLastOnline: true });
  expect(f.context.desktop.returnToAccountEntry).toHaveBeenCalledOnce();
  expect(f.context.authRequest).not.toHaveBeenCalled();
  expect(f.context.desktop.clearSession).not.toHaveBeenCalled();
  expect(f.context.setBrowserSession).not.toHaveBeenCalled();
  expect(f.context.logoutTarget.value).toBeNull();
});

it('资源停止失败仍保留账号与凭据，并明确提示；重新进入前再次回收', async () => {
  const f = setup();
  f.context.desktop.returnToAccountEntry.mockRejectedValueOnce(new Error('stop failed'));
  await f.logout();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('member');
  expect(f.context.error.value).toContain('凭据已保留');
  await f.enterAccount();
  expect(f.context.desktop.returnToAccountEntry).toHaveBeenCalledTimes(2);
  expect(f.context.user.value?.nickname).toBe('服务端昵称');
});

it('清除必须单独确认，取消不发送撤销请求或删除文件；双击只执行一次', async () => {
  const f = setup();
  await f.logout();
  await f.clearLocalSession();
  expect(f.context.authRequest).not.toHaveBeenCalled();
  f.requestClearSession();
  f.context.removeConfirm.value = false;
  await f.clearLocalSession();
  expect(f.context.desktop.clearSession).not.toHaveBeenCalled();
  f.requestClearSession();
  const pending = f.clearLocalSession();
  await f.clearLocalSession();
  await pending;
  expect(f.context.authRequest).toHaveBeenCalledExactlyOnceWith('logout', 'POST');
  expect(f.context.desktop.clearSession).toHaveBeenCalledOnce();
  expect(f.context.entryUser.value).toBeNull();
  expect(f.context.removeConfirm.value).toBe(false);
});

it('离线仍能移除本机凭据，但不声称已撤销服务器会话', async () => {
  const f = setup();
  await f.logout();
  f.context.authRequest.mockRejectedValueOnce(new Error('offline'));
  f.requestClearSession();
  await f.clearLocalSession();
  expect(f.context.entryUser.value).toBeNull();
  expect(f.context.error.value).toContain('未确认撤销');
});

it('文件删除失败保持确认框并允许重试', async () => {
  const f = setup();
  await f.logout();
  f.context.desktop.clearSession.mockRejectedValueOnce(new Error('permission denied'));
  f.requestClearSession();
  await f.clearLocalSession();
  expect(f.context.removeConfirm.value).toBe(true);
  expect(f.context.error.value).toContain('目录权限');
  expect(f.context.removing.value).toBe(false);
});

it.each([true, false])('启动时遵循自动登录 %s，重连绝不自动进入', async enabled => {
  const f = setup();
  f.context.user.value = null;
  f.context.desktop.getAutoLogin.mockResolvedValue({ enabled, manualEntryRequired: false });
  await f.initialize(true);
  expect(Boolean(f.context.user.value)).toBe(enabled);
  f.context.user.value = null;
  await f.initialize();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('member');
});

it.each(['INVITE', 'ACTIVATE', 'RECOVERY'])('首次%s完成只确认账号，不能直接进入', async kind => {
  const f = setup();
  const account = f.context.user.value!;
  await f.completeAccess({ user: account }, kind);
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value).toEqual(account);
  expect(f.context.onboarding.value).toBe(kind !== 'RECOVERY');
  expect(f.context.autoLogin.value).toBe(true);
  expect(f.context.desktop.setAutoLogin).toHaveBeenCalledWith('member', true, true);
});

it('修改自动登录只保存偏好，不立即进入；失败恢复原选择', async () => {
  const f = setup();
  await f.logout();
  await f.changeAutoLogin({ target: { checked: false } });
  expect(f.context.autoLogin.value).toBe(false);
  expect(f.context.user.value).toBeNull();
  f.context.desktop.setAutoLogin.mockRejectedValueOnce(new Error('disk error'));
  await f.changeAutoLogin({ target: { checked: true } });
  expect(f.context.autoLogin.value).toBe(false);
  expect(f.context.error.value).toContain('保存失败');
});

it('偏好损坏不能自动进入，但仍显示可确认的账号', async () => {
  const f = setup();
  f.context.user.value = null;
  f.context.desktop.getAutoLogin.mockRejectedValueOnce(new Error('设置损坏'));
  await f.initialize(true);
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('member');
  expect(f.context.autoLogin.value).toBe(false);
});

it('手动登录前凭据已失效，不使用旧预览身份进入', async () => {
  const f = setup();
  await f.logout();
  f.context.authenticatedFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await f.enterAccount();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value).toBeNull();
});

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


it('首次确认前重启仍停在账号页，勾选自动登录也不绕过首次确认', async () => {
  const f = setup();
  f.context.user.value = null;
  f.context.desktop.getAutoLogin.mockResolvedValue({ enabled: true, manualEntryRequired: true });
  await f.initialize(true);
  expect(f.context.user.value).toBeNull();
  expect(f.context.autoLogin.value).toBe(true);
  await f.enterAccount();
  expect((f.context.user.value as AuthUser | null)?.id).toBe('member');
  expect(f.context.desktop.setAutoLogin).toHaveBeenCalledWith('member', true, false);
});

it('登录核验返回不同账号时，先展示新资料再要求手动确认', async () => {
  const f = setup();
  await f.logout();
  f.context.authenticatedFetch.mockResolvedValueOnce(Response.json({ id: 'another', nickname: '另一账号', avatar: '', administrator: false }));
  await f.enterAccount();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('another');
  expect(f.context.error.value).toContain('账号已变化');
});

it('首次登录确认无法落盘时停在账号页，明确提示目录权限而不是媒体错误', async () => {
  const f = setup();
  await f.logout();
  f.context.desktop.setAutoLogin.mockRejectedValueOnce(new Error('permission denied'));
  await f.enterAccount();
  expect(f.context.user.value).toBeNull();
  expect(f.context.error.value).toContain('安装目录权限');
});

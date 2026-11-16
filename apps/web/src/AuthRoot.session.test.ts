import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AuthSessionStatus, AuthUser, ProfileUpdate } from './auth/authApi';
import { ApiRequestError, authRequest as qqAuthRequest } from './auth/authApi';
import { useQqLogin } from './auth/useQqLogin';

vi.mock('./auth/authApi', async importOriginal => ({
  ...await importOriginal<typeof import('./auth/authApi')>(), authRequest: vi.fn(),
}));

const script = parse(readFileSync(new URL('./AuthRoot.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AuthRoot.ts', script, ts.ScriptTarget.Latest, true);
const callbackNames = ['verifyCurrentSession', 'expired', 'requestLogout', 'confirmLogout', 'logout',
  'requestClearSession', 'clearLocalSession', 'confirmClearSession', 'initialize', 'acceptSession', 'completeAccess', 'enterAccount', 'changeAutoLogin', 'saveProfile'];
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
  const authRequest = vi.fn((path: string): Promise<unknown> => path === 'session' ? pending : Promise.resolve({ mode: 'invite' }));
  const context = { user, authRequest, disposed: false, sessionHeartbeatInFlight: false, sessionRevision: 0,
    qq: { cancel: vi.fn(), finishing: ref(false) },
    clearLocalContentCache: vi.fn(async () => {}),
    application: ref({ prepareLogout: vi.fn(() => ({ showActivity: false, showLastOnline: true })), releaseSession: vi.fn(async () => {}) }),
    entryUser: ref<AuthUser | null>(null), qqAvailable: ref(false), initialized: ref<boolean | null>(null), accountUpdated: vi.fn(), autoLogin: ref(true), manualEntryRequired: ref(false), preferenceSaving: ref(false),
    clearRequest: null, clearPasswordOpen: ref(false), removeConfirm: ref(false), removing: ref(false), submitting: ref(false), ready: ref(true), accessOffer: ref(null),
    onboarding: ref(false), error: ref(''), logoutTarget: ref<AuthUser | null>(null), logoutBusy: ref(false),
    logoutInProgress: false, initializationRequest: null, ApiRequestError, Error, AbortSignal, AbortController,
    desktop: { returnToAccountEntry: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
      getAutoLogin: vi.fn(async () => ({ enabled: true, manualEntryRequired: false })), setAutoLogin: vi.fn(async (_id: string, enabled: boolean) => enabled) },
    authenticatedFetch: vi.fn(async () => Response.json({ id: 'member', nickname: '服务端昵称', avatar: '', administrator: false })),
    sendPresenceHeartbeat: vi.fn(async (): Promise<void> => undefined), setBrowserSession: vi.fn() };
  const functions = runInNewContext(`${compiled}\n({ ${callbackNames.join(', ')} })`, context) as {
    verifyCurrentSession: () => Promise<void>; logout: () => Promise<void>; requestLogout: () => void; confirmLogout: () => Promise<void>;
    requestClearSession: () => void; confirmClearSession: () => Promise<void>; clearLocalSession: () => Promise<void>; initialize: (automatic?: boolean) => Promise<void>;
    completeAccess: (result: { user: AuthUser }, kind: string) => Promise<void>; enterAccount: () => Promise<void>;
    changeAutoLogin: (event: unknown) => Promise<void>;
    expired: () => void; saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
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
  expect(f.context.clearLocalContentCache).not.toHaveBeenCalled();
  expect(f.context.logoutTarget.value).toBeNull();
});

it('移除登录信息不清理内容缓存，也不受缓存存储失败影响', async () => {
  const f = setup();
  f.context.user.value = null;
  f.context.entryUser.value = { id: 'member', nickname: '成员', avatar: '', administrator: false };
  f.context.clearLocalContentCache.mockRejectedValueOnce(new Error('storage unavailable'));
  f.requestClearSession();
  await f.confirmClearSession();
  expect(f.context.desktop.clearSession).toHaveBeenCalledOnce();
  expect(f.context.entryUser.value).toBeNull();
  expect(f.context.clearLocalContentCache).not.toHaveBeenCalled();
  expect(f.context.error.value).toBe('');
});

it('资源停止失败仍保留账号与凭据，并明确提示；重新进入前再次回收', async () => {
  const f = setup();
  f.context.desktop.returnToAccountEntry.mockRejectedValueOnce(new Error('stop failed'));
  await f.logout();
  expect(f.context.user.value).toBeNull();
  expect(f.context.entryUser.value?.id).toBe('member');
  expect(f.context.error.value).toContain('退出时发生问题');
  await f.enterAccount();
  expect(f.context.desktop.returnToAccountEntry).toHaveBeenCalledTimes(2);
  expect(f.context.user.value?.nickname).toBe('服务端昵称');
});

it('退出等待录像与诊断收尾后才卸载界面，失败仍执行主进程清理', async () => {
  const f = setup();
  let finish!: () => void;
  f.context.application.value.releaseSession.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const leaving = f.logout();
  await vi.waitFor(() => expect(f.context.application.value.releaseSession).toHaveBeenCalledOnce());
  expect(f.context.user.value?.id).toBe('member');
  expect(f.context.desktop.returnToAccountEntry).not.toHaveBeenCalled();
  finish();
  await leaving;
  expect(f.context.desktop.returnToAccountEntry).toHaveBeenCalledOnce();
  expect(f.context.user.value).toBeNull();

  const failed = setup();
  failed.context.application.value.releaseSession.mockRejectedValueOnce(new Error('cleanup failed'));
  await failed.logout();
  expect(failed.context.desktop.returnToAccountEntry).toHaveBeenCalledOnce();
  expect(failed.context.error.value).toContain('退出时发生问题');
});

it('清除必须单独确认，取消不发送撤销请求或删除文件；双击只执行一次', async () => {
  const f = setup();
  await f.logout();
  await f.confirmClearSession();
  expect(f.context.authRequest).not.toHaveBeenCalled();
  f.requestClearSession();
  f.context.removeConfirm.value = false;
  await f.confirmClearSession();
  expect(f.context.desktop.clearSession).not.toHaveBeenCalled();
  f.requestClearSession();
  const pending = f.confirmClearSession();
  await f.confirmClearSession();
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
  await f.confirmClearSession();
  expect(f.context.entryUser.value).toBeNull();
  expect(f.context.error.value).toContain('未能完成服务器端退出');
});

it('文件删除失败保持确认框并允许重试', async () => {
  const f = setup();
  await f.logout();
  f.context.desktop.clearSession.mockRejectedValueOnce(new Error('permission denied'));
  f.requestClearSession();
  await f.confirmClearSession();
  expect(f.context.removeConfirm.value).toBe(true);
  expect(f.context.error.value).toContain('读写权限');
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
  expect(f.context.error.value).toContain('账号发生变化');
});

it('首次登录确认无法落盘时停在账号页，明确提示目录权限而不是媒体错误', async () => {
  const f = setup();
  await f.logout();
  f.context.desktop.setAutoLogin.mockRejectedValueOnce(new Error('permission denied'));
  await f.enterAccount();
  expect(f.context.user.value).toBeNull();
  expect(f.context.error.value).toContain('安装目录权限');
});

it.each(['expired', 'recovery', 'logout', 'dispose'] as const)('%s 后旧资料响应不能覆盖当前账号展示', async ending => {
  const f = setup();
  let resolve!: (user: AuthUser) => void;
  f.context.authRequest.mockReturnValueOnce(new Promise<AuthUser>(done => { resolve = done; }));
  const saving = f.saveProfile({ nickname: '旧保存结果', avatar: '旧头像' });
  if (ending === 'dispose') f.context.disposed = true;
  else if (ending === 'logout') await f.logout();
  else {
    f.expired();
    if (ending === 'recovery') await f.completeAccess({ user: {
      id: 'member', nickname: '重新认证的资料', avatar: '新会话头像', administrator: false,
    } }, 'RECOVERY');
  }
  const currentUser = f.context.user.value;
  const currentEntry = f.context.entryUser.value;
  resolve({ id: 'member', nickname: '旧保存结果', avatar: '旧头像', administrator: false });
  await expect(saving).rejects.toThrow('登录状态已变化');
  expect(f.context.user.value).toBe(currentUser);
  expect(f.context.entryUser.value).toBe(currentEntry);
});

it('当前会话的正常资料保存仍成功，期间心跳刷新角色不误判为更换会话', async () => {
  const f = setup();
  let resolve!: (user: AuthUser) => void;
  f.context.authRequest.mockReturnValueOnce(new Promise<AuthUser>(done => { resolve = done; }));
  const saving = f.saveProfile({ nickname: '有效保存', avatar: '有效头像' });
  f.context.user.value = { ...f.context.user.value!, administrator: true };
  const updated = { id: 'member', nickname: '有效保存', avatar: '有效头像', administrator: true };
  resolve(updated);
  expect(await saving).toEqual(updated);
  expect(f.context.user.value).toEqual(updated);
  expect(f.context.entryUser.value).toBeNull();
});

it('销毁后不再发起资料保存请求', async () => {
  const f = setup();
  f.context.disposed = true;
  await expect(f.saveProfile({ nickname: '迟到操作', avatar: '' })).rejects.toThrow();
  expect(f.context.authRequest).not.toHaveBeenCalled();
});

it.each(['server-member', 'server-guest', 'desktop-member', 'desktop-guest'])('清除等待 %s 时接入新账号，不再删除新凭据或清空新展示', async stage => {
  const f = setup();
  f.context.user.value = null;
  f.context.entryUser.value = stage.endsWith('member') ? { id: 'member', nickname: '待移除账号', avatar: '', administrator: false } : null;
  f.context.removeConfirm.value = true;
  f.context.removing.value = true;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  if (stage.startsWith('server')) f.context.authRequest.mockReturnValueOnce(pending);
  else f.context.desktop.clearSession.mockReturnValueOnce(pending);
  const clearing = f.clearLocalSession();
  if (stage.startsWith('desktop')) await vi.waitFor(() => expect(f.context.desktop.clearSession).toHaveBeenCalledOnce());
  const renewed = { id: 'member', nickname: '新的会话资料', avatar: '', administrator: false };
  await f.completeAccess({ user: renewed }, 'RECOVERY');
  const current = f.context.entryUser.value;
  finish();
  await clearing;
  expect(f.context.entryUser.value).toBe(current);
  expect(f.context.setBrowserSession).not.toHaveBeenCalled();
  if (stage.startsWith('server')) expect(f.context.desktop.clearSession).not.toHaveBeenCalled();
});

it('服务器退出发现旧凭据失效，仍允许清除本机旧凭据', async () => {
  const f = setup();
  f.context.user.value = null;
  f.context.entryUser.value = { id: 'member', nickname: '旧账号', avatar: '', administrator: false };
  f.context.removeConfirm.value = true;
  f.context.removing.value = true;
  let fail!: (reason: Error) => void;
  f.context.authRequest.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail = reject; }));
  const clearing = f.clearLocalSession();
  f.expired();
  fail(new ApiRequestError(401, 'SESSION_EXPIRED', '旧凭据失效'));
  await clearing;
  expect(f.context.desktop.clearSession).toHaveBeenCalledOnce();
  expect(f.context.entryUser.value).toBeNull();
  expect(f.context.error.value).toContain('未能完成服务器端退出');
});

it('旧本机清除失败不把错误写进新账号界面', async () => {
  const f = setup();
  f.context.user.value = null;
  f.context.removeConfirm.value = true;
  f.context.removing.value = true;
  let fail!: (reason: Error) => void;
  f.context.desktop.clearSession.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const clearing = f.clearLocalSession();
  await vi.waitFor(() => expect(f.context.desktop.clearSession).toHaveBeenCalledOnce());
  await f.completeAccess({ user: { id: 'member', nickname: '新账号', avatar: '', administrator: false } }, 'RECOVERY');
  const current = f.context.entryUser.value;
  fail(new Error('旧操作的磁盘错误'));
  await clearing;
  expect(f.context.entryUser.value).toBe(current);
  expect(f.context.error.value).toBe('');
});

it.each(['other-entry', 'own-qq'] as const)('QQ 并发资格 %s：新接入终止旧等待，QQ 自身成功仍能完成', async source => {
  const f = setup();
  f.context.user.value = null;
  let callback!: (request: string) => Promise<void>;
  const request = 'q'.repeat(43);
  const desktop = { openQqLogin: vi.fn(async () => {}), onQqLogin: (next: typeof callback) => { callback = next; return () => {}; } };
  vi.stubGlobal('window', { lycanDesktop: desktop });
  const scope = effectScope();
  const flow = scope.run(() => useQqLogin(account => f.completeAccess({ user: account }, 'RECOVERY')))!;
  f.context.qq.cancel.mockImplementation(() => flow.cancel());
  const recovered = { id: 'recovered', nickname: '恢复账号', avatar: '', administrator: false };
  const qqUser = { id: 'qq-user', nickname: 'QQ账号', avatar: '', administrator: false };
  try {
    vi.mocked(qqAuthRequest).mockResolvedValueOnce({ request, authorizationUrl: 'https://example.test/api/auth/qq/authorize?request=' + request });
    await flow.start();
    expect(flow.busy.value).toBe(true);
    if (source === 'other-entry') await f.completeAccess({ user: recovered }, 'RECOVERY');
    vi.mocked(qqAuthRequest).mockResolvedValueOnce({ user: qqUser, newAccount: false });
    await callback(request);
    expect(f.context.entryUser.value).toEqual(source === 'other-entry' ? recovered : qqUser);
    expect(qqAuthRequest).toHaveBeenCalledTimes(source === 'other-entry' ? 1 : 2);
    expect(flow.busy.value).toBe(false);
  } finally { scope.stop(); vi.unstubAllGlobals(); vi.mocked(qqAuthRequest).mockReset(); }
});

it('QQ 确认期间不开始清除，结束后仍可显式确认清除', () => {
  const f = setup();
  f.context.user.value = null;
  f.context.qq.finishing.value = true;
  f.requestClearSession();
  expect(f.context.removeConfirm.value).toBe(false);
  f.context.qq.finishing.value = false;
  f.requestClearSession();
  expect(f.context.removeConfirm.value).toBe(true);
});

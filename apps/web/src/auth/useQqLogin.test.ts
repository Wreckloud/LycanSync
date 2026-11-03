import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { authRequest } from './authApi';
import { useQqLogin } from './useQqLogin';

vi.mock('./authApi', () => ({ authRequest: vi.fn() }));
const request = 'r'.repeat(43);
const response = { request, authorizationUrl: 'https://example.com/api/auth/qq/authorize?request=' + request };
const scopes: ReturnType<typeof effectScope>[] = [];

function setup() {
  let complete!: (request: string) => Promise<void>;
  const remove = vi.fn();
  const desktop = { openQqLogin: vi.fn(async () => {}), onQqLogin: vi.fn(callback => { complete = callback; return remove; }) };
  vi.stubGlobal('window', { lycanDesktop: desktop });
  const login = vi.fn();
  const bound = vi.fn();
  const scope = effectScope(); scopes.push(scope);
  const flow = scope.run(() => useQqLogin(login, bound))!;
  vi.mocked(authRequest).mockResolvedValueOnce(response);
  return { flow, login, bound, desktop, remove, scope, complete: (nonce: string) => complete(nonce) };
}

afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('只有匹配原请求的返回事件能兑换，重复事件不重复登录', async () => {
  const f = setup();
  await f.flow.start();
  expect(f.desktop.openQqLogin).toHaveBeenCalledWith(response.authorizationUrl);
  await f.complete('x'.repeat(43));
  expect(authRequest).toHaveBeenCalledTimes(1);
  const user = { id: 'user', nickname: '昵称', avatar: '', administrator: false };
  vi.mocked(authRequest).mockResolvedValueOnce({ user, newAccount: true });
  await f.complete(request);
  expect(authRequest).toHaveBeenLastCalledWith('qq/exchange', 'POST', { request, verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(f.login).toHaveBeenCalledExactlyOnceWith(user, true);
  await f.complete(request);
  expect(authRequest).toHaveBeenCalledTimes(2);
  expect(f.flow.busy.value).toBe(false);
});

it('取消等待或组件销毁后忽略浏览器迟到的确认', async () => {
  const f = setup(); await f.flow.start(); f.flow.cancel();
  await f.complete(request);
  expect(authRequest).toHaveBeenCalledTimes(1);
  vi.mocked(authRequest).mockResolvedValueOnce(response);
  await f.flow.start(true); f.scope.stop();
  await f.complete(request);
  expect(authRequest).toHaveBeenCalledTimes(2);
  expect(f.remove).toHaveBeenCalledOnce();
});

it('绑定只调用原账号绑定接口，失败明确反馈并允许重试', async () => {
  const f = setup(); await f.flow.start(true);
  vi.mocked(authRequest).mockRejectedValueOnce(new Error('当前账号已有关联'));
  await f.complete(request);
  expect(authRequest).toHaveBeenLastCalledWith('qq/binding/confirm', 'POST', expect.any(Object));
  expect(f.flow.error.value).toBe('当前账号已有关联');
  expect(f.flow.busy.value).toBe(false);
  expect(f.login).not.toHaveBeenCalled();
});

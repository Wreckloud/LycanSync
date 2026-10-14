import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AuthSessionStatus, AuthUser } from './auth/authApi';

const script = parse(readFileSync(new URL('./AuthRoot.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('AuthRoot.ts', script, ts.ScriptTarget.Latest, true);
const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'verifyCurrentSession');
if (!declaration) throw new Error('登录心跳回调不存在');
const compiled = ts.transpile(declaration.getText(sourceFile), { target: ts.ScriptTarget.ES2022 });

function setup() {
  let resolve!: (status: AuthSessionStatus) => void;
  const pending = new Promise<AuthSessionStatus>((done) => { resolve = done; });
  const user = ref<AuthUser | null>({ id: 'member', nickname: '旧昵称', avatar: '', administrator: false });
  const authRequest = vi.fn(() => pending);
  // 执行正式心跳回调，只控制请求返回顺序，不启动页面、客户端或服务器。
  const context = { user, authRequest, disposed: false, sessionHeartbeatInFlight: false };
  const verify = runInNewContext(`${compiled}\nverifyCurrentSession`, context) as () => Promise<void>;
  return { context, verify, resolve };
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

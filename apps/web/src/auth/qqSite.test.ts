import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const script = readFileSync(new URL('../../../../services/api/src/main/resources/qq-site/site.js', import.meta.url), 'utf8');
const request = 'r'.repeat(43);

async function website(signature: string) {
  const identifiers = ['qq-login', 'feedback', 'identity', 'nickname', 'avatar', 'account-title', 'account-description',
    'result-actions', 'confirm-login', 'return-app', 'profile-form', 'profile-nickname', 'profile-signature', 'logout'];
  const buttons = [{ disabled: false }, { disabled: false }];
  const elements = Object.fromEntries(identifiers.map(id => [id, {
    value: '', textContent: '', hidden: false, disabled: false, src: '', onclick: undefined as (() => Promise<void>) | undefined,
    classList: { toggle: vi.fn() },
    listeners: {} as Record<string, (event: { preventDefault(): void }) => Promise<void>>,
    addEventListener(event: string, callback: (event: { preventDefault(): void }) => Promise<void>) { this.listeners[event] = callback; },
    querySelectorAll: () => buttons,
  }]));
  let user = { id: 'synthetic-account', nickname: '原昵称', avatar: 'original-avatar', administrator: false, signature };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/auth/qq/result?')) return Response.json({ ready: true, desktop: false, purpose: 'LOGIN', nickname: user.nickname, avatar: user.avatar });
    if (url === '/api/auth/qq/exchange') return Response.json({ sessionToken: 's'.repeat(43), user });
    if (url === '/api/auth/me' && init.method === 'PUT') {
      const profile = JSON.parse(init.body as string);
      // 复现正式 DTO 的 40 字上限；省略签名时沿用原资料，不替换后端测试。
      if (profile.signature?.length > 40) return Response.json({ detail: '签名长度不符合要求' }, { status: 400 });
      user = { ...user, ...profile };
      return Response.json(user);
    }
    throw new Error('Unexpected synthetic website request');
  });
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id], body: { classList: { add: vi.fn() } } },
    location: { pathname: '/qq/result', hash: '#request=' + request, origin: 'https://synthetic.example' },
    history: { replaceState: vi.fn() }, sessionStorage: { getItem: () => 'v'.repeat(43), removeItem: vi.fn() },
    fetch: fetchMock, URLSearchParams, AbortSignal, Error,
  });
  await vi.waitFor(() => expect(elements['confirm-login']!.onclick).toBeTypeOf('function'));
  await elements['confirm-login']!.onclick!();
  expect(elements['profile-signature']!.value).toBe(signature);
  return {
    elements, fetchMock, buttons,
    submit: () => elements['profile-form']!.listeners.submit!({ preventDefault: vi.fn() }),
    profileRequest: () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me').at(-1)!,
  };
}

describe('官网账号资料保存', () => {
  test('旧长签名保持原文，只改昵称时省略签名并正常保存', async () => {
    const legacy = '旧'.repeat(120);
    const state = await website(legacy);
    state.elements['profile-nickname']!.value = ' 新昵称 ';
    await state.submit();
    expect(JSON.parse(state.profileRequest()[1].body as string)).toEqual({ nickname: '新昵称', avatar: 'original-avatar' });
    expect(state.elements.feedback!.textContent).toBe('资料已保存。');
    expect(state.elements['profile-signature']!.value).toBe(legacy);
    expect(state.profileRequest()[1].headers).toEqual(expect.objectContaining({ Authorization: 'Bearer ' + 's'.repeat(43) }));
  });

  test.each(['字'.repeat(40), ''])('签名实际修改后提交新值，包括明确清空：%s', async signature => {
    const state = await website('原签名');
    state.elements['profile-signature']!.value = signature ? ' ' + signature + ' ' : '';
    await state.submit();
    expect(JSON.parse(state.profileRequest()[1].body as string)).toEqual({ nickname: '原昵称', avatar: 'original-avatar', signature });
    expect(state.elements['profile-signature']!.value).toBe(signature);
    expect(state.elements.feedback!.textContent).toBe('资料已保存。');
    expect(state.buttons.every(button => !button.disabled)).toBe(true);
  });
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const { readConfiguration } = vi.hoisted(() => ({ readConfiguration: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: readConfiguration }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('LIVEKIT_API_KEY', undefined);
  vi.stubEnv('LIVEKIT_API_SECRET', undefined);
  vi.stubEnv('LIVEKIT_PORT', undefined);
  readConfiguration.mockReset().mockImplementation(() => { throw new Error('不允许读取项目配置'); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function expectSignedToken(token: string, key: string, secret: string) {
  const [header, body, signature] = token.split('.');
  expect(JSON.parse(Buffer.from(body!, 'base64url').toString()).iss).toBe(key);
  expect(signature).toBe(createHmac('sha256', secret).update(header + '.' + body).digest('base64url'));
}

async function redeemDesktopAccess(api: { url: string; accessOffer: { token: string } }) {
  const response = await fetch(api.url + '/api/auth/access/redeem', { method: 'POST',
    body: JSON.stringify({ token: api.accessOffer.token, redemptionKey: 'r'.repeat(43) }) });
  expect(response.status).toBe(200);
  const account = await response.json();
  expect(account.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { Authorization: `Bearer ${account.sessionToken}` };
}

test('仅收集测试或创建合成身份不读取项目配置', async () => {
  const fixture = await import('../fixtures/authenticatedRtc');
  expect(fixture.testUser('合成成员').nickname).toBe('合成成员');
  fixture.useNewTestGroups();
  expect(readConfiguration).not.toHaveBeenCalled();
});

test('显式测试凭据和端口直接签名请求，不读取项目配置', async () => {
  vi.stubEnv('LIVEKIT_API_KEY', 'isolated-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'isolated-secret-at-least-32-characters');
  vi.stubEnv('LIVEKIT_PORT', '17980');
  const request = vi.fn().mockImplementation(async () => Response.json({ participants: [] }));
  vi.stubGlobal('fetch', request);
  const fixture = await import('../fixtures/authenticatedRtc');
  await expect(fixture.summary('synthetic-group')).resolves.toEqual({ participantCount: 0, participants: [] });
  const [url, options] = request.mock.calls[0]!;
  expect(url).toBe('http://127.0.0.1:17980/twirp/livekit.RoomService/ListParticipants');
  expectSignedToken(options.headers.Authorization.slice(7), 'isolated-key', 'isolated-secret-at-least-32-characters');
  expect(JSON.parse(options.body).room).toBe('lycan-sync-group-synthetic-group');
  expect(readConfiguration).not.toHaveBeenCalled();
});

for (const name of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
  test(`只显式提供${name}时明确失败，不混用项目凭据`, async () => {
    vi.stubEnv(name, 'partial-test-configuration');
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const fixture = await import('../fixtures/authenticatedRtc');
    await expect(fixture.summary()).rejects.toThrow(/LIVEKIT_API_KEY.*LIVEKIT_API_SECRET/);
    expect(request).not.toHaveBeenCalled();
    expect(readConfiguration).not.toHaveBeenCalled();
  });
}

test('现有本地配置只在首次RTC调用读取一次，后续复用同一实例配置', async () => {
  readConfiguration.mockReturnValue('LIVEKIT_API_KEY=local-test-key\nLIVEKIT_API_SECRET=local-test-secret\nLIVEKIT_PORT=17981\n');
  const request = vi.fn().mockImplementation(async () => Response.json({ participants: [] }));
  vi.stubGlobal('fetch', request);
  const fixture = await import('../fixtures/authenticatedRtc');
  expect(readConfiguration).not.toHaveBeenCalled();
  await fixture.summary();
  await fixture.summary();
  expect(readConfiguration).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.every(([url]) => url.startsWith('http://127.0.0.1:17981/'))).toBe(true);
});

test('桌面合成API使用显式测试实例签发语音令牌，启动及关闭不读取项目配置', async () => {
  vi.stubEnv('LIVEKIT_API_KEY', 'desktop-isolated-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'desktop-isolated-secret-at-least-32-characters');
  vi.stubEnv('LIVEKIT_PORT', '17982');
  const fixture = await import('../fixtures/authenticatedRtc');
  const api = await fixture.startDesktopApi();
  try {
    expect(readConfiguration).not.toHaveBeenCalled();
    const headers = await redeemDesktopAccess(api);
    const response = await fetch(api.url + '/api/rtc/token', { method: 'POST',
      headers,
      body: JSON.stringify({ groupId: 'synthetic-group' }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.serverUrl).toBe('ws://127.0.0.1:17982');
    expect(result.roomName).toBe('lycan-sync-group-synthetic-group');
    expectSignedToken(result.token, 'desktop-isolated-key', 'desktop-isolated-secret-at-least-32-characters');
    expect(readConfiguration).not.toHaveBeenCalled();
  } finally { await api.close(); }
});

test('合成API的群组语音人数使用实际房间摘要，不把未实现接口当空人数', async () => {
  vi.stubEnv('LIVEKIT_API_KEY', 'occupancy-test-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'occupancy-test-secret');
  vi.stubEnv('LIVEKIT_PORT', '17983');
  const request = globalThis.fetch;
  let roomRequests = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, options) => {
    if (!String(url).startsWith('http://127.0.0.1:17983/')) return request(url, options);
    roomRequests++;
    return Response.json({ participants: [{ identity: 'synthetic-member', name: '合成成员' }] });
  }));
  const fixture = await import('../fixtures/authenticatedRtc');
  const api = await fixture.startDesktopApi();
  try {
    const headers = await redeemDesktopAccess(api);
    const groups = await (await request(api.url + '/api/groups', { headers })).json();
    const response = await request(api.url + '/api/rtc/room-occupancies', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(groups.map((group: { id: string }) => ({ groupId: group.id, participantCount: 1 })));
    expect(roomRequests).toBe(2);
    expect(readConfiguration).not.toHaveBeenCalled();
  } finally { await api.close(); }
});

test('桌面API先兑换合成邀请再建立会话，退出后旧会话不能继续访问', async () => {
  const fixture = await import('../fixtures/authenticatedRtc');
  const api = await fixture.startDesktopApi();
  try {
    expect(await (await fetch(api.url + '/api/auth/options')).json())
      .toEqual({ mode: 'invite', qqAvailable: false, initialized: true });
    expect((await fetch(api.url + '/api/auth/me')).status).toBe(401);
    expect((await fetch(api.url + '/api/rtc/token', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(api.url + '/api/auth/access/redeem', { method: 'POST',
      body: JSON.stringify({ token: 'wrong-invitation', redemptionKey: 'r'.repeat(43) }) })).status).toBe(400);
    expect((await fetch(api.url + '/api/auth/me')).status).toBe(401);
    const preview = await fetch(api.url + '/api/auth/access/preview', { method: 'POST',
      body: JSON.stringify({ token: api.accessOffer.token }) });
    expect(await preview.json()).toMatchObject({ kind: 'INVITE', status: 'PENDING' });
    const headers = await redeemDesktopAccess(api);
    const account = await (await fetch(api.url + '/api/auth/me', { headers })).json();
    expect(account.nickname).toBe('测试小狼');
    expect((await fetch(api.url + '/api/auth/me', { headers: { Authorization: 'Bearer old-session' } })).status).toBe(401);
    expect((await fetch(api.url + '/api/auth/logout', { method: 'POST', headers })).status).toBe(204);
    expect((await fetch(api.url + '/api/auth/me', { headers })).status).toBe(401);
    expect(readConfiguration).not.toHaveBeenCalled();
  } finally { await api.close(); }
});

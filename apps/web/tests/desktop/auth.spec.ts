import { test, expect, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchIsolatedDesktop } from './fixtures/isolatedDesktop';

async function createAccountServer(administrator = true) {
  const user = { id: randomUUID(), nickname: '行者1001', avatar: '', signature: '', administrator };
  let token = '';
  let revoked = false;
  let holdNextSession = false;
  let releaseOldSession = () => {};
  let delayedStarted = () => {};
  const started = new Promise<void>((resolve) => { delayedStarted = resolve; });
  let logoutCount = 0;
  let redemptions = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    const reply = (status: number, value?: unknown) => { response.writeHead(status); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    const authenticated = !!token && !revoked && request.headers.authorization === 'Bearer ' + token;
    if (request.url === '/api/auth/options') return reply(200, { mode: 'invite' });
    if (request.url === '/api/auth/access/preview') return reply(200, { kind: redemptions ? 'RECOVERY' : administrator ? 'ACTIVATE' : 'INVITE', status: 'PENDING', serverName: '测试服务器' });
    if (request.url === '/api/auth/access/redeem') {
      const redemption = JSON.parse(body);
      if (!/^[A-Za-z0-9_-]{43}$/.test(redemption.redemptionKey)
          || redemption.token !== (redemptions ? 'e' : 'a').repeat(43)) return reply(400);
      token = randomBytes(32).toString('base64url');
      redemptions++;
      revoked = false;
      return reply(200, { sessionToken: token, user });
    }
    if (request.url === '/api/auth/logout') { logoutCount++; return reply(204); }
    if (request.url === '/api/auth/session' && holdNextSession) {
      holdNextSession = false;
      const gate = new Promise<void>((resolve) => { releaseOldSession = resolve; });
      delayedStarted();
      await gate;
      return reply(401, { detail: '旧会话已失效' });
    }
    if (request.url === '/api/auth/me' || request.url === '/api/auth/session') return reply(authenticated ? 200 : 401, authenticated ? user : { detail: '会话已失效' });
    if (request.url === '/api/presence/heartbeat') return reply(204);
    if (request.url === '/api/groups' || request.url?.startsWith('/api/rtc/room-occupancies')) return reply(200, []);
    return reply(404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  const origin = 'http://127.0.0.1:' + address.port;
  return { origin, user, get token() { return token; }, get logoutCount() { return logoutCount; },
    get redemptions() { return redemptions; },
    delaySession: () => { holdNextSession = true; }, started, release: () => releaseOldSession(),
    revoke: () => { revoked = true; }, close: async () => {
      releaseOldSession();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}

async function redeem(application: ElectronApplication, origin: string, recovery = false) {
  const page = await application.firstWindow();
  await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
  // 协议解析另有冷启动／第二实例用例；此处用受控事件验证真实兑换、加密和会话处理。
  await application.evaluate(({ BrowserWindow }, offer) => {
    BrowserWindow.getAllWindows()[0].webContents.send('auth:access:offer', offer);
  }, { server: origin, token: (recovery ? 'e' : 'a').repeat(43) });
  await page.getByRole('button', { name: /^(确认激活|确认加入|恢复登录)$/ }).click();
  if (!recovery) await page.getByRole('button', { name: '跳过', exact: true }).click();
  await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
  return page;
}

for (const administrator of [true, false]) {
  test(`${administrator ? '服主激活' : '成员邀请'}兑换后加密保存、重启恢复并退出`, async () => {
    const api = await createAccountServer(administrator);
    const directory = test.info().outputPath('account');
    const sessionFile = resolve(directory, 'profile/session.bin');
    let application: ElectronApplication | undefined;
    try {
      ({ application } = await launchIsolatedDesktop(directory, api.origin));
      const page = await redeem(application, api.origin);
      expect(existsSync(sessionFile)).toBe(true);
      expect(readFileSync(sessionFile).includes(Buffer.from(api.token))).toBe(false);
      await application.close();
      const unusedLink = `lycansync://access?server=https%3A%2F%2Fexample.com#token=${'b'.repeat(43)}`;
      ({ application } = await launchIsolatedDesktop(directory, api.origin, unusedLink));
      const restored = await application.firstWindow();
      await expect(restored.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
      await expect(restored.locator('.access-prompt')).toHaveCount(0);
      // 冷启动携带链接和运行中收到链接都不覆盖已有账号，也不触发兑换。
      await application.evaluate(({ BrowserWindow }, offer) => {
        BrowserWindow.getAllWindows()[0].webContents.send('auth:access:offer', offer);
      }, { server: api.origin, token: 'b'.repeat(43) });
      await expect(restored.locator('.access-prompt')).toHaveCount(0);
      await expect(restored.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
      expect(api.redemptions).toBe(1);
      await restored.getByRole('button', { name: '语音与音频设置', exact: true }).click();
      await restored.getByRole('button', { name: '账号设置', exact: true }).click();
      await restored.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(restored.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
      await expect.poll(() => api.logoutCount).toBe(1);
      await expect.poll(() => existsSync(sessionFile)).toBe(false);
      expect(await page.isClosed()).toBe(true);
    } finally { await application?.close(); await api.close(); }
  });
}

test('旧桌面会话的延迟 401 不退出新会话，当前会话 401 仍会退出', async () => {
  const api = await createAccountServer(false);
  const directory = test.info().outputPath('race');
  const { application } = await launchIsolatedDesktop(directory, api.origin);
  try {
    const page = await application.firstWindow();
    await page.clock.install();
    await redeem(application, api.origin);
    api.delaySession();
    await page.clock.fastForward(20_100);
    await api.started;
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await redeem(application, api.origin, true);
    const delayed = page.waitForResponse((r) => r.url().endsWith('/api/auth/session') && r.status() === 401);
    api.release();
    expect(await (await delayed).headerValue('X-Lycan-Session-Expired')).toBe('false');
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    expect(existsSync(resolve(directory, 'profile/session.bin'))).toBe(true);
    api.revoke();
    const current = page.waitForResponse((r) => r.url().endsWith('/api/auth/session') && r.status() === 401);
    await page.clock.fastForward(20_100);
    expect(await (await current).headerValue('X-Lycan-Session-Expired')).toBe('true');
    await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
    expect(existsSync(resolve(directory, 'profile/session.bin'))).toBe(false);
  } finally { api.release(); await application.close(); await api.close(); }
});

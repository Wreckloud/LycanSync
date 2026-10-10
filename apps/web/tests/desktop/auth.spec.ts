import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('桌面本地注册、加密保存、重启恢复与退出撤销', async () => {
  const token = randomBytes(32).toString('base64url');
  const user = { id: randomUUID(), nickname: 'Admin', avatar: '', administrator: true };
  let registration: Record<string, unknown> | undefined;
  let initialized = false;
  let revoked = false;
  let authorizedRequests = 0;
  let groupAuthorizedRequests = 0;
  let sessionRequests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/system/initialization') response.end(JSON.stringify({ initialized }));
    else if (request.url === '/api/auth/local/register') {
      registration = JSON.parse(body);
      initialized = true;
      response.end(JSON.stringify({ sessionToken: token, user }));
    } else if (request.url === '/api/auth/me') {
      if (request.headers.authorization !== 'Bearer ' + token || revoked) {
        response.writeHead(401); response.end('{}');
      } else { authorizedRequests++; response.end(JSON.stringify(user)); }
    } else if (request.url === '/api/auth/session') {
      if (request.headers.authorization !== 'Bearer ' + token || revoked) {
        response.writeHead(401); response.end('{}');
      } else {
        sessionRequests++;
        response.end(JSON.stringify({
          id: user.id, nickname: user.nickname, administrator: user.administrator,
        }));
      }
    } else if (request.url === '/api/auth/logout' && request.headers.authorization === 'Bearer ' + token) {
      revoked = true; response.writeHead(204); response.end();
    } else if (request.url === '/api/groups') {
      if (request.headers.authorization !== 'Bearer ' + token || revoked) {
        response.writeHead(401); response.end('{}');
      } else { groupAuthorizedRequests++; response.end('[]'); }
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
  const userDataDir = test.info().outputPath('auth-profile');
  mkdirSync(userDataDir, { recursive: true });
  const launch = () => electron.launch({
    args: [resolve('electron/main.cjs'), '--user-data-dir=' + userDataDir],
    env: { ...process.env, LYCANSYNC_API_URL: 'http://127.0.0.1:' + address.port },
  });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.clock.install();
    await expect(page.getByRole('heading', { name: '一起开黑，一起看' })).toBeVisible();
    const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/local/register'));
    await page.getByLabel('用户名').fill('Admin');
    await page.getByLabel('密码', { exact: true }).fill('administrator-password');
    await page.getByLabel('确认密码').fill('administrator-password');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    expect(await (await registrationResponse).json()).not.toHaveProperty('sessionToken');
    expect(registration).toEqual({ username: 'Admin', password: 'administrator-password' });
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    await expect.poll(() => groupAuthorizedRequests).toBeGreaterThan(0);
    await page.clock.fastForward(20_100);
    await expect.poll(() => sessionRequests).toBe(1);
    const saved = readFileSync(resolve(userDataDir, 'session.bin'));
    expect(saved.toString('utf8')).not.toContain(token);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);

    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    expect(authorizedRequests).toBeGreaterThan(0);
    if (!await page.locator('.settings-view').isVisible()) {
      await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
    }
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改昵称，Admin', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect(revoked).toBe(true);
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(false);
  } finally {
    await application.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

test('旧桌面会话的延迟 401 不退出新会话，当前会话 401 仍会退出', async () => {
  const oldToken = randomBytes(32).toString('base64url');
  const currentToken = randomBytes(32).toString('base64url');
  const user = { id: randomUUID(), nickname: 'Session race', avatar: '', administrator: false };
  let loginCount = 0;
  let delayedSessionStarted!: () => void;
  let releaseDelayedSession!: () => void;
  let delayedSessionFinished!: () => void;
  const delayedSessionStartedPromise = new Promise<void>((resolve) => { delayedSessionStarted = resolve; });
  const delayedSessionGate = new Promise<void>((resolve) => { releaseDelayedSession = resolve; });
  const delayedSessionFinishedPromise = new Promise<void>((resolve) => { delayedSessionFinished = resolve; });
  let delayedSessionUsed = false;
  let currentSessionExpired = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before responding. */ }
    response.setHeader('Content-Type', 'application/json');
    const authorization = request.headers.authorization;
    if (request.url === '/api/system/initialization') response.end(JSON.stringify({ initialized: true }));
    else if (request.url === '/api/auth/me') {
      if (authorization === 'Bearer ' + currentToken && currentSessionExpired) {
        response.writeHead(401); response.end('{}');
      } else if (authorization === 'Bearer ' + oldToken || authorization === 'Bearer ' + currentToken) {
        response.end(JSON.stringify(user));
      } else { response.writeHead(401); response.end('{}'); }
    } else if (request.url === '/api/auth/local/login') {
      loginCount++;
      response.end(JSON.stringify({ sessionToken: loginCount === 1 ? oldToken : currentToken, user }));
    } else if (request.url === '/api/auth/session' && authorization === 'Bearer ' + oldToken && !delayedSessionUsed) {
      delayedSessionUsed = true;
      delayedSessionStarted();
      await delayedSessionGate;
      response.writeHead(401); response.end('{}');
      delayedSessionFinished();
    } else if (request.url === '/api/auth/session' && authorization === 'Bearer ' + currentToken) {
      if (currentSessionExpired) { response.writeHead(401); response.end('{}'); }
      else response.end(JSON.stringify({ id: user.id, nickname: user.nickname, administrator: user.administrator }));
    } else if (request.url === '/api/auth/logout'
      && [oldToken, currentToken].some((token) => authorization === 'Bearer ' + token)) {
      response.writeHead(204); response.end();
    } else if (request.url === '/api/groups' && authorization) response.end('[]');
    else if (request.url?.startsWith('/api/rtc/room-occupancies')) response.end('[]');
    else if (request.url === '/api/presence/heartbeat') { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
  const userDataDir = test.info().outputPath('session-race-profile');
  mkdirSync(userDataDir, { recursive: true });
  const application = await electron.launch({
    args: [resolve('electron/main.cjs'), '--user-data-dir=' + userDataDir],
    env: { ...process.env, LYCANSYNC_API_URL: 'http://127.0.0.1:' + address.port },
  });
  try {
    const page = await application.firstWindow();
    await page.clock.install();
    await expect(page.getByRole('heading', { name: '一起开黑，一起看' })).toBeVisible();
    await page.getByLabel('用户名').fill('session_race');
    await page.getByLabel('密码', { exact: true }).fill('session-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();

    await page.clock.fastForward(20_100);
    await delayedSessionStartedPromise;
    if (!await page.locator('.settings-view').isVisible()) {
      await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
    }
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(false);

    await page.getByLabel('用户名').fill('session_race');
    await page.getByLabel('密码', { exact: true }).fill('session-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(true);

    const delayedResponsePromise = page.waitForResponse((result) =>
      result.url().endsWith('/api/auth/session') && result.status() === 401);
    releaseDelayedSession();
    const delayedResponse = await delayedResponsePromise;
    expect(await delayedResponse.headerValue('X-Lycan-Session-Expired')).toBe('false');
    await delayedSessionFinishedPromise;
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(true);

    currentSessionExpired = true;
    const currentSessionResponsePromise = page.waitForResponse((result) =>
      result.url().endsWith('/api/auth/session') && result.status() === 401);
    await page.clock.fastForward(20_100);
    const currentSessionResponse = await currentSessionResponsePromise;
    expect(await currentSessionResponse.headerValue('X-Lycan-Session-Expired')).toBe('true');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(false);
  } finally {
    releaseDelayedSession();
    await application.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

test('桌面已初始化服务器允许创建普通账号', async () => {
  const token = randomBytes(32).toString('base64url');
  const user = { id: randomUUID(), nickname: 'Friend', avatar: '', administrator: false };
  let registration: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/system/initialization') response.end(JSON.stringify({ initialized: true }));
    else if (request.url === '/api/auth/local/register') {
      registration = JSON.parse(body);
      response.end(JSON.stringify({ sessionToken: token, user }));
    } else if (request.url === '/api/auth/me') {
      if (request.headers.authorization !== 'Bearer ' + token) {
        response.writeHead(401); response.end('{}');
      } else response.end(JSON.stringify(user));
    } else if (request.url === '/api/auth/session') {
      if (request.headers.authorization !== 'Bearer ' + token) {
        response.writeHead(401); response.end('{}');
      } else response.end(JSON.stringify({
        id: user.id, nickname: user.nickname, administrator: user.administrator,
      }));
    } else if (request.url === '/api/groups') {
      response.end('[]');
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
  const userDataDir = test.info().outputPath('open-registration-profile');
  mkdirSync(userDataDir, { recursive: true });
  const backendOrigin = 'http://127.0.0.1:' + address.port;
  const application = await electron.launch({
    args: [resolve('electron/main.cjs'), '--user-data-dir=' + userDataDir],
    env: { ...process.env, LYCANSYNC_API_URL: backendOrigin },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '没有账号，创建账号' }).click();
    await page.getByLabel('用户名').fill('Friend');
    await page.getByLabel('密码', { exact: true }).fill('friend-password');
    await page.getByLabel('确认密码').fill('friend-password');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    expect(registration).toEqual({ username: 'Friend', password: 'friend-password' });
    const saved = readFileSync(resolve(userDataDir, 'session.bin'));
    expect(saved.toString('utf8')).not.toContain(token);
    if (!await page.locator('.settings-view').isVisible()) {
      await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
    }
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
    const profileSettings = page.locator('.settings-view');
    const initialBounds = await profileSettings.boundingBox();
    await page.getByLabel('上传头像').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    });
    const cropDialog = page.getByRole('dialog', { name: '调整头像' });
    await expect(cropDialog).toBeVisible();
    await expect(cropDialog.getByAltText('待裁剪头像')).toHaveJSProperty('naturalWidth', 1);
    expect(await cropDialog.getByAltText('待裁剪头像').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(await profileSettings.boundingBox()).toEqual(initialBounds);
    await cropDialog.getByRole('button', { name: '取消裁剪' }).click();
    await expect(cropDialog).toHaveCount(0);
  } finally {
    await application.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

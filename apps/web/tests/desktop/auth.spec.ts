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
    } else if (request.url === '/api/auth/logout' && request.headers.authorization === 'Bearer ' + token) {
      revoked = true; response.writeHead(204); response.end();
    } else if (request.url?.startsWith('/api/rtc/room-summary')) {
      response.end(JSON.stringify({ participantCount: 0, participantNames: [] }));
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
    await expect(page.getByRole('heading', { name: '一起开黑，一起看' })).toBeVisible();
    const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/local/register'));
    await page.getByLabel('用户名').fill('Admin');
    await page.getByLabel('密码', { exact: true }).fill('administrator-password');
    await page.getByLabel('确认密码').fill('administrator-password');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    expect(await (await registrationResponse).json()).not.toHaveProperty('sessionToken');
    expect(registration).toEqual({ username: 'Admin', password: 'administrator-password' });
    await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
    const saved = readFileSync(resolve(userDataDir, 'session.bin'));
    expect(saved.toString('utf8')).not.toContain(token);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);

    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
    expect(authorizedRequests).toBeGreaterThan(0);
    await page.getByRole('button', { name: '个人设置', exact: true }).click();
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('Admin');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect(revoked).toBe(true);
    expect(existsSync(resolve(userDataDir, 'session.bin'))).toBe(false);
  } finally {
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
    } else if (request.url?.startsWith('/api/rtc/room-summary')) {
      response.end(JSON.stringify({ participantCount: 0, participantNames: [] }));
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
    await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
    expect(registration).toEqual({ username: 'Friend', password: 'friend-password' });
    const saved = readFileSync(resolve(userDataDir, 'session.bin'));
    expect(saved.toString('utf8')).not.toContain(token);
  } finally {
    await application.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

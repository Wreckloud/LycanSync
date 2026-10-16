import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopTestEnvironment } from './fixtures/desktopTestEnvironment';

declare global { var releaseEntryWindowUpdate: () => void; }

test('入口窗口随更新、登录、更多与邀请内容收缩，不登录、不启动媒体', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/options') response.end(JSON.stringify({ mode: 'invite', qqAvailable: false }));
    else if (request.url === '/api/auth/me') { response.writeHead(401); response.end('{}'); }
    else if (request.url === '/api/auth/access/preview') response.end(JSON.stringify({ kind: 'INVITE', status: 'PENDING', serverName: '模拟服务器' }));
    else { response.writeHead(503); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('模拟服务器未启动');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = test.info().outputPath('entry-window');
  mkdirSync(directory, { recursive: true });
  const entry = resolve(directory, 'entry.cjs');
  // 只延迟测试进程的更新完成，以观察真实入口页；不下载、登录或扫描游戏。
  writeFileSync(entry, `const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function () { this.showInactive(); };
const updates = require(${JSON.stringify(resolve('electron/startup-update.cjs'))});
const create = updates.createStartupUpdate;
updates.createStartupUpdate = (options) => {
  const update = create(options);
  const wait = new Promise((done) => { global.releaseEntryWindowUpdate = done; });
  return { ...update, start: async () => { await wait; return update.start(); } };
};
require(${JSON.stringify(resolve('electron/main.cjs'))});
`);
  const application = await electron.launch({ args: [entry, '--user-data-dir=' + resolve(directory, 'profile')],
    env: desktopTestEnvironment(directory, origin) });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '准备进入 LycanSync' })).toBeVisible();
    const bounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await expect.poll(async () => (await bounds()).width).toBeLessThanOrEqual(428);
    const fitsCard = () => page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.startup-update-card, .auth-card')!;
      const rect = card.getBoundingClientRect();
      return Math.abs(rect.x) <= 1 && Math.abs(rect.width - innerWidth) <= 1 && Math.abs(rect.bottom - innerHeight) <= 2;
    });
    await expect.poll(fitsCard).toBe(true);
    const checkingHeight = (await bounds()).height;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', {
      phase: 'downloading', version: '0.1.1', nextVersion: '0.1.2', percent: 25, supported: true, message: '正在下载新版…',
    }));
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect.poll(async () => (await bounds()).height).toBeGreaterThan(checkingHeight);
    await expect.poll(fitsCard).toBe(true);
    await application.evaluate(() => global.releaseEntryWindowUpdate());
    await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
    await expect.poll(async () => (await bounds()).width).toBeLessThanOrEqual(448);
    await expect.poll(fitsCard).toBe(true);
    await expect(page.getByRole('button', { name: '最大化窗口', exact: true })).toHaveCount(0);
    const accountHeight = (await bounds()).height;
    await page.getByText('更多', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: '邀请或恢复登录链接', exact: true })).toBeVisible();
    await expect.poll(async () => (await bounds()).height).toBeGreaterThan(accountHeight);
    await page.getByText('更多', { exact: true }).click();
    await expect.poll(async () => (await bounds()).height).toBeLessThanOrEqual(accountHeight + 2);
    await page.screenshot({ path: test.info().outputPath('entry-account.png') });
    await application.evaluate(({ BrowserWindow }, server) => BrowserWindow.getAllWindows()[0].webContents.send('auth:access:offer', {
      server, token: 'a'.repeat(43),
    }), origin);
    await expect(page.getByRole('button', { name: '确认加入', exact: true })).toBeVisible();
    await expect.poll(async () => (await bounds()).width).toBeGreaterThan(448);
    await expect.poll(fitsCard).toBe(true);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(async () => (await bounds()).width).toBeLessThanOrEqual(448);
  } finally {
    await application.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

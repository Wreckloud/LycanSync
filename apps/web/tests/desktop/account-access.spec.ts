import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { launchIsolatedDesktop } from './fixtures/isolatedDesktop';

test('邀请参数从冷启动和第二实例传到确认页面', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/options') response.end(JSON.stringify({ mode: 'invite' }));
    else if (request.url === '/api/system/initialization') response.end(JSON.stringify({ initialized: false }));
    else { response.writeHead(401); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
  const userDirectory = test.info().outputPath('access-profile');
  const link = `lycansync://access/?server=https%3A%2F%2Fexample.com#token=${'a'.repeat(43)}`;
  try {
    const { application, args, env } = await launchIsolatedDesktop(userDirectory, 'http://127.0.0.1:' + address.port, link);
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('button', { name: '连接并重启' })).toBeVisible();
      await page.getByRole('button', { name: '关闭邀请', exact: true }).click();
      await expect(page.locator('.access-prompt')).toHaveCount(0);
      await page.getByText('更多', { exact: true }).click();
      await page.getByLabel('邀请或恢复登录链接', { exact: true }).fill('https://example.com/join#token=short');
      await page.getByRole('button', { name: '检查链接', exact: true }).click();
      await expect(page.getByText('链接无效，请粘贴完整的 HTTPS 邀请链接或 LycanSync 打开链接。')).toBeVisible();
      await expect(page.locator('.access-prompt')).toHaveCount(0);
      await page.getByLabel('邀请或恢复登录链接', { exact: true }).fill(`https://example.com/join#token=${'a'.repeat(43)}`);
      await page.getByRole('button', { name: '检查链接', exact: true }).click();
      await expect(page.getByRole('button', { name: '连接并重启' })).toBeVisible();
      await page.getByRole('button', { name: '关闭邀请', exact: true }).click();
      await page.getByText('更多', { exact: true }).click();
      await expect(page.getByLabel('邀请或恢复登录链接', { exact: true })).toHaveValue('');
      const executable = await application.evaluate(() => process.execPath);
      const child = spawn(executable, [...args, link], { env, windowsHide: true, stdio: 'ignore' });
      try {
        await expect(page.getByRole('button', { name: '连接并重启' })).toBeVisible();
      } finally {
        if (child.exitCode === null) child.kill();
      }
    } finally { await application.close(); }
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});

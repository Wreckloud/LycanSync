import { test, expect, _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { startDesktopApi } from '../fixtures/authenticatedRtc';

test('桌面窗口安全边界、真实控件与退出', async () => {
  const userDataDir = test.info().outputPath('profile');
  mkdirSync(userDataDir, { recursive: true });
  const args = [resolve('electron/main.cjs'), `--user-data-dir=${userDataDir}`];
  const api = await startDesktopApi();
  const application = await electron.launch({ args, env: { ...process.env, LYCANSYNC_API_URL: api.url } });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '关闭窗口', exact: true })).toBeVisible();
    await expect(page.locator('.brand svg')).toHaveCount(0);
    await expect(page.getByText('本地调试', { exact: true })).toHaveCount(0);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);
    await expect(page.locator('.members-panel')).not.toContainText('成员列表尚未开放');
    const chatFontSize = await page.locator('.message-list').evaluate((element) => getComputedStyle(element).fontSize);
    expect(chatFontSize).toBe('14px');
    expect(await page.getByRole('textbox', { name: '消息内容' }).evaluate((element) => getComputedStyle(element).fontSize)).toBe(chatFontSize);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const sizing = await application.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getBounds();
      return { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
    });
    // Windows 的不可见窗口边框会占用少量逻辑像素，工作区边界仍需严格满足。
    expect(Math.abs(sizing.bounds.width - Math.min(1280, sizing.workArea.width - 32))).toBeLessThanOrEqual(8);
    expect(Math.abs(sizing.bounds.height - Math.min(820, sizing.workArea.height - 32))).toBeLessThanOrEqual(8);
    expect(sizing.bounds.x).toBeGreaterThanOrEqual(sizing.workArea.x);
    expect(sizing.bounds.x + sizing.bounds.width).toBeLessThanOrEqual(sizing.workArea.x + sizing.workArea.width);
    expect(sizing.bounds.y + sizing.bounds.height).toBeLessThanOrEqual(sizing.workArea.y + sizing.workArea.height);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 640));
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.locator('.message-list').evaluate((list) => {
      for (let index = 0; index < 40; index++) {
        const message = document.createElement('p');
        message.textContent = '滚动区域测试消息';
        list.append(message);
      }
    });
    expect(await page.locator('.message-list').evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      return list.scrollHeight > list.clientHeight && list.scrollTop > 0 && getComputedStyle(list).scrollbarWidth === 'none';
    })).toBe(true);
    const composerBounds = await page.locator('.composer').boundingBox();
    expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    expect(await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      bridge: typeof window.lycanDesktop?.close,
      secure: window.isSecureContext,
    }))).toEqual({ node: 'undefined', bridge: 'function', secure: true });
    expect(await page.evaluate(async () => (await fetch('/api/not-allowed')).status)).toBe(404);
    expect(await page.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach((track) => track.stop()); return 'allowed'; }
      catch (error) { return (error as Error).name; }
    })).toBe('NotAllowedError');
    await page.getByRole('button', { name: '最大化窗口' }).click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await expect(page.getByRole('button', { name: '还原窗口' })).toBeVisible();
    await expect(page.locator('.window-actions .lucide-copy')).toBeVisible();
    await page.getByRole('button', { name: '还原窗口' }).click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
    await expect(page.locator('.window-actions .lucide-square')).toBeVisible();
    await page.getByRole('button', { name: '最小化窗口' }).click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    // Windows 下 Playwright 的父进程可能是命令包装器，直接启动 Electron 本体。
    const secondInstance = spawn(resolve('node_modules/electron/dist/electron.exe'), args, { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      secondInstance.once('error', reject);
      secondInstance.once('exit', resolveExit);
    });
    expect(exitCode).toBe(0);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
    await page.screenshot({ path: 'test-results/desktop-lobby.png' });
    const closed = application.waitForEvent('close');
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await closed;
  } finally { await application.close(); await api.close(); }
});

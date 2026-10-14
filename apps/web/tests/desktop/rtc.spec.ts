import { test, expect, _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startDesktopApi, summary } from '../fixtures/authenticatedRtc';

test('桌面入房、取消选择、窗口共享及离房释放', async () => {
  const nickname = `桌面测试-${Date.now()}`;
  const userDataDir = test.info().outputPath('profile');
  mkdirSync(userDataDir, { recursive: true });
  const api = await startDesktopApi(nickname);
  const application = await electron.launch({ env: { ...process.env, LYCANSYNC_API_URL: api.url }, args: [resolve('electron/main.cjs'), `--user-data-dir=${userDataDir}`, '--use-fake-device-for-media-stream'] });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /开黑小队，单击预览，双击加入语音/ }).dblclick();
    await expect(page.getByTestId('callbar').getByRole('status')).toContainText('语音已连接');
    expect(await page.getByTestId('callbar').evaluate((panel) => {
      const composer = document.querySelector('.composer')!.getBoundingClientRect();
      return composer.bottom <= panel.getBoundingClientRect().top + 1;
    })).toBe(true);
    await expect(page.getByRole('button', { name: '关闭麦克风', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '应用窗口', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '整个屏幕', exact: true })).toHaveCount(1);
    // 主窗口必须被排除，否则整屏共享会在双开时递归捕获自己的共享画面。
    await expect(page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })
      .getByRole('button', { name: 'LycanSync', exact: true })).toHaveCount(0);
    // 整屏或其他窗口仍必须保留在可选源里，过滤不能清空列表（含取消按钮在内应多于一项）。
    await expect.poll(() => page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })
      .locator('button').count()).toBeGreaterThan(1);
    await page.getByRole('dialog', { name: '选择共享的窗口或屏幕' }).getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始屏幕共享', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // 只选择测试创建的纯色窗口，不录制开发者桌面或其他应用。
    await application.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({ width: 640, height: 480, title: 'LycanSync Capture Test', webPreferences: { sandbox: true, nodeIntegration: false } });
      await target.loadURL('data:text/html,<title>LycanSync Capture Test</title><body style="background:navy;color:white"><h1>LycanSync Synthetic Window</h1></body>');
    });
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await page.getByRole('button', { name: 'LycanSync Capture Test', exact: true }).click();
    await expect(page.getByRole('button', { name: 'LycanSync Capture Test', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '开始共享', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止屏幕共享', exact: true })).toBeEnabled();
    // 整屏共享时也不能从系统截图中排除应用窗口。
    expect(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isContentProtected())).toBe(false);
    await expect.poll(() => page.locator('video').evaluateAll((videos) => videos.some((video) => video instanceof HTMLVideoElement && video.videoWidth > 0))).toBe(true);
    await page.getByRole('button', { name: '离开语音', exact: true }).click();
    await expect(page.getByRole('button', { name: '加入当前群组语音', exact: true })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().filter((window) => window.getTitle() === 'LycanSync Capture Test').forEach((window) => window.destroy());
    });
    await page.getByRole('button', { name: '加入当前群组语音', exact: true }).click();
    await expect(page.getByTestId('callbar').getByRole('status')).toContainText('语音已连接');
    const closed = application.waitForEvent('close');
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await closed;
    await expect.poll(async () => {
      return (await summary()).participants.some((participant) => participant.displayName === nickname);
    }).toBe(false);
  } finally { await application.close(); await api.close(); }
});

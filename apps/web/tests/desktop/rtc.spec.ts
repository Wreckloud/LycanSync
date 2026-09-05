import { test, expect, _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

test('桌面入房、取消选择、窗口共享及离房释放', async () => {
  const nickname = `桌面测试-${Date.now()}`;
  const userDataDir = test.info().outputPath('profile');
  mkdirSync(userDataDir, { recursive: true });
  const application = await electron.launch({ args: [resolve('electron/main.cjs'), `--user-data-dir=${userDataDir}`, '--use-fake-device-for-media-stream'] });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /本地调试房间，单击预览，双击加入语音/ }).dblclick();
    await page.getByLabel('测试昵称').fill(nickname);
    await page.getByRole('button', { name: '加入语音', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('语音已连接');
    const inputPositions = await page.getByTestId('callbar').evaluate((element) => {
      const panel = element as HTMLElement;
      const composer = document.querySelector('.composer')!;
      const samples: number[][] = [];
      for (const name of ['callbar-reveal-in', 'callbar-reveal-out']) {
        panel.style.animation = `${name} 180ms linear both paused`;
        const animation = panel.getAnimations()[0];
        samples.push([0, 90, 180].map((time) => {
          animation.currentTime = time;
          return composer.getBoundingClientRect().y;
        }));
      }
      panel.style.removeProperty('animation');
      return samples;
    });
    expect(inputPositions[0][0]).toBeGreaterThan(inputPositions[0][1]);
    expect(inputPositions[0][1]).toBeGreaterThan(inputPositions[0][2]);
    expect(inputPositions[1][0]).toBeLessThan(inputPositions[1][1]);
    expect(inputPositions[1][1]).toBeLessThan(inputPositions[1][2]);
    await expect(page.getByRole('button', { name: '关闭麦克风', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })).toBeVisible();
    await page.getByRole('button', { name: '取消共享' }).click();
    await expect(page.getByRole('dialog', { name: '选择共享的窗口或屏幕' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始屏幕共享', exact: true })).toBeEnabled();

    // 只选择测试创建的纯色窗口，不录制开发者桌面或其他应用。
    await application.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({ width: 640, height: 480, title: 'LycanSync Capture Test', webPreferences: { sandbox: true, nodeIntegration: false } });
      await target.loadURL('data:text/html,<title>LycanSync Capture Test</title><body style="background:navy;color:white"><h1>LycanSync Synthetic Window</h1></body>');
    });
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await page.getByRole('button', { name: 'LycanSync Capture Test', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止屏幕共享', exact: true })).toBeEnabled();
    await expect.poll(() => page.locator('video').evaluateAll((videos) => videos.some((video) => video instanceof HTMLVideoElement && video.videoWidth > 0))).toBe(true);
    await page.getByRole('button', { name: '离开当前群组语音', exact: true }).click();
    await expect(page.getByRole('button', { name: '加入当前群组语音', exact: true })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().filter((window) => window.getTitle() === 'LycanSync Capture Test').forEach((window) => window.destroy());
    });
    await page.getByRole('button', { name: '加入当前群组语音', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('语音已连接');
    const closed = application.waitForEvent('close');
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await closed;
    await expect.poll(async () => {
      const response = await fetch('http://127.0.0.1:18080/api/rtc/room-summary?groupId=pack');
      const summary = await response.json() as { participantNames: string[] };
      return summary.participantNames.includes(nickname);
    }).toBe(false);
  } finally { await application.close(); }
});

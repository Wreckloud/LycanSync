import { defineConfig } from '@playwright/test';

const webPort = Number(process.env.WEB_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/desktop/**', '**/unit/**'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    permissions: ['microphone'],
    // 使用合成麦克风，不访问开发者的真实录音设备。
    // 显示真实滚动条，布局截图和拖动验证不能使用隐藏轨道的无头默认参数。
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: false,
  },
});

import { defineConfig } from '@playwright/test';

// 显式运行才访问真实窗口；不纳入默认浏览器或桌面回归。
export default defineConfig({
  testDir: './tests/desktop', testMatch: 'thumbnailPicker.spec.ts', workers: 1,
  timeout: 60_000, reporter: 'list', use: { trace: 'off', screenshot: 'off', video: 'off' },
  webServer: { command: 'npm run dev', url: `http://127.0.0.1:${process.env.WEB_PORT ?? 4173}`,
    reuseExistingServer: false, timeout: 30_000 },
});

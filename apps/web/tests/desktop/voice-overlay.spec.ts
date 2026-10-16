import { _electron as electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import type { VoiceOverlaySettings, VoiceOverlaySnapshot } from '../../src/overlay/types';
import { desktopTestEnvironment } from './fixtures/desktopTestEnvironment';

declare global {
  var voiceOverlayTest: {
    owner: string;
    mainId: number;
    failures: string[];
    manager: {
      configure(owner: string, settings: VoiceOverlaySettings): void;
      update(owner: string, snapshot: VoiceOverlaySnapshot): void;
      edit(owner: string, enabled: boolean): void;
      clear(): void;
    };
  };
}

const settings: VoiceOverlaySettings = { enabled: true, mode: 'all', scale: 100, width: 240,
  displayId: null, x: 1, y: 0.5, includeInCapture: false };
const snapshot: VoiceOverlaySnapshot = { sequence: 1, roomId: 'synthetic-room', status: 'connected',
  members: [{ identity: 'one', name: '测试成员', microphone: true, listening: true, speaking: true }],
  portraits: [{ identity: 'one', avatar: '' }] };

test('隔离覆盖页：真实协议与preload、说话展示、权限隔离、最小化、模式切换及清理', async () => {
  const env = desktopTestEnvironment(test.info().outputDir, 'http://127.0.0.1:1');
  if (process.env.LYCANSYNC_OVERLAY_TEST_DEV_URL) env.LYCANSYNC_DEV_RENDERER_URL = process.env.LYCANSYNC_OVERLAY_TEST_DEV_URL;
  const application = await electron.launch({ args: [resolve('tests/desktop/fixtures/voiceOverlayApp.cjs'),
    '--user-data-dir=' + test.info().outputPath('profile')], env });
  const messages: string[] = [];
  try {
    await expect.poll(() => application.evaluate(() => Boolean(global.voiceOverlayTest))).toBe(true);
    const windowPromise = application.waitForEvent('window');
    await application.evaluate((_electron, payload) => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.configure(owner, payload.settings);
      manager.update(owner, payload.snapshot);
    }, { settings, snapshot });
    const overlay = await windowPromise;
    overlay.on('console', (message) => { if (message.type() === 'error') messages.push(message.text().slice(0, 500)); });
    overlay.on('pageerror', (error) => messages.push(error.message.slice(0, 500)));
    overlay.on('requestfailed', (request) => messages.push(`${request.url()} ${request.failure()?.errorText}`));
    await expect(overlay.getByText('测试成员', { exact: true })).toBeVisible();
    await expect(overlay.locator('.member')).toHaveClass(/speaking/);
    const state = await application.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.fromId(global.voiceOverlayTest.mainId)!;
      const overlay = BrowserWindow.getAllWindows().find((window) => window !== main)!;
      main.minimize();
      return { parent: overlay.getParentWindow()?.id ?? null, topmost: overlay.isAlwaysOnTop(),
        visible: overlay.isVisible(), focusable: overlay.isFocusable(),
        distinctSession: overlay.webContents.session !== main.webContents.session };
    });
    expect(state).toEqual({ parent: null, topmost: true, visible: true, focusable: false, distinctSession: true });
    expect(await overlay.evaluate(() => ({ desktop: typeof window.lycanDesktop,
      bridge: Object.keys(window.lycanOverlayView ?? {}).sort() }))).toEqual({ desktop: 'undefined', bridge: ['onView', 'ready'] });
    expect(await overlay.evaluate(async () => {
      try { await fetch('lycan://app/api/auth/me'); return false; } catch { return true; }
    })).toBe(true);
    expect(await overlay.evaluate(async () => {
      try { await fetch('https://example.com/'); return false; } catch { return true; }
    })).toBe(true);
    await application.evaluate((_electron, next) => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.configure(owner, next);
      manager.edit(owner, true);
    }, { ...settings, scale: 125 });
    await expect(overlay.getByText('拖动调整位置', { exact: false })).toBeVisible();
    expect(await overlay.locator('.avatar').evaluate((element) => getComputedStyle(element).width)).toBe('40px');
    await overlay.screenshot({ path: test.info().outputPath('overlay-preview.png'), omitBackground: true });
    await application.evaluate((_electron, next) => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.edit(owner, false);
      manager.configure(owner, next);
      manager.update(owner, { sequence: 2, roomId: 'synthetic-room', status: 'connected', members: [
        { identity: 'one', name: '测试成员', microphone: false, listening: true, speaking: false },
      ] });
    }, { ...settings, mode: 'speaking' as const });
    await expect(overlay.locator('.member')).toHaveCount(0);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.id !== global.voiceOverlayTest.mainId)!.isVisible())).toBe(false);
    await application.evaluate(() => global.voiceOverlayTest.manager.clear());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await application.evaluate(() => global.voiceOverlayTest.failures)).toEqual([]);
  } catch (error) {
    await test.info().attach('overlay-errors', { body: messages.slice(-30).join('\n'), contentType: 'text/plain' });
    console.error(messages.slice(-30).join('\n'));
    console.error(await application.evaluate(({ BrowserWindow }) => ({ failures: global.voiceOverlayTest.failures,
      windows: BrowserWindow.getAllWindows().map((window) => ({ id: window.id, url: window.webContents.getURL() })) })));
    throw error;
  } finally { await application.close(); }
});

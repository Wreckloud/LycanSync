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
      edit(owner: string, enabled: boolean, preview?: boolean): void;
      clear(): void;
    };
  };
}

const settings: VoiceOverlaySettings = { enabled: true, mode: 'all', scale: 100,
  displayId: null, x: 1, y: 0.5 };
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
    await application.evaluate((_electron, payload) => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.configure(owner, payload.settings);
      manager.update(owner, payload.snapshot);
    }, { settings, snapshot });
    await expect.poll(() => application.windows().some(window => window.url().startsWith('lycan://overlay/'))).toBe(true);
    const overlay = application.windows().find(window => window.url().startsWith('lycan://overlay/'))!;
    overlay.on('console', (message) => { if (message.type() === 'error') messages.push(message.text().slice(0, 500)); });
    overlay.on('pageerror', (error) => messages.push(error.message.slice(0, 500)));
    overlay.on('requestfailed', (request) => messages.push(`${request.url()} ${request.failure()?.errorText}`));
    await expect(overlay.getByText('测试成员', { exact: true })).toBeVisible();
    await expect(overlay.locator('.member')).toHaveClass(/speaking/);
    const rightAligned = await overlay.locator('.member').evaluate((element) => {
      const avatar = element.querySelector('.avatar')!.getBoundingClientRect();
      const name = element.querySelector('.name')!.getBoundingClientRect();
      return { background: getComputedStyle(element).backgroundColor, avatarAfterName: avatar.left >= name.right };
    });
    expect(rightAligned).toEqual({ background: 'rgba(0, 0, 0, 0)', avatarAfterName: true });
    await overlay.screenshot({ path: test.info().outputPath('overlay-right.png'), omitBackground: true });
    await application.evaluate((_electron, next) => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.configure(owner, next);
    }, { ...settings, x: 0 });
    await expect(overlay.locator('.voice-overlay')).not.toHaveClass(/align-right/);
    expect(await overlay.locator('.member').evaluate((element) => element.querySelector('.avatar')!.getBoundingClientRect().right
      <= element.querySelector('.name')!.getBoundingClientRect().left)).toBe(true);
    await overlay.screenshot({ path: test.info().outputPath('overlay-left.png'), omitBackground: true });
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
    await expect(overlay.locator('.voice-overlay')).toHaveClass(/editing/);
    expect(await overlay.locator('.avatar').evaluate((element) => getComputedStyle(element).width)).toBe('40px');
    await overlay.screenshot({ path: test.info().outputPath('overlay-preview.png'), omitBackground: true });
    const previous = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.id !== global.voiceOverlayTest.mainId)!.getBounds());
    await application.evaluate(() => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.edit(owner, true, true);
    });
    await expect(overlay.locator('.member')).toHaveCount(4);
    for (const name of ['狼', 'wolf', '非常个性的昵称用户']) await expect(overlay.getByText(name, { exact: true })).toBeVisible();
    const geometry = await overlay.locator('.member').first().evaluate(element => {
      const avatar = element.querySelector('.avatar')!;
      const name = element.querySelector('.name')!;
      return { avatarHeight: avatar.getBoundingClientRect().height, nameHeight: name.getBoundingClientRect().height,
        border: getComputedStyle(avatar).borderWidth, font: getComputedStyle(name).fontSize,
        rowHeight: element.getBoundingClientRect().height, defaultAvatar: !!element.querySelector('.avatar svg'),
        frame: getComputedStyle(element.closest('.voice-overlay')!).borderWidth };
    });
    expect(geometry).toEqual({ avatarHeight: 40, nameHeight: 40, border: '0px', font: '40px', rowHeight: 45, defaultAvatar: true, frame: '0px' });
    await overlay.screenshot({ path: test.info().outputPath('overlay-test-members.png'), omitBackground: true });
    await application.evaluate(() => {
      const { manager, owner } = global.voiceOverlayTest;
      manager.edit(owner, false);
    });
    await expect(overlay.locator('.member')).toHaveCount(1);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.id !== global.voiceOverlayTest.mainId)!.getBounds())).toEqual(previous);

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

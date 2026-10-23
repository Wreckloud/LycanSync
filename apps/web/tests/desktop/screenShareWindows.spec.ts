import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { VideoQuality } from 'livekit-client';

interface WindowScenario {
  screenShareWindowsScenario: {
    open(id: string): Promise<void>;
    sample(id: string): { connected: string; viewers: number; attached: number; enabled: boolean; quality: VideoQuality;
      sourceState: string; mainPreviewPaused: boolean; childVisibility: string; played: number; sameSource: boolean;
      muted: boolean; audioElements: number; errors: string[]; inputEvents: Array<{ kind: string; key: string }> };
    pixel(id: string): number[] | null;
    activateInput(id: string): void;
    stop(): void;
  };
}

test('同源安全辅助窗复用合成轨道、独立可见性、输入释放和停止清理', async ({}, testInfo) => {
  test.setTimeout(45_000);
  const directory = testInfo.outputPath('viewer-profile');
  mkdirSync(directory, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const application: ElectronApplication = await electron.launch({
    args: [resolve('tests/desktop/fixtures/screenShareWindowsApp.cjs'), directory], env,
  });
  let page: Page | undefined;
  try {
    page = await application.firstWindow();
    await page.waitForFunction(() => Boolean((window as unknown as WindowScenario).screenShareWindowsScenario));
    const sample = (id = 'red') => page!.evaluate((id) => (window as unknown as WindowScenario).screenShareWindowsScenario.sample(id), id);
    await page.getByRole('button', { name: '打开红色' }).click();
    await expect.poll(async () => ({ windows: application.windows().length, errors: (await sample()).errors }), { timeout: 5000 })
      .toEqual({ windows: 2, errors: [] });
    const red = application.windows().find((window) => window !== page)!;
    await expect.poll(sample).toMatchObject({ viewers: 1, attached: 2, sameSource: true, enabled: true,
      quality: VideoQuality.HIGH, muted: true, audioElements: 0, connected: 'disconnected', errors: [] });
    await expect.poll(() => page!.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario.pixel('red'))).toEqual([208, 32, 48, 255]);
    await page.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario.open('red'));
    expect(application.windows()).toHaveLength(2);
    await red.waitForLoadState();
    expect(await red.evaluate(() => ({ secure: isSecureContext, node: typeof (window as unknown as { require?: unknown }).require,
      deviceBridge: typeof window.lycanDesktop, openerBridge: typeof window.opener.lycanDesktop, opener: Boolean(window.opener),
      windowBridge: Object.keys(window.lycanViewerWindow!).sort(),
    }))).toEqual({ secure: true, node: 'undefined', deviceBridge: 'undefined', openerBridge: 'object', opener: true,
      windowBridge: ['exitFullscreen', 'onDisarm', 'onState', 'ready', 'setPinned', 'toggleFullscreen'] });
    const pinResult = await red.evaluate(async () => {
      try { return { state: await window.lycanViewerWindow!.setPinned(true) }; }
      catch (error) { return { error: String(error) }; }
    });
    const pinned = await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { isAlwaysOnTop(): boolean }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.isAlwaysOnTop());
    if (pinResult.error) {
      expect(pinResult.error).toContain('系统未能确认窗口置顶');
      expect(pinned).toBe(false);
      testInfo.annotations.push({ type: '系统能力待验收', description: '本次系统未确认置顶；验证失败明确返回，不冒充置顶成功。' });
    } else {
      expect(pinResult.state).toMatchObject({ pinned: true });
      expect(pinned).toBe(true);
    }
    await red.evaluate(async () => window.lycanViewerWindow!.setPinned(false));
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { isAlwaysOnTop(): boolean }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.isAlwaysOnTop())).toBe(false);
    await red.evaluate(async () => window.lycanViewerWindow!.toggleFullscreen());
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { isFullScreen(): boolean }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.isFullScreen())).toBe(true);
    await red.evaluate(async () => window.lycanViewerWindow!.exitFullscreen());
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { isFullScreen(): boolean }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.isFullScreen())).toBe(false);
    const processes = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map((window) => window.webContents.getOSProcessId()));
    expect(new Set(processes).size).toBe(1);
    expect(await page.evaluate(() => window.open('https://example.invalid/', 'untrusted') === null)).toBe(true);
    expect(await red.evaluate(() => window.open('/viewer.html', 'nested') === null)).toBe(true);
    await page.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario.open('green'));
    await expect.poll(() => application.windows().length).toBe(3);
    await expect.poll(() => sample('green')).toMatchObject({ viewers: 2, attached: 2, sameSource: true, errors: [] });
    await expect.poll(() => page!.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario.pixel('green'))).toEqual([32, 176, 96, 255]);
    const before = await sample();
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: { main: { hide(): void } } }).screenShareWindowsTest.main.hide());
    await expect.poll(sample).toMatchObject({ mainPreviewPaused: true, childVisibility: 'visible', enabled: true, quality: VideoQuality.HIGH });
    await expect.poll(async () => (await sample()).played, { timeout: 8000 }).toBeGreaterThan(before.played);
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { minimize(): void }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.minimize());
    await expect.poll(async () => (await sample()).enabled).toBe(false);
    expect((await sample('green')).enabled).toBe(true);
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: {
      children: Map<string, { restore(): void }>;
    } }).screenShareWindowsTest.children.get('viewer-red')!.restore());
    await expect.poll(async () => (await sample()).enabled).toBe(true);
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: { main: { show(): void } } }).screenShareWindowsTest.main.show());
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: { main: { minimize(): void } } }).screenShareWindowsTest.main.minimize());
    await expect.poll(sample).toMatchObject({ mainPreviewPaused: true, enabled: true, quality: VideoQuality.HIGH });
    await application.evaluate(() => (globalThis as unknown as { screenShareWindowsTest: { main: { restore(): void } } }).screenShareWindowsTest.main.restore());
    await red.bringToFront();
    await page.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario.activateInput('red'));
    await red.keyboard.down('a');
    await expect.poll(async () => (await sample()).inputEvents).toContainEqual({ kind: 'keyDown', key: 'letterA' });
    // 自动化桌面不能保证取得系统前台，受控派发本窗口失焦，不冒充真实 OS 输入验收。
    await red.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(async () => (await sample()).inputEvents).toContainEqual({ kind: 'keyUp', key: 'letterA' });
    await red.close();
    await page.bringToFront();
    await expect.poll(sample).toMatchObject({ viewers: 1, attached: 1, sourceState: 'live', quality: VideoQuality.LOW });
    const cancelledBeforeBinding = await page.evaluate(async () => {
      const scenario = (window as unknown as WindowScenario).screenShareWindowsScenario;
      await scenario.open('red');
      const pending = scenario.sample('red').attached === 1;
      scenario.stop();
      return pending;
    });
    expect(cancelledBeforeBinding).toBe(true);
    await expect.poll(() => sample('green')).toMatchObject({ viewers: 0, attached: 0, sourceState: 'ended', enabled: false, errors: [] });
    await expect.poll(async () => application.windows().length).toBe(1);
    expect(await application.evaluate(() => {
      return (globalThis as unknown as { screenShareWindowsTest: { permissionRequests: string[] } }).screenShareWindowsTest.permissionRequests;
    })).toEqual([]);
  } finally {
    try { if (page && !page.isClosed()) await page.evaluate(() => (window as unknown as WindowScenario).screenShareWindowsScenario?.stop()); }
    finally { await application.close(); }
  }
});

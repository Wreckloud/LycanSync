import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    overlaySettingsTest: { calls: string[]; rejectNext(): void; setActive(value: boolean): void;
      unmount(): void; saved(): { enabled: boolean; mode: string; scale: number } | null };
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/tests/fixtures/overlaySettings.html');
});

test('覆盖设置：默认关闭、模式与缩放保存，切栏及卸载结束编辑', async ({ page }) => {
  const enable = page.getByRole('checkbox', { name: /^开启屏幕覆盖/ });
  await expect(enable).not.toBeChecked();
  await enable.check();
  const modes = page.getByRole('group', { name: '成员显示' });
  const speaking = modes.getByRole('button', { name: '只显示正在说话的人' });
  await speaking.click();
  await expect(speaking).toBeDisabled();
  await expect(speaking).toHaveCSS('opacity', '1');
  await expect(speaking).toHaveAttribute('aria-pressed', 'true');
  await speaking.press('ArrowLeft');
  await expect(modes.getByRole('button', { name: '显示全部通话成员' })).toHaveAttribute('aria-pressed', 'true');
  await modes.getByRole('button', { name: '显示全部通话成员' }).press('ArrowRight');
  await expect(speaking).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('slider', { name: '覆盖整体大小', exact: true }).focus();
  await page.getByRole('slider', { name: '覆盖整体大小', exact: true }).press('End');
  await expect.poll(() => page.evaluate(() => window.overlaySettingsTest.saved())).toMatchObject({ enabled: true, mode: 'speaking', scale: 150 });
  await page.getByRole('button', { name: '编辑位置', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成编辑', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('overlay-settings-wide.png') });
  await page.setViewportSize({ width: 600, height: 820 });
  const bounds = await modes.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
  await page.screenshot({ path: test.info().outputPath('overlay-settings.png') });
  await page.evaluate(() => window.overlaySettingsTest.setActive(false));
  await expect(page.getByRole('button', { name: '编辑位置', exact: true })).toBeVisible();
  await page.evaluate(() => window.overlaySettingsTest.setActive(true));
  await page.getByRole('button', { name: '编辑位置', exact: true }).click();
  await page.evaluate(() => window.overlaySettingsTest.unmount());
  await expect.poll(() => page.evaluate(() => window.overlaySettingsTest.calls.at(-1))).toBe('edit:false');
});

test('系统拒绝设置时开关与滑块保留原状态，不显示假成功', async ({ page }) => {
  const enable = page.getByRole('checkbox', { name: /^开启屏幕覆盖/ });
  await expect(enable).toBeEnabled();
  await page.evaluate(() => window.overlaySettingsTest.rejectNext());
  await enable.click();
  await expect(enable).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('未能应用');
  await enable.check();
  await expect(enable).toBeEnabled();
  await page.evaluate(() => window.overlaySettingsTest.rejectNext());
  await page.getByRole('button', { name: '只显示正在说话的人' }).click();
  await expect(page.getByRole('button', { name: '只显示正在说话的人' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '显示全部通话成员' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toContainText('未能应用');
});

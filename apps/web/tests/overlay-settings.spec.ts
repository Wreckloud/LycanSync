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
  await page.getByRole('radio', { name: '只显示正在说话的人' }).check();
  await page.getByLabel('覆盖整体大小').focus();
  await page.getByLabel('覆盖整体大小').press('End');
  await expect.poll(() => page.evaluate(() => window.overlaySettingsTest.saved())).toMatchObject({ enabled: true, mode: 'speaking', scale: 150 });
  await page.getByRole('button', { name: '编辑位置', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成编辑', exact: true })).toBeVisible();
  await page.evaluate(() => window.overlaySettingsTest.setActive(false));
  await expect(page.getByRole('button', { name: '编辑位置', exact: true })).toBeVisible();
  await page.evaluate(() => window.overlaySettingsTest.setActive(true));
  await page.getByRole('button', { name: '编辑位置', exact: true }).click();
  await page.evaluate(() => window.overlaySettingsTest.unmount());
  await expect.poll(() => page.evaluate(() => window.overlaySettingsTest.calls.at(-1))).toBe('edit:false');
});

test('系统拒绝设置时开关与单选框回退，不显示假成功', async ({ page }) => {
  const enable = page.getByRole('checkbox', { name: /^开启屏幕覆盖/ });
  await expect(enable).toBeEnabled();
  await page.evaluate(() => window.overlaySettingsTest.rejectNext());
  await enable.click();
  await expect(enable).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('未能应用');
  await enable.check();
  await page.evaluate(() => window.overlaySettingsTest.rejectNext());
  await page.getByRole('radio', { name: '只显示正在说话的人' }).click();
  await expect(page.getByRole('radio', { name: '显示全部通话成员' })).toBeChecked();
});

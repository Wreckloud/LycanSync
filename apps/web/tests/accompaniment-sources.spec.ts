import { expect, test } from '@playwright/test';

for (const width of [540, 1440]) {
  test(`伴奏菜单在 ${width}px 下能展开空列表并选择自定义音源`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/controls-preview.html#accompaniment');
    await page.getByText('模拟场景', { exact: true }).click();
    for (const name of ['QQ 音乐', 'Google Chrome', 'VLC']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    const start = page.getByRole('button', { name: '播放伴奏', exact: true });
    const more = page.getByRole('button', { name: '更多音源', exact: true });
    await start.focus();
    await start.click();
    await more.click();
    await expect(page.getByText('没有其他可选应用。', { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(start).toBeFocused();
    await page.getByRole('checkbox', { name: '本地播放器' }).check();
    await start.focus();
    await start.click();
    await more.click();
    await page.getByRole('button', { name: '本地播放器' }).click();
    await expect(page.getByRole('button', { name: '暂停分享' })).toBeVisible();
  });
}

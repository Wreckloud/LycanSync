import { expect, test } from '@playwright/test';

test('识别修正使用原生深色选择器，重置只清空选择，动效与减少动态设置一致', async ({ page }, testInfo) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/rtc/voice-time', route => route.fulfill({ json: { seconds: 7200 } }));
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import ActivitySettings from '/src/components/settings/ActivitySettings.vue';
import '/src/styles.css';
import '/src/settings/settings.css';
const entries = ref([{ executable: 'game.exe', name: '固定游戏名' }]);
const mappings = { entries, windows: ref([{ executable: 'game.exe', title: '游戏窗口' }, { executable: 'music.exe', title: '音乐窗口' }]),
  busy: ref(false), loading: ref(false), ready: ref(true), error: ref(''), windowError: ref(''),
  refreshWindows: async () => {}, initialize: async () => {},
  save: async (executable, name) => { entries.value = [{ executable, name }]; return true; },
  remove: async executable => { entries.value = entries.value.filter(entry => entry.executable !== executable); return true; } };
createApp({ render: () => h('main', { style: 'padding:32px;max-width:1000px;margin:auto' }, [h(ActivitySettings, {
  user: { id: 'test', nickname: '测试成员', avatar: '', signature: '', administrator: false },
  desktop: true, active: true, activity: { type: 'GAME', name: '最终幻想14' },
  showActivity: true, showLastOnline: true, error: '', mappings,
})]) }).mount('#root');
` });
  });
  await page.goto('/');
  const current = page.locator('.activity-current');
  await expect(current).toHaveText('最终幻想14');
  await expect(current.locator('svg, span')).toHaveCount(0);
  const select = page.getByLabel('识别修正', { exact: true });
  const reset = page.getByRole('button', { name: '重置', exact: true });
  await expect(reset).toBeDisabled();
  const alignment = await page.locator('.activity-settings-controls').evaluate(element => {
    const toggle = element.querySelector('.activity-toggle strong')!;
    const label = element.querySelector('.activity-mappings > label')!;
    return { toggleX: toggle.getBoundingClientRect().x, labelX: label.getBoundingClientRect().x,
      toggleFont: getComputedStyle(toggle).fontSize, labelFont: getComputedStyle(label).fontSize };
  });
  expect(alignment.toggleX).toBe(alignment.labelX);
  expect(alignment.toggleFont).toBe(alignment.labelFont);
  await expect(select).toHaveCSS('appearance', 'base-select');
  expect(await select.evaluate(element => getComputedStyle(element, '::picker(select)').transitionDuration)).toContain('0.12s');
  await select.click();
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await expect.poll(() => select.evaluate(element => getComputedStyle(element, '::picker(select)').opacity)).toBe('1');
  await page.screenshot({ path: testInfo.outputPath('activity-settings-picker.png') });
  await page.keyboard.press('Escape');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(false);
  await select.selectOption('game.exe');
  const name = page.getByRole('textbox', { name: '动态显示名称', exact: true });
  await expect(name).toHaveValue('固定游戏名');
  await expect(name).toHaveCSS('background-color', await select.evaluate(element => getComputedStyle(element).backgroundColor));
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(select).toHaveValue('');
  await expect(reset).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '动态显示名称', exact: true })).toHaveCount(0);
  await expect(page.locator('.activity-saved-names')).toContainText('固定游戏名');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => select.evaluate(element => getComputedStyle(element, '::picker(select)').transitionDuration)).toBe('0s');
  await select.focus(); await page.keyboard.press('Space');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(select).not.toHaveValue('');
  await page.setViewportSize({ width: 420, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('activity-settings-narrow.png') });
});

import { expect, test } from '@playwright/test';

test('识别修正紧凑排列，弹窗编辑不移动背景，支持取消、失败重试与窄窗操作', async ({ page }, testInfo) => {
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
const showActivity = ref(true);
const presenceMode = ref('online');
const mappings = { entries, windows: ref([{ executable: 'game.exe', title: '游戏窗口' }, { executable: 'music.exe', title: '音乐窗口' }]),
  busy: ref(false), loading: ref(false), ready: ref(true), error: ref(''), windowError: ref(''),
  refreshWindows: async () => {}, initialize: async () => {},
  save: async (executable, name) => {
    mappings.error.value = '';
    if (name === '保存失败') { mappings.error.value = '动态名称未能应用，请重试。'; return false; }
    entries.value = [{ executable, name }]; return true;
  },
  remove: async executable => { entries.value = entries.value.filter(entry => entry.executable !== executable); return true; } };
createApp({ render: () => h('main', { style: 'padding:32px;max-width:1000px;margin:auto' }, [h(ActivitySettings, {
  user: { id: 'test', nickname: '测试成员', avatar: '', signature: '旧签名'.repeat(40), administrator: false },
  desktop: true, active: true, activity: { type: 'GAME', name: '最终幻想14' },
  presenceMode: presenceMode.value, presenceReady: true, status: presenceMode.value === 'invisible' ? 'OFFLINE' : 'ONLINE',
  onPresenceMode: value => { presenceMode.value = value; },
  showActivity: showActivity.value, onVisibility: value => { showActivity.value = value; }, showLastOnline: true, error: '', mappings,
})]) }).mount('#root');
` });
  });
  await page.goto('/');
  const current = page.locator('.activity-current');
  await expect(current).toHaveText('当前识别：最终幻想14');
  await expect(current.locator('svg, span')).toHaveCount(0);
  const select = page.getByLabel('运行中的程序', { exact: true });
  const reset = page.getByRole('button', { name: '重置', exact: true });
  const edit = page.getByRole('button', { name: '修改名称', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改动态名称' });
  await expect(page.locator('.activity-name-editor')).toHaveCount(0);
  await expect(edit).toBeDisabled();
  await expect(reset).toBeDisabled();
  const presence = page.getByRole('button', { name: '切换在线状态', exact: true });
  await expect(presence).toContainText('在线');
  await expect(page.locator('.activity-profile-preview')).toContainText('累计已与朋友开黑了 2 小时');
  const card = page.getByRole('region', { name: '资料卡预览', exact: true });
  await expect(card.locator('.profile-popover-signature p')).toHaveCSS('height', '36px');
  await expect(card.locator('.profile-popover-signature p')).toHaveAttribute('title', '旧签名'.repeat(40));
  await expect.poll(() => card.evaluate(element => element.getAnimations().length)).toBe(0);
  const before = (await card.boundingBox())!;
  const mappingsBefore = (await page.locator('.activity-mappings').boundingBox())!;
  const sampleFrames = () => card.evaluate(async element => {
    const frames = [];
    for (let index = 0; index < 36; index++) {
      await new Promise(requestAnimationFrame);
      const bounds = element.getBoundingClientRect();
      frames.push({ height: bounds.height, centerY: bounds.y + bounds.height / 2, centerX: bounds.x + bounds.width / 2 });
    }
    return frames;
  });
  const triggerBounds = (await presence.boundingBox())!;
  await page.mouse.move(triggerBounds.x + 30, triggerBounds.y + 16);
  await page.mouse.down();
  const presenceMenu = page.getByRole('menu', { name: '在线状态', exact: true });
  await expect(presenceMenu).toContainText('向朋友显示在线或闲置');
  await expect(presenceMenu).toContainText('仍可聊天、语音和共享');
  const invisibleBounds = (await presenceMenu.getByRole('menuitemradio', { name: '隐身', exact: true }).boundingBox())!;
  await page.mouse.move(triggerBounds.x + 30, invisibleBounds.y + 16);
  await expect(presence).toContainText('在线');
  const framesPromise = sampleFrames();
  await page.mouse.up();
  await expect(presence).toContainText('隐身');
  await expect(page.locator('.activity-profile-preview')).not.toContainText('正在玩');
  const frames = await framesPromise;
  const after = (await card.boundingBox())!;
  expect(after.height).toBeLessThan(before.height);
  const centerY = before.y + before.height / 2;
  const centerX = before.x + before.width / 2;
  expect(after.y + after.height / 2).toBeCloseTo(centerY, 1);
  expect(after.y).toBeGreaterThan(before.y);
  expect(frames.some(frame => frame.height > after.height + 1 && frame.height < before.height - 1)).toBe(true);
  for (const frame of frames) {
    expect(frame.centerY).toBeCloseTo(centerY, 1);
    expect(frame.centerX).toBeCloseTo(centerX, 1);
  }
  expect((await page.locator('.activity-mappings').boundingBox())!.y).toBe(mappingsBefore.y);
  await presence.click();
  await presenceMenu.getByRole('menuitemradio', { name: '在线', exact: true }).click();
  await expect(page.locator('.activity-profile-preview')).toContainText('正在玩');
  await expect.poll(() => card.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(before.height, 0);
  expect((await page.locator('.activity-mappings').boundingBox())!.y).toBe(mappingsBefore.y);
  const alignment = await page.locator('.activity-settings').evaluate(element => {
    const preview = element.querySelector('.activity-profile-preview')!.getBoundingClientRect();
    const controls = element.querySelector('.activity-settings-controls')!.getBoundingClientRect();
    const mappings = element.querySelector('.activity-mappings')!.getBoundingClientRect();
    return { previewX: preview.x, controlsRight: controls.right, mappingsX: mappings.x, mappingsRight: mappings.right,
      mappingsY: mappings.y, upperBottom: Math.max(preview.bottom, controls.bottom) };
  });
  expect(alignment.mappingsX).toBe(alignment.previewX);
  expect(alignment.mappingsRight).toBe(alignment.controlsRight);
  expect(alignment.mappingsY).toBeGreaterThan(alignment.upperBottom);
  await expect(select).toHaveCSS('appearance', 'base-select');
  expect(await select.evaluate(element => getComputedStyle(element, '::picker(select)').transitionDuration)).toContain('0.12s');
  await select.click();
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await expect.poll(() => select.evaluate(element => getComputedStyle(element, '::picker(select)').opacity)).toBe('1');
  await page.screenshot({ path: testInfo.outputPath('activity-settings-picker.png') });
  await page.keyboard.press('Escape');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(false);
  const layout = () => page.locator('.activity-settings').evaluate(element =>
    ['.activity-profile-preview', '.activity-settings-controls', '.activity-mappings', '.activity-saved-names']
      .map(selector => { const { x, y, width, height } = element.querySelector(selector)!.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height }; }));
  const beforeSelection = await layout();
  await select.selectOption('game.exe');
  await expect(dialog).toHaveCount(0);
  expect(await layout()).toEqual(beforeSelection);
  await edit.click();
  const name = page.getByRole('textbox', { name: '动态显示名称', exact: true });
  await expect(name).toHaveValue('固定游戏名');
  await expect(name).toBeFocused();
  expect(await page.locator('#root').evaluate(element => element instanceof HTMLElement && element.inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '保存名称' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(name).toBeFocused();
  await name.fill('未保存的名字');
  await page.screenshot({ path: testInfo.outputPath('activity-name-dialog.png'), animations: 'disabled' });
  expect(await layout()).toEqual(beforeSelection);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(select).toHaveValue('game.exe');
  await expect(page.locator('.activity-saved-names')).toContainText('固定游戏名');
  await edit.click();
  await expect(name).toHaveValue('固定游戏名');
  await name.fill('保存失败');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog).toContainText('动态名称未能应用，请重试。');
  await expect(page.locator('#activity-mapping-feedback')).toHaveCount(0);
  await name.fill('新的游戏名');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.activity-saved-names')).toContainText('新的游戏名');
  await reset.click();
  await expect(select).toHaveValue('');
  expect(await layout()).toEqual(beforeSelection);
  await expect(page.locator('.activity-saved-names')).toContainText('新的游戏名');
  await page.getByRole('button', { name: '编辑动态名称 新的游戏名' }).click();
  await expect(name).toHaveValue('新的游戏名');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('checkbox', { name: '显示动态', exact: true }).uncheck();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '显示动态', exact: true })).not.toBeChecked();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => select.evaluate(element => getComputedStyle(element, '::picker(select)').transitionDuration)).toBe('0s');
  await select.focus(); await page.keyboard.press('Space');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(select).not.toHaveValue('');
  await page.setViewportSize({ width: 420, height: 760 });
  const narrowExpanded = await layout();
  await reset.click();
  expect(await layout()).toEqual(narrowExpanded);
  await select.selectOption('music.exe');
  expect(await layout()).toEqual(narrowExpanded);
  await edit.click();
  await expect(name).toHaveValue('音乐窗口');
  expect(await layout()).toEqual(narrowExpanded);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(420);
  await page.screenshot({ path: testInfo.outputPath('activity-name-dialog-narrow.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('activity-settings-narrow.png') });
});

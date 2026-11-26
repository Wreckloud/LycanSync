import { expect, test } from '@playwright/test';

test('识别修正紧凑排列，弹窗编辑不移动背景，支持取消、失败重试与窄窗操作', async ({ page }, testInfo) => {
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/rtc/voice-time', route => route.fulfill({ json: { seconds: 7200 } }));
  const game = 'c:\\apps\\game.exe', music = 'c:\\apps\\music.exe', offline = 'c:\\apps\\old.exe';
  const sent: { status: string; activity: { type: string; name: string } | null }[] = [];
  await page.route('**/api/presence/heartbeat', async route => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import ActivitySettings from '/src/components/settings/ActivitySettings.vue';
import '/src/styles.css';
import '/src/settings/settings.css';
import { useActivityMappings } from '/src/settings/useActivityMappings.ts';
import { useOwnPresence } from '/src/presence/useOwnPresence.ts';
const game = ${JSON.stringify(game)}, music = ${JSON.stringify(music)}, offline = ${JSON.stringify(offline)};
localStorage.setItem('lycansync.activity-mappings.v1.test', JSON.stringify([
  { executable: game, name: '固定游戏名' }, { executable: offline, name: '旧程序名' }]));
createApp({ setup() {
  const showActivity = ref(true), showLastOnline = ref(true);
  const auto = { type: 'GAME', name: '最终幻想14', startedAt: new Date().toISOString() };
  let selected, notify;
  const bridge = {
    getServerSettings: async () => ({ apiUrl: location.origin }),
    getSystemIdleState: async () => ({ state: 'active', idleSeconds: 0 }),
    getCurrentActivity: async () => auto,
    onActivityChange: cb => { notify = cb; return () => {}; },
    listActivityWindows: async () => [{ executable: game, title: '游戏窗口' }, { executable: music, title: '音乐窗口' }],
    configureActivityMappings: async (entries, target) => {
      if (entries.some(e => e.name === '保存失败')) throw new Error('测试写入失败');
      if (target !== undefined) selected = target;
      notify(selected ? { ...auto, selectedExecutable: selected, type: selected === music ? 'MUSIC' : 'GAME',
        name: entries.find(e => e.executable === selected)?.name ?? (selected === music ? '歌曲名' : '游戏原名') } : auto);
    }
  };
  const own = useOwnPresence('test', { showActivity, showLastOnline }, bridge);
  const mappings = useActivityMappings('test', bridge, localStorage, () => own.currentActivity.value?.selectedExecutable);
  return () => h('main', { style: 'padding:32px;max-width:1000px;margin:auto' }, [h(ActivitySettings, {
    user: { id: 'test', nickname: '测试成员', avatar: '', signature: '旧签名'.repeat(40), administrator: false },
    desktop: true, active: true, activity: own.currentActivity.value, presenceMode: own.presenceMode.value,
    presenceReady: own.presenceReady.value, status: own.publicPresenceStatus.value, onPresenceMode: own.changePresenceMode,
    showActivity: showActivity.value, onVisibility: value => { showActivity.value = value; },
    showLastOnline: true, error: '', mappings,
  })]);
} }).mount('#root');
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
  const presence = page.getByRole('group', { name: '在线状态', exact: true });
  await expect(presence.getByRole('button', { name: '在线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.activity-profile-preview')).toContainText('累计已与朋友开黑了 2 小时');
  const card = page.getByRole('region', { name: '资料卡预览', exact: true });
  await expect(card.locator('.profile-popover-signature p')).toHaveCSS('height', '36px');
  await expect(card.locator('.profile-popover-signature p')).toHaveAttribute('title', '旧签名'.repeat(40));
  // 语音时长返回后，ResizeObserver 会在下一帧更新外框，先等初始尺寸真正落定。
  await expect.poll(() => card.evaluate(element => Math.abs(element.getBoundingClientRect().height
    - Math.min(element.querySelector('.profile-popover-content')!.getBoundingClientRect().height + 2,
      element.parentElement!.clientHeight)))).toBeLessThan(1);
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
  await expect(page.locator('#activity-presence-description')).toContainText('离开电脑后自动显示闲置');
  await page.screenshot({ path: testInfo.outputPath('account-presence-online.png'), animations: 'disabled' });
  await expect(presence.locator('small')).toHaveCount(0);
  const framesPromise = sampleFrames();
  await presence.getByRole('button', { name: '隐身', exact: true }).click();
  await expect(presence.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#activity-presence-description')).toContainText('向朋友显示离线');
  await expect(page.locator('.activity-profile-preview')).not.toContainText('正在玩');
  const frames = await framesPromise;
  await page.screenshot({ path: testInfo.outputPath('account-presence-invisible.png'), animations: 'disabled' });
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
  await presence.getByRole('button', { name: '在线', exact: true }).click();
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
    ['.activity-profile-preview', '.activity-settings-controls', '.activity-mappings']
      .map(selector => { const { x, y, width, height } = element.querySelector(selector)!.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height }; }));
  const beforeSelection = await layout();
  await select.selectOption(game);
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
  await expect(select).toHaveValue(game);
  await expect(current).toContainText('固定游戏名');
  await edit.click();
  await expect(name).toHaveValue('固定游戏名');
  await name.fill('保存失败');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog).toContainText('动态名称未能应用，请重试。');
  await expect(page.locator('#activity-mapping-feedback')).toHaveCount(0);
  await name.fill('新的游戏名');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(current).toContainText('新的游戏名');
  await expect.poll(() => sent.at(-1)?.activity).toEqual({ type: 'GAME', name: '新的游戏名' });
  await edit.click();
  await expect(name).toHaveValue('新的游戏名');
  await dialog.getByRole('button', { name: '移除自定义名称' }).click();
  await expect(current).toContainText('游戏原名');
  await expect(select).toHaveValue(game);
  await select.selectOption(offline);
  await expect(reset).toBeDisabled();
  await expect(current).toContainText('游戏原名');
  await edit.click();
  await expect(name).toHaveValue('旧程序名');
  await dialog.getByRole('button', { name: '移除自定义名称' }).click();
  await expect(select).toHaveValue(game);
  await expect(select.locator('option', { hasText: '旧程序名' })).toHaveCount(0);
  await edit.click();
  await name.fill('再改一次');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await reset.click();
  await expect(select).toHaveValue('');
  await expect(current).toContainText('最终幻想14');
  await expect.poll(() => sent.at(-1)?.activity).toEqual({ type: 'GAME', name: '最终幻想14' });
  expect(await layout()).toEqual(beforeSelection);
  await select.selectOption(game);
  await edit.click();
  await expect(name).toHaveValue('游戏原名');
  await expect(dialog.getByRole('button', { name: '移除自定义名称' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await reset.click();
  await page.getByRole('checkbox', { name: '显示动态', exact: true }).uncheck();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '显示动态', exact: true })).not.toBeChecked();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => select.evaluate(element => getComputedStyle(element, '::picker(select)').transitionDuration)).toBe('0s');
  await select.focus(); await page.keyboard.press('Space');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).not.toHaveValue('');
  await page.setViewportSize({ width: 420, height: 760 });
  const narrowExpanded = await layout();
  await reset.click();
  expect(await layout()).toEqual(narrowExpanded);
  await select.selectOption(music);
  expect(await layout()).toEqual(narrowExpanded);
  await edit.click();
  await expect(name).toHaveValue('歌曲名');
  await name.fill('音乐别名');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await edit.click();
  await expect(dialog.getByRole('button', { name: '移除自定义名称' })).toBeVisible();
  expect(await layout()).toEqual(narrowExpanded);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(420);
  await page.screenshot({ path: testInfo.outputPath('activity-name-dialog-narrow.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('activity-settings-narrow.png') });
});

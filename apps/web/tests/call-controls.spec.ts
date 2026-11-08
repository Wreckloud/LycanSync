import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 挂载正式菜单，只有设置与媒体边界使用测试状态，不连接设备或服务。
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, reactive } from ${JSON.stringify(vuePath)};
import CallControls from '/src/components/CallControls.vue';
import '/src/styles.css';
createApp({ setup() {
  const state = reactive({ voiceMode:'voice', pushToTalkBinding:'F2', processingEnabled:true, sharing:true });
  return () => h('div', { class:'callbar', style:'position:fixed;bottom:20px;right:20px' }, [h(CallControls, {
    connected:true, desktop:true, microphoneEnabled:true, microphoneIntent:true, microphoneBusy:false,
    microphoneLevel:0.3, inputLevelPercent:30, listening:true, inputGain:1, outputVolume:1,
    shareBusy:false, choosingSource:false, shareLimitReached:false, quality:'standard', shareAudio:true, audioMode:'process',
    recordingActive:true, recordingElapsed:'03:24', replayActive:true,
    shortcutsSupported:true, shortcutsReady:true, ...state,
    onVoiceMode:mode => {state.voiceMode=mode;}, onProcessing:enabled => {state.processingEnabled=enabled;},
    onShare:() => {state.sharing=!state.sharing;}
  })]);
}}).mount('#root');` });
  });
  await page.goto('/');
});

test('麦克风快捷切换更新勾选，声音处理是一个开关且切换不改变菜单高度', async ({ page }, testInfo) => {
  const opener = page.getByRole('button', { name: '麦克风选项', exact: true });
  await opener.click();
  const menu = page.getByRole('region', { name: '麦克风选项', exact: true });
  const before = (await menu.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(0);
  expect(before.y).toBeGreaterThanOrEqual(0);
  await menu.getByRole('button', { name: '按键说话 F2' }).click();
  await expect(menu.getByRole('button', { name: '按键说话 F2' })).toHaveAttribute('aria-pressed', 'true');
  const processing = menu.getByRole('checkbox', { name: '智能声音处理' });
  await expect(processing).toBeChecked();
  await processing.uncheck();
  await expect(processing).not.toBeChecked();
  expect((await menu.boundingBox())!.height).toBe(before.height);
  await expect(menu).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('microphone-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();
});

test('共享菜单收起低频入口，窄窗口子菜单返回并恢复焦点，停止共享后隐藏画质', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 420, height: 720 });
  const opener = page.getByRole('button', { name: '共享选项', exact: true });
  await opener.click();
  const menu = page.getByRole('region', { name: '共享选项', exact: true });
  await expect(menu.getByRole('button', { name: '停止录制 · 03:24' })).toBeVisible();
  await expect(page.getByRole('button', { name: '录制设置', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: '语音设置' })).toHaveCount(0);
  await menu.getByRole('button', { name: '录制与回放' }).click();
  const submenu = page.getByRole('region', { name: '录制与回放' });
  await expect(submenu.getByRole('button', { name: '保存回放' })).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(submenu).toBeInViewport();
  await expect(submenu).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('recording-submenu.png') });
  await page.keyboard.press('Escape');
  await expect(menu.getByRole('button', { name: '录制与回放' })).toBeFocused();
  await menu.getByRole('button', { name: '停止共享', exact: true }).click();
  await opener.click();
  await expect(menu.getByRole('button', { name: '开始共享', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '共享画质' })).toHaveCount(0);
});

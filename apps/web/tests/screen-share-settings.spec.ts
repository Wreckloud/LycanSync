import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    shareSettingsTest: { active: boolean; sharedAudio: boolean; rejectChange: boolean; capability: string;
      rtc: { screenShareActive: boolean; currentScreenShareAudioMode: string; notice: string } };
  }
}

test.beforeEach(async ({ page }) => {
  // 仅挂载设置组件与模拟的共享状态，不创建采集、音频或网络会话。
  await page.route('**/api/**', route => route.abort());
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, reactive } from ${JSON.stringify(vuePath)};
import ScreenShareSettings from '/src/components/settings/ScreenShareSettings.vue';
import { readScreenShareQuality, saveScreenShareQuality } from '/src/rtc/screenShareQuality.ts';
import '/src/styles.css';
import '/src/settings/settings.css';
createApp({ setup() {
  const state = reactive({ active:true, sharedAudio:true, rejectChange:false, capability:'windowsApplicationLoopbackProcessTree',
    ...readScreenShareQuality(), rtc:{ screenShareActive:false, screenShareQualityBusy:false, screenShareSourceBusy:false,
      busySources:[], currentScreenShareAudioMode:'process', screenShareAudioRestricted:false, notice:'' } });
  window.shareSettingsTest = state;
  window.lycanDesktop = { getNativeMediaCapabilities: async () => {
    if (state.capability === 'error') throw new Error('capabilitiesUnavailable');
    return { screenShareAudioCapture:{ available:true, reason:state.capability } };
  } };
  return () => h('main', { style:'padding:24px;max-width:868px;margin:auto' }, [h(ScreenShareSettings, {
    active:state.active, rtc:state.rtc, sharedAudio:state.sharedAudio, quality:state.quality, customQuality:state.customQuality,
    changeQuality:async (quality, custom) => {
      if (state.rejectChange) return false;
      saveScreenShareQuality(quality, custom); state.quality=quality; state.customQuality=custom; return true;
    },
    changeAudio:async enabled => { if (state.rejectChange) return false; state.sharedAudio=enabled; return true; }
  })]);
}}).mount('#root');` });
  });
  await page.goto('/');
});

test('共享默认画质、自定义参数与光标保存后恢复', async ({ page }, testInfo) => {
  const presets = page.getByRole('group', { name: '共享画质' });
  await expect(presets.getByRole('button', { name: '标准', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await presets.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('分辨率上限').selectOption('1440');
  await page.getByLabel('目标帧率').selectOption('120');
  await page.getByRole('button', { name: '码率设置' }).click();
  await page.getByLabel('主画面码率上限').fill('25');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  const cursor = page.getByRole('checkbox', { name: /隐藏共享画面中的光标/ });
  await cursor.check();
  await page.reload();
  await expect(presets.getByRole('button', { name: '自定义', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('分辨率上限')).toHaveValue('1440');
  await expect(page.getByLabel('目标帧率')).toHaveValue('120');
  await expect(page.getByRole('button', { name: '码率设置' })).toContainText('25 Mbps');
  await expect(cursor).toBeChecked();
  await page.setViewportSize({ width: 800, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
  await page.screenshot({ path: testInfo.outputPath('share-settings.png') });
});

test('共享中切换失败保持实际状态，重试可恢复，重复点击当前画质不报错', async ({ page }) => {
  await page.evaluate(() => { window.shareSettingsTest.rtc.screenShareActive = true; window.shareSettingsTest.rejectChange = true; });
  const standard = page.getByRole('button', { name: '标准', exact: true });
  const economy = page.getByRole('button', { name: '节省流量', exact: true });
  await standard.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await economy.click();
  await expect(standard).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toContainText('保留原画质');
  const audio = page.getByRole('checkbox', { name: '共享声音', exact: true });
  await audio.click();
  await expect(audio).toBeChecked();
  await expect(page.getByText('共享声音未能切换，请重试。')).toBeVisible();
  await page.evaluate(() => { window.shareSettingsTest.rejectChange = false; });
  await economy.click();
  await expect(economy).toHaveAttribute('aria-pressed', 'true');
  await audio.uncheck();
  await expect(audio).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('应用声音偏好不会扩展为全部电脑声音，读取失败明确提示', async ({ page }) => {
  const audio = page.getByRole('checkbox', { name: '共享声音', exact: true });
  await expect(audio).toBeChecked();
  await audio.uncheck();
  await audio.check();
  await page.evaluate(() => { window.shareSettingsTest.active = false; });
  await page.evaluate(() => { window.shareSettingsTest.capability = 'windowsSystemMixLoopback'; window.shareSettingsTest.active = true; });
  await expect(audio).not.toBeChecked();
  await expect(page.getByText('包含全部电脑声音，可能产生回声。')).toBeVisible();
  await audio.check();
  expect(await page.evaluate(() => localStorage.getItem('lycansync.screen-share-audio.systemMix'))).toBe('true');
  await page.evaluate(() => { window.shareSettingsTest.active = false; });
  await page.evaluate(() => { window.shareSettingsTest.capability = 'error'; window.shareSettingsTest.active = true; });
  await expect(audio).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('无法读取共享声音设置');
  await expect(page.getByText('当前系统不支持共享声音。')).toHaveCount(0);
});

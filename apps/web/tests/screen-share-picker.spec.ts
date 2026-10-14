import { test, expect } from '@playwright/test';

test.setTimeout(15_000);

test.beforeEach(async ({ page }) => {
  // 只挂载生产选择器，来源为受控数据，不连接房间或访问采集设备。
  await page.route('**/src/main.ts*', async (route) => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import ScreenSharePicker from '/src/components/ScreenSharePicker.vue';
import '/src/styles.css';
createApp({ components: { ScreenSharePicker }, setup() {
  const open = ref(false), quality = ref('standard'), sourceType = ref('window'), shareAudio = ref(true);
  const selectedId = ref(''), error = ref(''), confirmed = ref(false);
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#22374d"/></svg>');
  const sources = [{ id:'window:1:0', name:'测试窗口', type:'window', thumbnail:image },
    { id:'window:1:1', name:'游戏窗口', type:'window', thumbnail:image },
    { id:'window:1:2', name:'长名称窗口的预览区域保持相同大小', type:'window', thumbnail:image },
    { id:'monitor:1:0', name:'屏幕 1', type:'screen', thumbnail:image }];
  window.pickerTest = { fail: () => { error.value = '来源读取失败'; }, recover: () => { error.value = ''; },
    confirmed: () => confirmed.value };
  return () => h('div', [h('button', { onClick: () => { open.value=true; } }, '打开选择器'),
    h('button', '背景按钮'), open.value ? h(ScreenSharePicker, {
      sources, sourceType:sourceType.value, quality:quality.value, shareAudio:shareAudio.value,
      selectedId:selectedId.value, audioMode:'process', audioReady:true, audioFailed:false, loading:false,
      error:error.value, notice:'', 'onUpdate:sourceType': value => {sourceType.value=value;},
      'onUpdate:quality': value => {quality.value=value;}, 'onUpdate:shareAudio': value => {shareAudio.value=value;},
      onChoose:value => {selectedId.value=value;}, onClose:() => {open.value=false;},
      onConfirm:() => {confirmed.value=true;open.value=false;}
    }) : null]);
}}).mount('#root');
` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开选择器' }).click();
});

test('四种画质切换、整屏预览、失败阻止确认和恢复', async ({ page }, testInfo) => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('picker-wide.png') });
  await expect(page.getByRole('tablist', { name: '共享画质' }).getByRole('tab')).toHaveCount(4);
  await page.getByRole('tab', { name: '高帧率', exact: true }).click();
  await expect(dialog).toContainText('1080p · 120 FPS');
  await page.getByRole('tab', { name: '整个屏幕', exact: true }).click();
  const screen = page.getByRole('button', { name: '屏幕 1', exact: true });
  await expect(screen.locator('img')).toBeVisible();
  await screen.click();
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { pickerTest: { fail(): void } }).pickerTest.fail());
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { pickerTest: { recover(): void } }).pickerTest.recover());
  await page.getByRole('button', { name: '开始共享', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pickerTest: { confirmed(): boolean } }).pickerTest.confirmed())).toBe(true);
});

test('左下取消、Esc、焦点隔离与窄窗口布局', async ({ page }, testInfo) => {
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: '取消', exact: true });
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('checkbox', { name: '共享音频', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tab', { name: '应用窗口', exact: true })).toBeFocused();
  expect(await page.locator('#root').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.setViewportSize({ width: 420, height: 720 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('picker-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开选择器' })).toBeFocused();
  expect(await page.locator('#root').evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await page.getByRole('button', { name: '打开选择器' }).click();
  await close.click();
  await expect(dialog).toHaveCount(0);
});

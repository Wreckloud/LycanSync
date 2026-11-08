import { expect, test } from '@playwright/test';

test('内容缓存按账号清理，取消与 Esc 不删除，清理后继续缓存且全部清理不退出登录', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, h, ref } from ${JSON.stringify(vuePath)};
import CacheSettings from '/src/components/settings/CacheSettings.vue';
import { createAccountCache, getLocalContentCacheUsage } from '/src/cache/localCache.ts';
import '/src/styles.css';
import '/src/settings/settings.css';
const mine=createAccountCache('current'), other=createAccountCache('other');
mine.allowGroups(['group']);other.allowGroups(['group']);
await mine.write('messages','group',['current']);await other.write('members','group',['other']);
window.cacheSettingsReview={usage:getLocalContentCacheUsage,write:()=>mine.write('messages','group',['new'])};
createApp({setup(){const settings=ref(null);return()=>h('main',{style:'padding:32px',inert:settings.value?.confirming},[h(CacheSettings,{ref:settings,userId:'current',active:true}),h('p','当前登录账号：测试成员')]);}}).mount('#root');
` });
  });
  await page.goto('/');
  const usage = (user?: string) => page.evaluate(async user => {
    const testApi = (window as unknown as { cacheSettingsReview: {
      usage(user?: string): Promise<{ bytes: number; entries: number }>;
    } }).cacheSettingsReview;
    return testApi.usage(user);
  }, user);
  await expect(page.getByRole('heading', { name: '本地缓存', exact: true })).toBeVisible();
  const clearButton = page.getByRole('button', { name: '清理缓存', exact: true }).first();
  await clearButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect((await usage()).entries).toBe(2);
  await clearButton.click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await usage()).entries).toBe(2);
  await clearButton.click();
  await dialog.getByRole('button', { name: '清理缓存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await usage('current')).entries).toBe(0);
  expect((await usage('other')).entries).toBe(1);
  await page.evaluate(() => (window as unknown as { cacheSettingsReview: { write(): Promise<void> } }).cacheSettingsReview.write());
  expect((await usage('current')).entries).toBe(1);
  await page.getByLabel('缓存清理范围').selectOption('all');
  await clearButton.click();
  await expect(dialog).toContainText('本机其他账号与服务器');
  await dialog.getByRole('button', { name: '清理缓存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await usage()).entries).toBe(0);
  await expect(page.getByText('当前登录账号：测试成员')).toBeVisible();
});

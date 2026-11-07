import { expect, test } from '@playwright/test';

test('反馈无空白占位，快速完成不闪字，长等待延迟出现，错误立即完整展示', async ({ page }) => {
  await page.route('**/src/main.ts*', async route => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    if (!vuePath) throw new Error('未找到 Vite Vue 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { createApp, ref, h } from ${JSON.stringify(vuePath)};
import InlineFeedback from '/src/components/InlineFeedback.vue';
import '/src/styles.css';
import '/src/settings/settings.css';
const pending = ref(''), message = ref('');
createApp({ render: () => h('main', { style: 'padding:24px;max-width:650px;margin:auto' }, [
  h('div', { class: 'settings-actions' }, [
    h('button', { onClick: () => { message.value = ''; pending.value = '正在保存…'; } }, '开始等待'),
    h('button', { onClick: () => { pending.value = ''; message.value = ''; } }, '结束等待'),
    h('button', { onClick: () => { pending.value = '正在读取…'; } }, '换个操作'),
    h('button', { onClick: () => { message.value = '保存失败，请检查服务器连接后重试。'.repeat(8); } }, '模拟失败'),
  ]),
  h('footer', { class: 'card-actions', style: 'margin-top:24px' }, [
    h('button', { type: 'button' }, '取消'),
    h(InlineFeedback, { class: 'card-feedback', message: message.value, pending: pending.value }),
    h('button', { type: 'button', class: 'confirm-button card-actions-end' }, '保存'),
  ]),
]) }).mount('#root');
` });
  });
  await page.goto('/');
  const cancel = page.getByRole('button', { name: '取消', exact: true });
  const save = page.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeVisible();
  await page.clock.install();
  const before = await save.boundingBox();
  expect((await cancel.boundingBox())!.y).toBe(before!.y);
  await expect(page.locator('.inline-feedback')).toHaveCount(0);
  await page.getByRole('button', { name: '开始等待' }).click();
  await page.clock.runFor(500);
  await page.getByRole('button', { name: '结束等待' }).click();
  await page.clock.runFor(1000);
  await expect(page.locator('.inline-feedback')).toHaveCount(0);
  expect(await save.boundingBox()).toEqual(before);
  await page.getByRole('button', { name: '开始等待' }).click();
  await page.clock.runFor(900);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByRole('button', { name: '换个操作' }).click();
  await page.clock.runFor(900);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(page.getByRole('status')).toHaveText('正在读取…');
  await page.getByRole('button', { name: '模拟失败' }).click();
  await expect(page.getByRole('alert')).toContainText('保存失败');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const error = page.getByRole('alert');
  const rect = (await error.boundingBox())!;
  expect(rect.height).toBeGreaterThan(32);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
  expect((await cancel.boundingBox())!.y).toBeGreaterThanOrEqual(rect.y + rect.height);
  expect((await cancel.boundingBox())!.y).toBe((await save.boundingBox())!.y);
  await page.getByRole('button', { name: '结束等待' }).click();
  await expect(page.locator('.inline-feedback')).toHaveCount(0);
  expect((await cancel.boundingBox())!.y).toBe((await save.boundingBox())!.y);
});

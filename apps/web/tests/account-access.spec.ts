import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 未提供模拟的业务请求明确失败，不能落到 Vite 的真实服务器代理。
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
});

test('邀请模式不展示测试密码注册入口', async ({ page }) => {
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: false } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.goto('/');
  await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
});

test('仅服主显示邀请面板且生成链接只在成功后展示', async ({ page }) => {
  const user = { id: 'admin', nickname: '服主', avatar: '', signature: '', administrator: true };
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/access/members?offset=0', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/access/links*', (route) => route.fulfill({ json: route.request().method() === 'POST'
    ? { record: { id: 'new-link' }, url: `https://example.com/join#token=${'a'.repeat(43)}` } : [] }));
  await page.goto('/');
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '邀请与成员', exact: true }).click();
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(page.getByLabel('生成的链接')).toHaveValue(`https://example.com/join#token=${'a'.repeat(43)}`);
  await expect(page.getByRole('button', { name: '恢复成员登录', exact: true })).toBeDisabled();
});

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 未提供模拟的业务请求明确失败，不能落到 Vite 的真实服务器代理。
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
});

test('邀请模式不展示测试密码注册入口', async ({ page }) => {
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false, initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.goto('/');
  await expect(page.getByText('使用服主分享的邀请链接即可加入。', { exact: false })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
});

test('仅服主显示邀请面板且生成链接只在成功后展示', async ({ page }) => {
  let recoveryConfigured = false;
  let qqBound = false;
  let bindingFailed = false;
  const user = { id: 'admin', nickname: '服主', avatar: '', signature: '', administrator: true };
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/access/members?offset=0', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/server-settings', (route) => route.fulfill({ json: {
    serverName: '测试服务器', publicUrlConfigured: true, qqEnabled: false, mediaConfigured: true,
  } }));
  await page.route('**/api/auth/account', (route) => route.fulfill({ json: {
    administrator: true, recoveryConfigured, ownedGroups: [], candidates: [], incomingTransfer: null, transferTargetId: null,
  } }));
  await page.route('**/api/auth/qq/binding', route => route.fulfill(bindingFailed
    ? { status: 503, json: { detail: '无法读取 QQ 绑定状态' } }
    : { json: { bound: qqBound, nickname: qqBound ? '测试 QQ' : '' } }));
  await page.route('**/api/auth/access/links*', (route) => route.fulfill({ json: route.request().method() === 'POST'
    ? { record: { id: 'new-link' }, url: `https://example.com/join#token=${'a'.repeat(43)}` } : [] }));
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await expect(page.getByText('测试服务器', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置恢复密码', exact: true })).toBeVisible();
  const recommendation = page.locator('.recovery-warning');
  await expect(recommendation).toContainText('安全建议：请设置服主恢复密码');
  expect(await recommendation.evaluate(element => getComputedStyle(element).color)).toBe(
    await recommendation.evaluate(element => {
      const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; element.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    }));
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(page.getByLabel('生成的链接')).toHaveValue(`https://example.com/join#token=${'a'.repeat(43)}`);
  await expect(page.getByRole('button', { name: '恢复成员登录', exact: true })).toBeDisabled();
  for (const [password, bound] of [[false, true], [true, false], [true, true], [false, false]]) {
    recoveryConfigured = password;
    qqBound = bound;
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
    const accountResponse = page.waitForResponse('**/api/auth/account');
    const bindingResponse = password ? null : page.waitForResponse('**/api/auth/qq/binding');
    await page.getByRole('button', { name: '服主管理', exact: true }).click();
    await accountResponse;
    if (bindingResponse) await bindingResponse;
    await expect(recommendation).toHaveCount(password || bound ? 0 : 1);
  }
  bindingFailed = true;
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await expect(page.getByText('无法读取 QQ 绑定状态', { exact: true })).toBeVisible();
  await expect(recommendation).toHaveCount(0);
  bindingFailed = false;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(recommendation).toHaveCount(1);
});

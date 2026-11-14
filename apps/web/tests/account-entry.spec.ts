import { expect, test, type Page } from '@playwright/test';

async function entry(page: Page, administrator = true, recoveryConfigured = false, bound = false, qqAvailable = false) {
  const calls: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', initialized: true, qqAvailable } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'entry-owner', nickname: '测试账号', avatar: '', administrator } }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: { administrator, recoveryConfigured } }));
  await page.route('**/api/auth/qq/binding', route => route.fulfill({ json: { bound } }));
  await page.route('**/api/auth/logout', route => { calls.push('logout'); return route.fulfill({ status: 204 }); });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'lycanDesktop', { value: {
      getAutoLogin: async () => ({ enabled: true, manualEntryRequired: true }),
      setAutoLogin: async () => {},
      clearSession: async () => { sessionStorage.setItem('test-cleared', 'true'); },
      getAccessLink: async () => null, onAccessLink: () => () => {},
      getUpdateState: async () => ({ phase: 'ready', supported: false }),
      runStartupUpdate: async () => ({ phase: 'ready', supported: false }),
      onUpdateState: () => () => {}, onClose: () => () => {}, onMaximizedChange: () => () => {},
      isMaximized: async () => false,
      getServerSettings: async () => ({ apiUrl: 'https://test.invalid', editable: true }),
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  return calls;
}

async function confirmClear(page: Page) {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '清除本机登录凭据', exact: true }).click();
  return page.getByRole('dialog', { name: '从此设备移除账号？', exact: true });
}

test('登录操作集中底部，清除按钮位于更多末尾并占满一行', async ({ page }, testInfo) => {
  await entry(page);
  const card = page.locator('.auth-card');
  const preview = (await page.locator('.account-preview').boundingBox())!;
  const actions = (await page.locator('.account-entry-actions').boundingBox())!;
  expect(actions.y).toBeGreaterThan(preview.y + preview.height);
  await card.screenshot({ path: testInfo.outputPath('entry-compact.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  const clear = page.getByRole('button', { name: '清除本机登录凭据', exact: true });
  await expect(clear).toBeVisible();
  await expect(clear).toHaveCSS('background-color', 'rgb(26, 32, 39)');
  await expect(clear).toHaveCSS('min-height', '32px');
  const content = page.locator('.auth-more-content');
  expect(await content.evaluate(element => element.lastElementChild?.textContent)).toBe('清除本机登录凭据');
  expect((await clear.boundingBox())!.width).toBeCloseTo((await content.boundingBox())!.width, 0);
  await card.screenshot({ path: testInfo.outputPath('entry-expanded.png'), animations: 'disabled' });
  for (const width of [420, 360]) {
    await page.setViewportSize({ width, height: 780 });
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(clear).toBeInViewport();
  }
  await card.screenshot({ path: testInfo.outputPath('entry-narrow.png') });
});

test('服主补齐密码后继续清除，取消与保存失败都保留原账号', async ({ page }, testInfo) => {
  const calls = await entry(page);
  let reject = true;
  await page.route('**/api/auth/account/recovery-password', route => {
    calls.push('password');
    expect(route.request().postDataJSON()).toEqual({ password: 'test12' });
    return reject ? route.fulfill({ status: 503, json: { detail: '暂时无法保存恢复密码' } }) : route.fulfill({ status: 204 });
  });
  const confirmation = await confirmClear(page);
  await expect(confirmation).not.toContainText('结束通话');
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  const password = page.getByRole('dialog', { name: '设置恢复密码', exact: true });
  await expect(password).toContainText('请先设置恢复密码，以便清除后重新登录。');
  await password.getByLabel('新恢复密码（至少 6 位）', { exact: true }).fill('cancelled');
  await page.keyboard.press('Escape');
  await expect(password).toHaveCount(0);
  expect(calls).toEqual([]);
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  await expect(password.getByLabel('新恢复密码（至少 6 位）', { exact: true })).toHaveValue('');
  await password.getByLabel('新恢复密码（至少 6 位）', { exact: true }).fill('test12');
  await password.getByLabel('确认恢复密码', { exact: true }).fill('test12');
  await password.getByRole('button', { name: '保存并清除登录信息', exact: true }).click();
  await expect(password).toContainText('暂时无法保存恢复密码');
  expect(calls).toEqual(['password']);
  expect(await page.evaluate(() => sessionStorage.getItem('test-cleared'))).toBeNull();
  await password.screenshot({ path: testInfo.outputPath('entry-recovery-password.png') });
  reject = false;
  await password.getByRole('button', { name: '保存并清除登录信息', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toEqual(['password', 'password', 'logout']);
  expect(await page.evaluate(() => sessionStorage.getItem('test-cleared'))).toBe('true');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0);
});

for (const scenario of [
  { name: '服主已有恢复密码', administrator: true, recovery: true, bound: false, available: false, needsPassword: false },
  { name: '服主已绑定可用 QQ', administrator: true, recovery: false, bound: true, available: true, needsPassword: false },
  { name: '绑定 QQ 但服务器已关闭登录', administrator: true, recovery: false, bound: true, available: false, needsPassword: true },
  { name: '普通成员使用恢复链接', administrator: false, recovery: false, bound: false, available: false, needsPassword: false },
]) test(scenario.name, async ({ page }) => {
  const calls = await entry(page, scenario.administrator, scenario.recovery, scenario.bound, scenario.available);
  const confirmation = await confirmClear(page);
  if (!scenario.administrator) await expect(confirmation).toContainText('服主提供的恢复链接或已绑定的登录方式');
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  if (scenario.needsPassword) {
    await expect(page.getByRole('dialog', { name: '设置恢复密码', exact: true })).toBeVisible();
    expect(calls).toEqual([]);
  } else {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(calls).toEqual(['logout']);
  }
});

test('恢复方式检查失败可重试，不提前撤销会话或清除本机信息', async ({ page }) => {
  const calls = await entry(page, true, true);
  await page.route('**/api/auth/account', route => route.fulfill({ status: 503, json: { detail: '账号状态暂时无法读取' } }));
  const confirmation = await confirmClear(page);
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  await expect(confirmation).toContainText('账号状态暂时无法读取');
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('test-cleared'))).toBeNull();
  await page.unroute('**/api/auth/account');
  await page.route('**/api/auth/account', route => route.fulfill({ json: { administrator: true, recoveryConfigured: true } }));
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(calls).toEqual(['logout']);
});

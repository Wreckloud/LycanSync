import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 未提供模拟的业务请求明确失败，不能落到 Vite 的真实服务器代理。
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/auth/server-settings/qq', route => route.fulfill({ json: {
    enabled: false, appId: '', callbackUrl: '', appKeyConfigured: false, configurationError: '',
  } }));
});

test('邀请模式不展示测试密码注册入口', async ({ page }) => {
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false, initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.goto('/');
  await expect(page.getByText('使用服主分享的邀请链接即可加入。', { exact: false })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
});

test('账号绑定只在 QQ 可用时展示，读取失败可重试且不保留旧绑定状态', async ({ page }) => {
  const user = { id: 'member', nickname: '成员', avatar: '', signature: '', administrator: false };
  let available = false;
  let bound = false;
  let bindingFailed = false;
  let optionsFailed = false;
  let bindingReads = 0;
  await page.route('**/api/auth/options', route => route.fulfill(optionsFailed
    ? { status: 503, json: { detail: '无法读取登录方式' } }
    : { json: { mode: 'invite', qqAvailable: available, initialized: true } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: user }));
  await page.route('**/api/groups', route => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: {
    administrator: false, recoveryConfigured: false, ownedGroups: [], candidates: [], incomingTransfer: null, transferTargetId: null,
  } }));
  await page.route('**/api/auth/qq/binding', route => {
    bindingReads++;
    return route.fulfill(bindingFailed ? { status: 503, json: { detail: '无法读取 QQ 绑定状态' } }
      : { json: { bound, nickname: bound ? '朋友' : '' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const account = page.locator('.account-settings');
  await expect(account.getByText('绑定第三方账号', { exact: true })).toHaveCount(0);
  await expect(account.getByText(/未开启 QQ|查看 QQ 绑定说明/)).toHaveCount(0);
  expect(bindingReads).toBe(0);

  async function reopen() {
    await page.getByRole('button', { name: '快捷键', exact: true }).click();
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
  }
  available = true;
  await reopen();
  await expect(account.getByRole('button', { name: '绑定 QQ', exact: true })).toBeEnabled();
  bound = true;
  await reopen();
  await expect(account.getByText('已绑定 QQ · 朋友', { exact: true })).toBeVisible();
  await expect(account.getByRole('button', { name: '绑定 QQ', exact: true })).toHaveCount(0);

  bindingFailed = true;
  await reopen();
  await expect(account.getByText('无法读取 QQ 绑定状态', { exact: true })).toBeVisible();
  await expect(account.getByText('已绑定 QQ · 朋友', { exact: true })).toHaveCount(0);
  await expect(account.getByRole('button', { name: '绑定 QQ', exact: true })).toBeDisabled();
  bindingFailed = false;
  await account.getByRole('button', { name: '重试', exact: true }).click();
  await expect(account.getByText('已绑定 QQ · 朋友', { exact: true })).toBeVisible();

  optionsFailed = true;
  await reopen();
  await expect(account.getByText('无法读取登录方式', { exact: true })).toBeVisible();
  await expect(account.getByText('绑定第三方账号', { exact: true })).toHaveCount(0);
  optionsFailed = false;
  available = false;
  const readsBeforeRetry = bindingReads;
  await account.getByRole('button', { name: '重试', exact: true }).click();
  await expect(account.getByText('无法读取登录方式', { exact: true })).toHaveCount(0);
  await expect(account.getByText('绑定第三方账号', { exact: true })).toHaveCount(0);
  expect(bindingReads).toBe(readsBeforeRetry);
});

test('仅服主显示邀请面板且生成链接只在成功后展示', async ({ page }, testInfo) => {
  let configurationReads = 0;
  let recoveryConfigured = false;
  let qqBound = false;
  let bindingFailed = false;
  const user = { id: 'admin', nickname: '服主', avatar: '', signature: '', administrator: true };
  await page.route('**/api/auth/server-settings/qq', route => route.fulfill({ json: {
    enabled: true, appId: '', callbackUrl: '', appKeyConfigured: false, configurationError: '请检查 App ID、App Key 和回调地址',
  } }));
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/access/members?offset=0', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/server-settings', (route) => { configurationReads++; return route.fulfill({ json: {
    serverName: '测试服务器', publicUrlConfigured: true, qqEnabled: false, mediaConfigured: true,
  } }); });
  await page.route('**/api/auth/account', (route) => route.fulfill({ json: {
    administrator: true, recoveryConfigured, ownedGroups: [], candidates: [], incomingTransfer: null, transferTargetId: null,
  } }));
  await page.route('**/api/auth/qq/binding', route => route.fulfill(bindingFailed
    ? { status: 503, json: { detail: '无法读取 QQ 绑定状态' } }
    : { json: { bound: qqBound, nickname: qqBound ? '测试 QQ' : '' } }));
  const invitation = { id: 'new-link', kind: 'INVITE', note: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), consumedAt: null, revokedAt: null };
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
  await page.route('**/api/auth/access/links**', route => route.fulfill({ json: route.request().url().includes('?')
    ? [invitation] : { record: invitation, url: `https://example.com/join#token=${'a'.repeat(43)}` } }));
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await expect(page.getByText('测试服务器', { exact: true })).toBeVisible();
  expect(configurationReads).toBe(1);
  const invite = await page.getByRole('button', { name: '邀请新朋友', exact: true }).boundingBox();
  const recovery = await page.getByRole('button', { name: '恢复成员登录', exact: true }).boundingBox();
  const links = await page.getByRole('button', { name: '链接管理', exact: true }).boundingBox();
  expect(invite!.y).toBe(recovery!.y);
  expect(Math.abs(invite!.width - recovery!.width)).toBeLessThan(1);
  expect(links!.width).toBeGreaterThan(invite!.width * 2);
  const passwordButton = await page.getByRole('button', { name: '设置恢复密码', exact: true }).boundingBox();
  const transferButton = await page.getByRole('button', { name: '转让服主', exact: true }).boundingBox();
  expect(passwordButton!.width).toBe(transferButton!.width);
  await expect(page.getByRole('button', { name: /刷新/ })).toHaveCount(0);
  await page.locator('.owner-settings').screenshot({ path: testInfo.outputPath('owner-settings.png') });
  await expect(page.getByText('QQ 登录 · 配置未完成', { exact: true })).toBeVisible();
  await expect(page.getByText('请检查 App ID、App Key 和回调地址', { exact: true })).toBeVisible();
  let qqConfiguration = { enabled: false, appId: '', callbackUrl: '', appKeyConfigured: false };
  const qqWrites: unknown[] = [];
  let rejectQqSave = true;
  await page.route('**/api/auth/server-settings/qq', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      qqWrites.push(body);
      if (rejectQqSave) return route.fulfill({ status: 503, json: { detail: '配置暂时无法保存' } });
      qqConfiguration = { enabled: body.enabled, appId: body.appId, callbackUrl: body.callbackUrl, appKeyConfigured: true };
    }
    return route.fulfill({ json: qqConfiguration });
  });
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await page.getByLabel('允许 QQ 登录', { exact: true }).check();
  await page.getByLabel('App ID', { exact: true }).fill('1234567');
  await page.getByLabel('App Key', { exact: true }).fill('test-private-key');
  await page.getByLabel('回调地址', { exact: true }).fill('https://example.com/api/auth/qq/callback');
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).screenshot({ path: testInfo.outputPath('qq-settings.png') });
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('配置暂时无法保存', { exact: true })).toBeVisible();
  rejectQqSave = false;
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('QQ 登录 · 已开启', { exact: true })).toBeVisible();
  expect(qqWrites).toHaveLength(2);
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await expect(page.getByLabel('App Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('App Key', { exact: true })).toHaveAttribute('placeholder', '已设置，留空保留原密钥');
  await page.getByLabel('允许 QQ 登录', { exact: true }).uncheck();
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('QQ 登录 · 未开启', { exact: true })).toBeVisible();
  expect(qqWrites[2]).toMatchObject({ enabled: false, appKey: '' });
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await page.getByLabel('App Key', { exact: true }).fill('discard-this-secret');
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await expect(page.getByLabel('App Key', { exact: true })).toHaveValue('');
  await page.getByRole('dialog', { name: '配置 QQ 登录', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '设置恢复密码', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('新恢复密码（至少 6 位）', { exact: true })).toHaveCount(0);
  const recommendation = page.locator('.recovery-warning');
  await expect(recommendation).toContainText('设置恢复密码，方便在登录信息丢失时找回服主账号。');
  expect(await recommendation.evaluate(element => getComputedStyle(element).color)).toBe(
    await recommendation.evaluate(element => {
      const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; element.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    }));
  let passwordRequests = 0;
  let rejectPassword = true;
  await page.route('**/api/auth/account/recovery-password', async route => {
    passwordRequests++;
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toEqual({ previousPassword: '', password: 'test-recovery-password' });
    if (rejectPassword) await route.fulfill({ status: 503, json: { detail: '暂时无法保存恢复密码' } });
    else { recoveryConfigured = true; await route.fulfill({ status: 204 }); }
  });
  const openPassword = page.getByRole('button', { name: '设置恢复密码', exact: true });
  await openPassword.click();
  const dialog = page.getByRole('dialog');
  const newPassword = dialog.getByLabel('新恢复密码（至少 6 位）', { exact: true });
  await expect(newPassword).toBeFocused();
  await newPassword.fill('test-recovery-password');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(openPassword).toBeFocused();
  await openPassword.click();
  await expect(newPassword).toHaveValue('');
  await newPassword.fill('test-recovery-password');
  await dialog.getByLabel('确认恢复密码', { exact: true }).fill('different-test-password');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText('两次输入的恢复密码不一致。', { exact: true })).toBeVisible();
  expect(passwordRequests).toBe(0);
  await dialog.getByLabel('确认恢复密码', { exact: true }).fill('test-recovery-password');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('暂时无法保存恢复密码', { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('暂时无法保存恢复密码', { exact: true })).toBeVisible();
  rejectPassword = false;
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const editPassword = page.getByRole('button', { name: '修改恢复密码', exact: true });
  await expect(editPassword).toBeVisible();
  await editPassword.click();
  await expect(dialog.getByLabel('原恢复密码', { exact: true })).toBeFocused();
  await expect(newPassword).toHaveValue('');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editPassword).toBeFocused();
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toBeEnabled();
  await expect(page.getByText('请先完成服主转让，再注销账号。', { exact: true })).toBeVisible();
  await page.locator('.settings-view').screenshot({ path: testInfo.outputPath('account-actions.png'), animations: 'disabled' });
  await expect(page.getByRole('button', { name: '修改恢复密码', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await expect.poll(() => configurationReads).toBe(2);
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('已复制链接', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.access-record')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复成员登录', exact: true })).toBeEnabled();
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

test('成员访问弹窗独立处理备注、全服搜索、复制与链接管理', async ({ page }, testInfo) => {
  const user = { id: 'admin', nickname: '服主', avatar: '', signature: '', administrator: true };
  const member = { id: 'member-b', nickname: '朋友乙', avatar: '', signature: '', administrator: false };
  const records: { id: string; kind: string; targetId: string | null; note: string; createdAt: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null; resultUserId: string | null; lastFailure: string | null }[] = [];
  const memberQueries: string[] = [];
  let failGeneration = true;
  let failList = false;
  let generationCount = 0;
  let copied = '';
  await page.exposeFunction('copyTestLink', (value: string) => { copied = value; });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text: string) => {
      // 模拟复制按钮禁用后焦点退回页面的浏览器行为。
      (document.activeElement as HTMLElement | null)?.blur();
      await (window as unknown as { copyTestLink: (text: string) => Promise<void> }).copyTestLink(text);
    } },
  }));
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', route => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: user }));
  await page.route('**/api/groups', route => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/server-settings', route => route.fulfill({ json: {
    serverName: '测试服务器', publicUrlConfigured: true, qqEnabled: false, mediaConfigured: true,
  } }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: {
    administrator: true, recoveryConfigured: true, ownedGroups: [], candidates: [], incomingTransfer: null, transferTargetId: null,
  } }));
  await page.route('**/api/auth/access/members?*', route => {
    const search = new URL(route.request().url()).searchParams.get('search') ?? '';
    memberQueries.push(search);
    return route.fulfill({ json: member.nickname.includes(search) || member.id.includes(search) ? [member] : [] });
  });
  await page.route('**/api/auth/access/links**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const current = records.find(record => url.pathname.includes(`/${record.id}`));
    const result = (record: typeof records[number]) => ({ record, url: `https://example.com/join#token=${record.id}` });
    if (request.method() === 'GET') {
      if (url.pathname.endsWith('/url')) return route.fulfill({ json: result(current!) });
      if (failList) return route.fulfill({ status: 503, json: { detail: '暂时无法读取链接' } });
      const status = url.searchParams.get('status');
      const kind = url.searchParams.get('kind');
      return route.fulfill({ json: records.filter(record => (!kind || record.kind === kind) && (status === 'ALL'
        || status === 'USED' && record.consumedAt || status === 'REVOKED' && record.revokedAt
        || status === 'PENDING' && !record.consumedAt && !record.revokedAt)) });
    }
    if (request.method() === 'PUT') {
      current!.note = request.postDataJSON().note.trim(); return route.fulfill({ status: 204 });
    }
    if (request.method() === 'DELETE') {
      current!.revokedAt = new Date().toISOString(); return route.fulfill({ status: 204 });
    }
    if (failGeneration) return route.fulfill({ status: 503, json: { detail: '暂时无法生成链接' } });
    const ensure = url.pathname.endsWith('/invite');
    const pending = records.find(record => record.kind === 'INVITE' && !record.consumedAt && !record.revokedAt);
    if (ensure && pending) return route.fulfill({ json: result(pending) });
    generationCount++;
    if (current) current.revokedAt = new Date().toISOString();
    const payload = current ?? (ensure ? { kind: 'INVITE', targetId: null, note: '' } : request.postDataJSON());
    const record = { ...payload, id: `link-${generationCount}`, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 43_200_000).toISOString(), consumedAt: null, revokedAt: null, resultUserId: null, lastFailure: null };
    records.unshift(record);
    await route.fulfill({ json: result(record) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(dialog.getByText('暂时无法生成链接', { exact: true })).toBeVisible();
  expect(memberQueries).toHaveLength(0);
  failGeneration = false;
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByText('已复制链接', { exact: true })).toBeVisible();
  await expect.poll(() => copied).toBe('https://example.com/join#token=link-1');
  await expect(dialog.getByLabel('备注', { exact: false })).toBeHidden();
  await dialog.getByRole('button', { name: '修改备注', exact: true }).click();
  await dialog.getByLabel('备注', { exact: false }).fill('一起开黑');
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(dialog.getByText('一起开黑', { exact: true })).toBeVisible();
  expect(generationCount).toBe(1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(dialog.getByText('已复制链接', { exact: true })).toBeVisible();
  expect(generationCount).toBe(1);
  await dialog.getByRole('button', { name: '生成新的邀请链接', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(2);
  expect(generationCount).toBe(2);
  await dialog.locator('[data-link-id="link-1"]').getByRole('button', { name: '复制链接', exact: true }).click();
  await expect.poll(() => copied).toBe('https://example.com/join#token=link-1');
  await dialog.screenshot({ path: testInfo.outputPath('invite-link.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '恢复成员登录', exact: true }).click();
  const search = dialog.getByRole('searchbox', { name: '搜索可恢复成员' });
  await search.fill('不存在');
  await expect(dialog.getByText('没有匹配的成员', { exact: true })).toBeVisible();
  await search.fill('member-b');
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认恢复成员登录', exact: true });
  await expect(confirmation.getByLabel('备注', { exact: false })).toHaveValue('朋友乙 的恢复链接');
  expect(generationCount).toBe(2);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(search).toHaveValue('member-b');
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await confirmation.screenshot({ path: testInfo.outputPath('recover-member.png') });
  await confirmation.getByRole('button', { name: '生成恢复链接', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '恢复链接', exact: true }).getByLabel('生成的链接')).toBeVisible();
  expect(records[0]).toMatchObject({ kind: 'RECOVERY', targetId: 'member-b', note: '朋友乙 的恢复链接' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  records.find(record => record.id === 'link-1')!.consumedAt = new Date().toISOString();
  failList = true;
  await page.getByRole('button', { name: '链接管理', exact: true }).click();
  await expect(dialog.getByText('暂时无法读取链接', { exact: true })).toBeVisible();
  failList = false;
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(2);
  expect(generationCount).toBe(3);
  await expect(dialog.getByRole('tab', { name: '待使用', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('.access-record')).toHaveCount(2);
  await dialog.locator('[data-link-id="link-2"]').getByRole('button', { name: '修改备注', exact: true }).click();
  await dialog.locator('[data-link-id="link-2"]').getByLabel('备注', { exact: false }).fill('管理页备注');
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(dialog.getByText('管理页备注', { exact: true })).toBeVisible();
  const newest = dialog.locator('[data-link-id="link-3"]');
  await newest.getByRole('button', { name: '撤销', exact: true }).click();
  await newest.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(1);
  await dialog.getByRole('tab', { name: '已使用', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '复制链接', exact: true })).toHaveCount(0);
  await dialog.getByRole('tab', { name: '已撤销', exact: true }).click();
  await expect(dialog.locator('[data-link-id="link-3"]')).toBeVisible();
  await dialog.getByRole('tab', { name: '全部', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(3);
  await dialog.screenshot({ path: testInfo.outputPath('link-management.png') });
  await page.setViewportSize({ width: 390, height: 740 });
  await dialog.screenshot({ path: testInfo.outputPath('link-management-narrow.png') });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '链接管理', exact: true })).toBeFocused();
});

for (const configured of [true, false]) test(`注销保留账号页，密码配置为 ${configured} 时通过弹窗完成交接`, async ({ page }, testInfo) => {
  const user = { id: 'owner', nickname: '服主', avatar: '', signature: '', administrator: true };
  let administrator = true;
  let recoveryConfigured = configured;
  let transferTargetId: string | null = null;
  let ownedGroups = [{ id: 'group-close', name: '待处理群组' }];
  let closed = 0;
  let dissolved = 0;
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', qqAvailable: true } }));
  await page.route('**/api/auth/qq/binding', route => route.fulfill({ json: { bound: false, nickname: '' } }));
  await page.route('**/api/rtc/voice-time', route => route.fulfill({ json: { seconds: 7200 } }));
  await page.route('**/api/system/initialization', route => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: user }));
  await page.route('**/api/groups', route => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/server-settings', route => route.fulfill({ json: {
    serverName: '测试服务器', publicUrlConfigured: true, qqEnabled: false, mediaConfigured: true,
  } }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: {
    administrator, recoveryConfigured, ownedGroups, candidates: [{ id: 'friend', nickname: '朋友' }], incomingTransfer: null, transferTargetId,
  } }));
  await page.route('**/api/auth/account/transfer', route => {
    expect(route.request().postDataJSON()).toEqual({ targetId: 'friend', password: 'test12' });
    transferTargetId = 'friend';
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/auth/account/recovery-password', route => {
    expect(route.request().postDataJSON().password).toBe('test12');
    recoveryConfigured = true;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/auth/account/close', route => {
    closed++;
    expect(administrator).toBe(false);
    expect(ownedGroups).toHaveLength(0);
    expect(route.request().postDataJSON()).toEqual({ confirmation: '注销账号' });
    return route.fulfill({ status: 503, json: { detail: '测试注销失败，请重试' } });
  });
  await page.route('**/api/groups/group-close', route => {
    if (route.request().method() === 'DELETE') {
      dissolved++; ownedGroups = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { id: 'group-close', name: '待处理群组', description: '', avatar: '', role: 'OWNER', memberCount: 2,
      members: [{ userId: 'owner', nickname: '服主', avatar: '', role: 'OWNER' }, { userId: 'friend', nickname: '朋友', avatar: '', role: 'MEMBER' }] } });
  });
  const memberQueries: { search: string; offset: number }[] = [];
  await page.route('**/api/auth/access/members?**', route => {
    const query = new URL(route.request().url()).searchParams;
    const search = query.get('search') ?? ''; const offset = Number(query.get('offset'));
    memberQueries.push({ search, offset });
    const members = configured && !search && offset === 0
      ? Array.from({ length: 100 }, (_, index) => ({ id: `server-${index}`, nickname: `成员${index}`, avatar: '' }))
      : [{ id: 'friend', nickname: '朋友', avatar: '' }];
    return route.fulfill({ json: members });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.closure-requirements > span')).toHaveCount(2);
  await page.locator('.account-settings').scrollIntoViewIfNeeded();
  await page.locator('.settings-view').screenshot({ path: testInfo.outputPath('account-actions-conditions.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  if (configured) await expect(page.getByRole('button', { name: '去转让服主', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认注销', exact: true })).toHaveCount(0);
  expect(closed).toBe(0);
  if (configured) await page.getByRole('button', { name: '去转让服主', exact: true }).click();
  else {
    const passwordDialog = page.getByRole('dialog', { name: '设置恢复密码', exact: true });
    await expect(passwordDialog.getByText('请先设置恢复密码，再转让服主。', { exact: true })).toBeVisible();
    await passwordDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '注销账号', exact: true }).click();
    await expect(passwordDialog).toBeVisible();
    await passwordDialog.getByLabel('新恢复密码（至少 6 位）', { exact: true }).fill('test12');
    await passwordDialog.getByLabel('确认恢复密码', { exact: true }).fill('test12');
    await passwordDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.app-notice')).toContainText('恢复密码已保存。');
  }
  await expect(page.getByRole('searchbox', { name: '搜索服务器成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回注销流程', exact: true })).toHaveCount(0);
  await expect(page.locator('.settings-header h1')).toHaveText('账号设置');
  const ownerTransfer = page.getByRole('dialog', { name: '转让服主', exact: true });
  if (configured) {
    await expect(ownerTransfer.locator('.member-picker-row')).toHaveCount(100);
    await ownerTransfer.locator('.member-picker-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(ownerTransfer.locator('.member-picker-row')).toHaveCount(101);
    expect(memberQueries).toContainEqual({ search: '', offset: 100 });
    await ownerTransfer.getByRole('searchbox').fill('朋友');
    await expect(ownerTransfer.locator('.member-picker-row')).toHaveCount(1);
    expect(memberQueries).toContainEqual({ search: '朋友', offset: 0 });
    await ownerTransfer.screenshot({ path: testInfo.outputPath('owner-transfer-picker.png'), animations: 'disabled' });
  }
  await ownerTransfer.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByLabel('当前服主恢复密码', { exact: true }).fill('test12');
  await page.getByRole('button', { name: '发起转让', exact: true }).click();
  await page.getByRole('dialog', { name: '注销账号', exact: true }).getByRole('button', { name: '查看转让', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '转让服主', exact: true }).getByText('正在等待接任者确认，完成前你仍是服主。', { exact: true })).toBeVisible();
  // 模拟接任者在另一设备确认，返回注销时必须重新获取服务器状态。
  administrator = false;
  await page.getByRole('dialog', { name: '转让服主', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();

  await expect(page.getByRole('button', { name: '去转让服主', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '注销账号', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '注销账号', exact: true }).screenshot({ path: testInfo.outputPath('close-account-dialog.png') });
  await page.getByRole('button', { name: '处理群组', exact: true }).click();
  await page.getByRole('dialog', { name: '处理群组', exact: true }).screenshot({ path: testInfo.outputPath('group-disposition-dialog.png') });
  await page.getByRole('dialog', { name: '处理群组', exact: true }).getByRole('button', { name: '转让群主', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '转让群主', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '转让群主', exact: true }).getByRole('button', { name: '解散群聊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '解散群聊', exact: true });
  await expect(dialog.getByRole('button', { name: '确认解散', exact: true })).toBeDisabled();
  expect(dissolved).toBe(0);
  await dialog.getByLabel('输入群聊名称以确认').fill('待处理群组');
  await dialog.getByRole('button', { name: '确认解散', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('请输入“注销账号”确认，此操作不能撤回')).toBeVisible();
  expect(dissolved).toBe(1);
  expect(closed).toBe(0);
  await page.getByLabel('请输入“注销账号”确认，此操作不能撤回').fill('注销账号');
  await page.getByRole('button', { name: '确认注销', exact: true }).click();
  await expect(page.getByText('测试注销失败，请重试', { exact: true })).toBeVisible();
  expect(closed).toBe(1);
});


test('接任服主在弹窗填写，取消清空密码，失败保留表单', async ({ page }) => {
  const user = { id: 'successor', nickname: '接任成员', avatar: '', signature: '', administrator: false };
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: user }));
  await page.route('**/api/groups', route => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: {
    administrator: false, recoveryConfigured: false, ownedGroups: [], candidates: [], transferTargetId: null,
    incomingTransfer: { ownerNickname: '原服主', expiresAt: '2099-01-01T00:00:00Z' },
  } }));
  let writes = 0;
  await page.route('**/api/auth/account/transfer/accept', route => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ password: 'example-password-123' });
    return route.fulfill({ status: 503, json: { detail: '暂时无法接任' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('恢复密码（至少 6 位）', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看转让', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '接任服主', exact: true });
  await dialog.getByLabel('恢复密码（至少 6 位）', { exact: true }).fill('discard-this-password');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '查看转让', exact: true }).click();
  await expect(dialog.getByLabel('恢复密码（至少 6 位）', { exact: true })).toHaveValue('');
  await dialog.getByLabel('恢复密码（至少 6 位）', { exact: true }).fill('example-password-123');
  await dialog.getByLabel('确认恢复密码', { exact: true }).fill('example-password-123');
  await dialog.getByRole('button', { name: '确认接任', exact: true }).click();
  await expect(dialog.getByText('暂时无法接任', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});


test('注销逐个处理群组，切换方式保留草稿并要求确认接任昵称', async ({ page }, testInfo) => {
  const user = { id: 'owner', nickname: '我', avatar: '', signature: '', administrator: false };
  let ownedGroups = [{ id: 'first', name: '第一群' }, { id: 'second', name: '第二群' }];
  let transfers = 0;
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', initialized: true, qqAvailable: false } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: user }));
  await page.route('**/api/groups', route => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/account', route => route.fulfill({ json: { administrator: false, recoveryConfigured: false,
    ownedGroups, candidates: [], incomingTransfer: null, transferTargetId: null } }));
  const members = [{ userId: 'owner', nickname: '我', avatar: '', role: 'OWNER' },
    ...Array.from({ length: 30 }, (_, i) => ({ userId: `friend-${i}`, nickname: `朋友${i}`, avatar: '', role: 'MEMBER' }))];
  await page.route('**/api/groups/first/owner', route => {
    transfers++; expect(route.request().postDataJSON()).toEqual({ userId: 'friend-29' });
    ownedGroups = ownedGroups.filter(group => group.id !== 'first');
    return route.fulfill({ json: { id: 'first', name: '第一群', role: 'MEMBER', members, memberCount: members.length, avatar: '', description: '' } });
  });
  await page.route(/\/api\/groups\/(first|second)$/, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (route.request().method() === 'DELETE') { ownedGroups = ownedGroups.filter(group => group.id !== id); return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: { id, name: id === 'first' ? '第一群' : '第二群', role: 'OWNER', members, memberCount: members.length, avatar: '', description: '' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '处理群组', exact: true })).toHaveCount(1);
  await expect(page.locator('.closure-group-names')).toHaveText('第一群、第二群');
  await page.getByRole('button', { name: '处理群组', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '处理群组', exact: true })).toContainText('还有 1 个群聊待处理');
  await page.getByRole('button', { name: '转让群主', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '转让群主', exact: true });
  await expect(dialog.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.member-picker-row')).toHaveCount(31);
  expect(await dialog.locator('.member-picker-list').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  await dialog.getByRole('searchbox').fill('朋友29');
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await dialog.getByLabel('输入对方昵称以确认').fill('朋友');
  await expect(dialog.getByRole('button', { name: '确认转让', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '解散群聊', exact: true }).click();
  const dissolve = page.getByRole('dialog', { name: '解散群聊', exact: true });
  await dissolve.getByLabel('输入群聊名称以确认').fill('第一');
  await dissolve.getByRole('button', { name: '转让群主', exact: true }).click();
  await expect(dialog.getByLabel('输入对方昵称以确认')).toHaveValue('朋友');
  await expect(dialog.locator('.management-page:not([inert]) .confirmation-copy')).toContainText('朋友29');
  expect(await dialog.locator('.management-page:not([inert]) .confirmation-copy').evaluate(element => getComputedStyle(element).userSelect)).toBe('text');
  await dialog.getByRole('button', { name: '解散群聊', exact: true }).click();
  await expect(dissolve.getByLabel('输入群聊名称以确认')).toHaveValue('第一');
  await dissolve.getByRole('button', { name: '转让群主', exact: true }).click();
  await dialog.getByLabel('输入对方昵称以确认').fill('朋友29');
  await dialog.screenshot({ path: testInfo.outputPath('group-transfer-confirm.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '确认转让', exact: true }).click();
  const next = page.getByRole('dialog', { name: '处理群组', exact: true });
  await expect(next).toContainText('第二群');
  await expect(next).not.toContainText('个群聊待处理');
  expect(transfers).toBe(1);
  await next.getByRole('button', { name: '解散群聊', exact: true }).click();
  await dissolve.getByLabel('输入群聊名称以确认').fill('第二群');
  await dissolve.getByRole('button', { name: '确认解散', exact: true }).click();
  await expect(page.getByLabel('请输入“注销账号”确认，此操作不能撤回')).toBeVisible();
  expect(ownedGroups).toHaveLength(0);
});

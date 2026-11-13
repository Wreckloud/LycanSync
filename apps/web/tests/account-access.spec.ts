import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 未提供模拟的业务请求明确失败，不能落到 Vite 的真实服务器代理。
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/auth/server-settings/qq', route => route.fulfill({ json: {
    enabled: false, appId: '', callbackUrl: '', appKeyConfigured: false,
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

test('仅服主显示邀请面板且生成链接只在成功后展示', async ({ page }, testInfo) => {
  let configurationReads = 0;
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
  await page.route('**/api/auth/server-settings', (route) => { configurationReads++; return route.fulfill({ json: {
    serverName: '测试服务器', publicUrlConfigured: true, qqEnabled: false, mediaConfigured: true,
  } }); });
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
  await page.locator('.qq-login-settings').screenshot({ path: testInfo.outputPath('qq-settings.png') });
  await page.locator('.qq-login-settings').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('配置暂时无法保存', { exact: true })).toBeVisible();
  rejectQqSave = false;
  await page.locator('.qq-login-settings').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('QQ 登录 · 已开启', { exact: true })).toBeVisible();
  expect(qqWrites).toHaveLength(2);
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await expect(page.getByLabel('App Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('App Key', { exact: true })).toHaveAttribute('placeholder', '已设置，留空保留原密钥');
  await page.getByLabel('允许 QQ 登录', { exact: true }).uncheck();
  await page.locator('.qq-login-settings').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('QQ 登录 · 未开启', { exact: true })).toBeVisible();
  expect(qqWrites[2]).toMatchObject({ enabled: false, appKey: '' });
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await page.getByLabel('App Key', { exact: true }).fill('discard-this-secret');
  await page.locator('.qq-login-settings').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '配置 QQ 登录', exact: true }).click();
  await expect(page.getByLabel('App Key', { exact: true })).toHaveValue('');
  await page.locator('.qq-login-settings').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '设置恢复密码', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('新恢复密码（15–128 个字符）', { exact: true })).toHaveCount(0);
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
  const newPassword = dialog.getByLabel('新恢复密码（15–128 个字符）', { exact: true });
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
  await page.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  await expect(page.getByLabel('生成的链接')).toHaveValue(`https://example.com/join#token=${'a'.repeat(43)}`);
  await expect(page.getByLabel('生成的链接')).toBeFocused();
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
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') return route.fulfill({ json: records });
    if (route.request().method() === 'DELETE') {
      records.find(record => url.pathname.endsWith(record.id))!.revokedAt = new Date().toISOString();
      return route.fulfill({ status: 204 });
    }
    generationCount++;
    if (failGeneration) return route.fulfill({ status: 503, json: { detail: '暂时无法生成链接' } });
    const previous = records.find(record => url.pathname.endsWith(`/${record.id}/renew`));
    if (previous) previous.revokedAt = new Date().toISOString();
    const payload = previous ?? route.request().postDataJSON();
    const record = { ...payload, id: `link-${generationCount}`, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 43_200_000).toISOString(), consumedAt: null, revokedAt: null, resultUserId: null, lastFailure: null };
    records.unshift(record);
    await route.fulfill({ json: { record, url: `https://example.com/join#token=test-${generationCount}` } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await expect(page.getByLabel('备注', { exact: false })).toHaveCount(0);
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(dialog).toHaveAttribute('aria-label', '邀请新朋友');
  expect(memberQueries).toHaveLength(0);
  expect(generationCount).toBe(0);
  await dialog.getByLabel('备注', { exact: false }).fill('一起开黑');
  await dialog.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  await expect(dialog.getByText('暂时无法生成链接', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('备注', { exact: false })).toHaveValue('一起开黑');
  failGeneration = false;
  await dialog.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  const link = dialog.getByLabel('生成的链接');
  await expect(link).toBeFocused();
  expect(await link.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe((await link.inputValue()).length);
  expect(records[0].note).toBe('一起开黑');
  await dialog.getByRole('button', { name: '复制链接', exact: true }).click();
  await expect.poll(() => copied).toBe(await link.inputValue());
  await expect(link).toBeFocused();
  await dialog.screenshot({ path: testInfo.outputPath('invite-link.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '恢复成员登录', exact: true }).click();
  const search = dialog.getByRole('searchbox', { name: '搜索可恢复成员' });
  await expect(search).toBeFocused();
  await search.fill('不存在');
  await expect(dialog.getByText('没有匹配的成员', { exact: true })).toBeVisible();
  await search.fill('member-b');
  await expect(dialog.getByText('朋友乙', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '生成恢复链接', exact: true })).toBeEnabled();
  await dialog.screenshot({ path: testInfo.outputPath('recover-member.png') });
  await dialog.getByRole('button', { name: '生成恢复链接', exact: true }).click();
  await expect(link).toBeFocused();
  expect(records[0]).toMatchObject({ kind: 'RECOVERY', targetId: 'member-b', note: '' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '链接管理', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(2);
  await dialog.locator('.access-record').first().getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(link).toBeFocused();
  await dialog.getByRole('button', { name: '返回记录', exact: true }).click();
  await expect(dialog.locator('.access-record')).toHaveCount(3);
  const newest = dialog.locator('.access-record').first();
  await newest.getByRole('button', { name: '撤销', exact: true }).click();
  await newest.getByRole('button', { name: '取消', exact: true }).click();
  expect(records[0].revokedAt).toBeNull();
  await newest.getByRole('button', { name: '撤销', exact: true }).click();
  await newest.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(newest).toContainText('已撤销');
  await page.setViewportSize({ width: 390, height: 740 });
  await dialog.screenshot({ path: testInfo.outputPath('link-management-narrow.png') });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '链接管理', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '邀请新朋友', exact: true }).click();
  await expect(dialog.getByLabel('生成的链接')).toHaveCount(0);
  await expect(dialog.getByLabel('备注', { exact: false })).toHaveValue('');
});

test('注销始终可进入，服主和群组事项完成后才提交注销', async ({ page }, testInfo) => {
  const user = { id: 'owner', nickname: '服主', avatar: '', signature: '', administrator: true };
  let administrator = true;
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
    administrator, recoveryConfigured: true, ownedGroups, candidates: [{ id: 'friend', nickname: '朋友' }], incomingTransfer: null, transferTargetId: null,
  } }));
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
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.closure-requirements > span')).toHaveCount(2);
  await page.locator('.account-settings').scrollIntoViewIfNeeded();
  await page.locator('.settings-view').screenshot({ path: testInfo.outputPath('account-actions-conditions.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '去转让服主', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认注销', exact: true })).toHaveCount(0);
  expect(closed).toBe(0);
  await page.getByRole('button', { name: '去转让服主', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '接任成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回注销流程', exact: true })).toBeVisible();
  // 模拟接任者在另一设备确认，返回注销时必须重新获取服务器状态。
  administrator = false;
  await page.getByRole('button', { name: '返回注销流程', exact: true }).click();
  await expect(page.getByRole('button', { name: '去转让服主', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '转让群组', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '转让群主', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '解散群组', exact: true }).click();
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

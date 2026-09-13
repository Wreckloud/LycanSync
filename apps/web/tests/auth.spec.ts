import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
});

test('首次注册创建管理员并在浏览器内存保存会话', async ({ page }) => {
  const token = 'a'.repeat(43);
  const user = { id: 'admin-user', nickname: 'Admin', avatar: '', administrator: true };
  let registration: Record<string, unknown> | undefined;
  let groupAuthorization: string | undefined;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: false } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.route('**/api/auth/local/register', async (route) => {
    registration = route.request().postDataJSON();
    await route.fulfill({ json: { sessionToken: token, user } });
  });
  await page.route('**/api/groups', (route) => {
    groupAuthorization = route.request().headers().authorization;
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('Admin');
  await page.getByLabel('密码', { exact: true }).fill('abc123');
  await page.getByLabel('确认密码', { exact: true }).fill('abc123');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();

  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  expect(registration).toEqual({ username: 'Admin', password: 'abc123' });
  await expect.poll(() => groupAuthorization).toBe('Bearer ' + token);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
});

test('已初始化服务器使用本地账号登录', async ({ page }) => {
  const token = 'b'.repeat(43);
  const user = { id: 'local-user', nickname: '小狼', avatar: '', administrator: false };
  let login: Record<string, unknown> | undefined;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.route('**/api/auth/local/login', async (route) => {
    login = route.request().postDataJSON();
    await route.fulfill({ json: { sessionToken: token, user } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));

  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('friend');
  await page.getByLabel('密码', { exact: true }).fill('friend-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();

  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  expect(login).toEqual({ username: 'friend', password: 'friend-password' });
});

test('已初始化服务器允许创建普通账号', async ({ page }) => {
  const token = 'c'.repeat(43);
  const user = { id: 'new-user', nickname: 'NewFriend', avatar: '', administrator: false };
  let registration: Record<string, unknown> | undefined;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { detail: '请先登录' } }));
  await page.route('**/api/auth/local/register', async (route) => {
    registration = route.request().postDataJSON();
    await route.fulfill({ json: { sessionToken: token, user } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));

  await page.goto('/');
  await page.getByRole('button', { name: '没有账号，创建账号' }).click();
  await page.getByLabel('用户名', { exact: true }).fill('NewFriend');
  await page.getByLabel('密码', { exact: true }).fill('friend-password');
  await page.getByLabel('确认密码', { exact: true }).fill('friend-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();

  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  expect(registration).toEqual({ username: 'NewFriend', password: 'friend-password' });
});

test('新设备替换会话后旧客户端通过心跳静默退出', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'old-session', nickname: '旧设备', avatar: '', administrator: true };
  let sessionRequests = 0;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => {
    sessionRequests++;
    return route.fulfill({ status: 401, json: { detail: '登录已过期，请重新登录' } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  await page.clock.fastForward(20_100);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect(sessionRequests).toBeGreaterThanOrEqual(1);
});

test('上一次会话心跳完成前不会发起下一次', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'heartbeat-user', nickname: '心跳测试', avatar: '', administrator: false };
  let sessionRequests = 0;
  let releaseHeartbeat = () => {};
  const heartbeatPending = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', async (route) => {
    sessionRequests++;
    await heartbeatPending;
    return route.fulfill({ json: {
      id: user.id, nickname: user.nickname, administrator: user.administrator,
    } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => new AbortController().signal,
    });
  });
  await page.clock.fastForward(60_100);
  await expect.poll(() => sessionRequests).toBe(1);
  releaseHeartbeat();
});

test('会话状态未变化时心跳保持固定节拍', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'heartbeat-cadence', nickname: '固定节拍', avatar: '', administrator: false };
  let sessionRequests = 0;
  let releaseFirstHeartbeat = () => {};
  let finishFirstHeartbeat = () => {};
  const firstHeartbeatPending = new Promise<void>((resolve) => { releaseFirstHeartbeat = resolve; });
  const firstHeartbeatFinished = new Promise<void>((resolve) => { finishFirstHeartbeat = resolve; });
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', async (route) => {
    sessionRequests++;
    if (sessionRequests === 1) {
      await firstHeartbeatPending;
      await route.fulfill({ json: {
        id: user.id, nickname: user.nickname, administrator: user.administrator,
      } });
      finishFirstHeartbeat();
      return;
    }
    await route.fulfill({ json: {
      id: user.id, nickname: user.nickname, administrator: user.administrator,
    } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: '个人设置', exact: true })).toBeVisible();
  await page.clock.fastForward(20_100);
  await expect.poll(() => sessionRequests).toBe(1);
  await page.clock.fastForward(5_000);
  releaseFirstHeartbeat();
  await firstHeartbeatFinished;
  await page.clock.fastForward(14_800);
  expect(sessionRequests).toBe(1);
  await page.clock.fastForward(200);
  await expect.poll(() => sessionRequests).toBe(2);
});

test('个人资料修改沿用当前账号', async ({ page }) => {
  let user = { id: 'test-user', nickname: '初始昵称', avatar: '', administrator: true };
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') user = { ...user, ...route.request().postDataJSON() };
    await route.fulfill({ json: user });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '个人设置', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('自定义昵称');
  await page.getByRole('button', { name: '保存资料' }).click();
  await page.getByRole('button', { name: '个人设置', exact: true }).click();
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('自定义昵称');
});

test('更换头像不会改变个人设置布局', async ({ page }) => {
  const user = { id: 'avatar-user', nickname: '头像测试', avatar: '', administrator: true };
  let profileUpdate: { nickname?: string; avatar?: string } | undefined;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') profileUpdate = route.request().postDataJSON();
    await route.fulfill({ json: { ...user, ...profileUpdate } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '个人设置', exact: true }).click();

  const dialog = page.locator('.profile-dialog');
  const initialDialog = await dialog.boundingBox();
  await expect(page.locator('.profile-avatar-preview')).toHaveCSS('width', '112px');
  await expect(page.locator('.profile-avatar-preview')).toHaveCSS('height', '112px');
  await expect(page.getByRole('button', { name: '移除头像' })).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  const cropDialog = page.getByRole('dialog', { name: '调整头像' });
  await expect(cropDialog).toBeVisible();
  await expect(cropDialog.getByAltText('待裁剪头像')).toHaveJSProperty('naturalWidth', 1);
  expect(await cropDialog.getByAltText('待裁剪头像').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await dialog.boundingBox()).toEqual(initialDialog);
  await expect(page.getByLabel('头像缩放')).toBeVisible();
  await page.getByRole('button', { name: '应用头像' }).click();
  const preview = page.getByAltText('头像预览');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('naturalWidth', 256);
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await dialog.boundingBox()).toEqual(initialDialog);
  await page.getByRole('button', { name: '保存资料' }).click();
  expect(profileUpdate?.avatar).toMatch(/^data:image\/png;base64,/);
  expect(Buffer.from(profileUpdate!.avatar!.split(',')[1], 'base64').length).toBeLessThanOrEqual(96 * 1024);
});

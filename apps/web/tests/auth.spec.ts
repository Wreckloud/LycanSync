import { test, expect, type Page } from '@playwright/test';

async function editNickname(page: Page, nickname?: string) {
  const input = page.getByLabel('昵称', { exact: true });
  if (!await input.isVisible()) await page.getByRole('button', { name: /^修改昵称，/ }).click();
  if (nickname !== undefined) await input.fill(nickname);
  return input;
}

function silentWav(durationMs = 100) {
  const sampleRate = 8_000;
  const dataLength = Math.round(sampleRate * durationMs / 1_000);
  const buffer = Buffer.alloc(44 + dataLength, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
});





test('浏览器旧会话的延迟 401 不退出新会话，当前会话 401 仍会退出', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'race-member', nickname: '行者1001', avatar: '', administrator: false };
  let optionsRequests = 0;
  let redemptions = 0;
  let currentToken = '';
  let revoked = false;
  let holdSession = true;
  let releaseSession = () => {};
  let sessionStarted = () => {};
  const started = new Promise<void>((resolve) => { sessionStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseSession = resolve; });
  await page.route('**/api/auth/options', (route) => ++optionsRequests === 1
    ? route.fulfill({ status: 503, json: { detail: '测试初始化等待兑换' } })
    : route.fulfill({ json: { mode: 'invite' } }));
  await page.route('**/api/auth/access/redeem', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ token: (redemptions ? 'e' : 'a').repeat(43), redemptionKey: 'b'.repeat(43) });
    currentToken = (++redemptions === 1 ? 'c' : 'd').repeat(43);
    return route.fulfill({ json: { sessionToken: currentToken, user } });
  });
  await page.route('**/api/auth/logout', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', async (route) => {
    if (holdSession) {
      holdSession = false;
      sessionStarted();
      await gate;
      return route.fulfill({ status: 401, json: { detail: '旧会话已失效' } });
    }
    const valid = !revoked && route.request().headers().authorization === 'Bearer ' + currentToken;
    return route.fulfill({ status: valid ? 200 : 401, json: valid ? user : { detail: '会话已失效' } });
  });
  // 浏览器没有桌面协议入口；通过正式兑换接口和会话存储测试传输层，不增加产品测试开关。
  const exchange = (recovery = false) => page.evaluate(async (token) => {
    const modulePath = '/src/auth/authApi.ts';
    const { authRequest, setBrowserSession } = await import(modulePath);
    const result = await authRequest('access/redeem', 'POST', { token, redemptionKey: 'b'.repeat(43) });
    setBrowserSession(result.sessionToken);
  }, (recovery ? 'e' : 'a').repeat(43));
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
    await exchange();
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    await page.clock.fastForward(20_100);
    await started;
    await page.evaluate(async () => {
      const modulePath = '/src/auth/authApi.ts';
      const { authRequest, setBrowserSession } = await import(modulePath);
      await authRequest('logout', 'POST');
      setBrowserSession(null);
    });
    await exchange(true);
    const delayed = page.waitForResponse((response) => response.url().endsWith('/api/auth/session') && response.status() === 401);
    releaseSession();
    await delayed;
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
    revoked = true;
    await page.clock.fastForward(20_100);
    await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
    expect(redemptions).toBe(2);
  } finally { releaseSession(); }
});



test('新设备替换会话后旧客户端通过心跳静默退出', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'old-session', nickname: '旧设备', avatar: '', administrator: true };
  let sessionRequests = 0;
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
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
  await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
  await page.clock.fastForward(20_100);
  await expect(page.getByText('请打开服主发来的邀请或恢复登录链接', { exact: false })).toBeVisible();
  expect(sessionRequests).toBeGreaterThanOrEqual(1);
});

test('上一次会话心跳完成前不会发起下一次', async ({ page }) => {
  await page.clock.install();
  const user = { id: 'heartbeat-user', nickname: '心跳测试', avatar: '', administrator: false };
  let sessionRequests = 0;
  let releaseHeartbeat = () => {};
  const heartbeatPending = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
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
  await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
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
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
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
  await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeVisible();
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
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') user = { ...user, ...route.request().postDataJSON() };
    await route.fulfill({ json: user });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.locator('.settings-view')).not.toHaveAttribute('role', 'dialog');
  await expect(page.locator('.settings-view')).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.getByLabel('账号标识')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存资料' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消修改' })).toHaveCount(0);
  await editNickname(page, '自定义昵称');
  await page.getByLabel('昵称', { exact: true }).press('Enter');
  await expect.poll(() => user.nickname).toBe('自定义昵称');
  await expect(page.getByRole('button', { name: '修改昵称，自定义昵称', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回应用' }).click();
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改昵称，自定义昵称', exact: true })).toBeVisible();
});

test('自动保存失败保留草稿，不关闭设置，重新编辑后可以重试', async ({ page }) => {
  let user = { id: 'profile-failure-user', nickname: '服务器昵称', avatar: '', administrator: false };
  let failSave = true;
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') {
      if (failSave) return route.fulfill({ status: 503, json: { message: '暂时无法保存' } });
      user = { ...user, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: user });
  });
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await editNickname(page, '未保存的新昵称');
  await page.getByLabel('昵称', { exact: true }).press('Tab');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('未保存的新昵称');
  await page.getByRole('button', { name: '返回应用' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  failSave = false;
  await page.getByLabel('昵称', { exact: true }).press('Enter');
  await expect.poll(() => user.nickname).toBe('未保存的新昵称');
  await page.getByRole('button', { name: '返回应用' }).click();
  await expect(page.locator('.settings-view')).toHaveCount(0);
});

test('资料基线跟随服务器更新并在保存后采用服务端规范值', async ({ page }) => {
  let user = { id: 'profile-baseline-user', nickname: '初始昵称', avatar: '', administrator: false };
  await page.clock.install();
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') user = { ...user, ...route.request().postDataJSON() };
    await route.fulfill({ json: user });
  });
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: {
    id: user.id, nickname: user.nickname, administrator: user.administrator,
  } }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();

  user = { ...user, nickname: '服务器新昵称' };
  await page.clock.fastForward(20_100);
  await expect(page.getByRole('button', { name: '修改昵称，服务器新昵称', exact: true })).toBeVisible();

  await editNickname(page, '保留的资料草稿');
  user = { ...user, nickname: '服务器再次更新' };
  await page.clock.fastForward(20_100);
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('保留的资料草稿');
  await page.getByLabel('昵称', { exact: true }).fill('  保存时去空格  ');
  await page.getByLabel('昵称', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: '修改昵称，保存时去空格', exact: true })).toBeVisible();
  await expect.poll(() => user.nickname).toBe('保存时去空格');
  await page.getByRole('button', { name: '返回应用' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('浏览器客户端栏目不展示 Windows 开机自启控件，Esc 返回并恢复入口焦点', async ({ page }) => {
  const user = { id: 'settings-browser-user', nickname: '浏览器用户', avatar: '', administrator: false };
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.goto('/');
  const entry = page.getByRole('button', { name: '语音与音频设置', exact: true });
  await entry.click();
  await expect(page.locator('.settings-header h1')).toBeFocused();
  await page.getByRole('button', { name: '客户端', exact: true }).click();
  await expect(page.locator('.client-settings')).toContainText('开机自启仅在 Windows 桌面版提供');
  await expect(page.getByLabel('开机自动启动')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-view')).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test('切换栏目和 Esc 关闭前自动保存，未修改不提交', async ({ page }) => {
  let user = { id: 'draft-user', nickname: '草稿测试', avatar: '', administrator: true };
  let updates = 0;
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => {
    if (route.request().method() === 'PUT') {
      updates++;
      user = { ...user, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: user });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await editNickname(page);
  await page.getByRole('button', { name: '音效', exact: true }).click();
  expect(updates).toBe(0);
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await editNickname(page, '自动保存');
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect.poll(() => user.nickname).toBe('自动保存');
  expect(updates).toBe(1);
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改昵称，自动保存', exact: true })).toBeVisible();
  await editNickname(page, '关闭前保存');
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-view')).toHaveCount(0);
  expect(user.nickname).toBe('关闭前保存');
  expect(updates).toBe(2);
});

test('更换头像在整页资料设置中裁剪并保存', async ({ page }) => {
  const user = { id: 'avatar-user', nickname: '头像测试', avatar: '', administrator: true };
  let profileUpdate: { nickname?: string; avatar?: string } | undefined;
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') profileUpdate = route.request().postDataJSON();
    await route.fulfill({ json: { ...user, ...profileUpdate } });
  });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();

  const settings = page.locator('.settings-view');
  const initialSettings = await settings.boundingBox();
  await expect(settings).not.toHaveAttribute('role', 'dialog');
  await expect(settings).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.profile-avatar-preview')).toHaveCSS('width', '76px');
  await page.getByRole('button', { name: '修改头像', exact: true }).hover();
  await expect(page.locator('.profile-avatar-overlay')).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: '移除头像' })).toHaveCount(0);
  await page.getByLabel('上传头像').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  const cropDialog = page.getByRole('dialog', { name: '调整头像' });
  await expect(cropDialog).toBeVisible();
  await expect(cropDialog.getByAltText('待裁剪头像')).toHaveJSProperty('naturalWidth', 1);
  expect(await cropDialog.getByAltText('待裁剪头像').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await settings.boundingBox()).toEqual(initialSettings);
  await expect(page.getByLabel('头像缩放')).toBeVisible();
  await cropDialog.getByLabel('拖动调整头像位置').hover();
  await page.mouse.wheel(0, -100);
  await expect(page.getByLabel('头像缩放')).toHaveValue('1.1');
  await page.mouse.wheel(0, 100);
  await expect(page.getByLabel('头像缩放')).toHaveValue('1');
  await page.getByRole('button', { name: '应用头像' }).click();
  const preview = page.getByAltText('头像预览');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('naturalWidth', 256);
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await settings.boundingBox()).toEqual(initialSettings);
  await expect.poll(() => profileUpdate?.avatar).toMatch(/^data:image\/png;base64,/);
  expect(Buffer.from(profileUpdate!.avatar!.split(',')[1], 'base64').length).toBeLessThanOrEqual(96 * 1024);
});

test('签名自动保存与注册日期展示，反馈不推动下方内容', async ({ page }) => {
  const user = {
    id: 'signature-user', nickname: '签名测试', avatar: '', administrator: false,
    signature: '', createdAt: '2026-09-06T12:00:00Z',
  };
  let updates = 0;
  let failNext = false;
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'PUT') {
      updates++;
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 503, json: { detail: '暂时无法保存' } });
      }
      const profile = route.request().postDataJSON();
      expect(profile).not.toHaveProperty('createdAt');
      Object.assign(user, profile);
    }
    await route.fulfill({ json: user });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.locator('.profile-registration time')).toHaveAttribute('datetime', user.createdAt);
  const activityPosition = await page.locator('.activity-settings').boundingBox();
  const signature = page.getByRole('textbox', { name: '个性签名', exact: true });
  await expect(signature).toHaveAttribute('maxlength', '120');
  await signature.fill('一起开黑');
  await page.getByRole('heading', { name: '账号设置', exact: true }).click();
  await expect.poll(() => user.signature).toBe('一起开黑');
  expect(updates).toBe(1);
  expect(await page.locator('.activity-settings').boundingBox()).toEqual(activityPosition);

  failNext = true;
  await signature.fill('保留失败草稿');
  await page.getByRole('heading', { name: '账号设置', exact: true }).click();
  await expect(page.locator('.profile-feedback [role="alert"]')).toContainText('暂时无法保存');
  await expect(signature).toHaveValue('保留失败草稿');
  expect(await page.locator('.activity-settings').boundingBox()).toEqual(activityPosition);

  await signature.fill('');
  await page.getByRole('heading', { name: '账号设置', exact: true }).click();
  await expect.poll(() => user.signature).toBe('');
  await expect(page.locator('.profile-feedback [role="alert"]')).toHaveCount(0);
  expect(updates).toBe(3);
});

test('动态开关按账号保存，账号设置明确标出尚未接入的功能', async ({ page }) => {
  const user = { id: 'settings-account-user', nickname: '设置测试', avatar: '', administrator: false };
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置栏目' }).getByRole('button', { name: '个人资料', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '设置栏目' }).getByRole('button', { name: '当前动态', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修改头像', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '修改密码', exact: true })).toHaveCount(0);
  await expect(page.getByText('更换电脑或丢失登录时，请联系服主生成“恢复成员登录”链接。')).toBeVisible();
  await expect(page.getByRole('button', { name: '连接 QQ', exact: true })).toBeVisible();
  await expect(page.locator('.activity-settings')).toContainText('动态检测仅在桌面版提供');
  const toggle = page.getByRole('checkbox', { name: '显示当前动态', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  expect(await page.evaluate(() => localStorage.getItem('lycansync.activity-visible.v1.settings-account-user'))).toBe('false');
  await page.getByRole('button', { name: '返回应用' }).click();
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(toggle).not.toBeChecked();

  await expect(page.getByRole('textbox', { name: '新密码' })).toHaveCount(0);
  await page.getByRole('button', { name: '连接 QQ', exact: true }).click();
  await expect(page.locator('#qq-entry')).toContainText('尚未接入');
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
});

test('自定义入场音按账号保存在本机并可移除', async ({ page }) => {
  const user = { id: 'entrance-sound-user', nickname: '音效测试', avatar: '', administrator: true };
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({
    json: { participantCount: 0, participants: [] },
  }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await page.getByLabel('选择入场音效').setInputFiles({
    name: 'hello.wav',
    mimeType: 'audio/wav',
    buffer: silentWav(),
  });

  await expect(page.getByRole('button', { name: '试听' })).toBeVisible();
  await expect(page.locator('.sound-settings')).toContainText('hello.wav');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'lycansync.entrance-sound.v1.entrance-sound-user'))).not.toBeNull();

  await page.getByRole('button', { name: '移除' }).click();
  await expect(page.getByRole('button', { name: '试听' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem(
    'lycansync.entrance-sound.v1.entrance-sound-user'))).toBeNull();
});

test('离开音效栏目或关闭设置会停止音效试听', async ({ page }) => {
  const user = { id: 'preview-user', nickname: '试听测试', avatar: '', administrator: false };
  await page.addInitScript(() => {
    const state = window as Window & { __previewCounts?: { plays: number; pauses: number } };
    state.__previewCounts = { plays: 0, pauses: 0 };
    class AudioPreviewStub {
      volume = 1;
      constructor(_source: string) {}
      play() { state.__previewCounts!.plays++; return Promise.resolve(); }
      pause() { state.__previewCounts!.pauses++; }
    }
    Object.defineProperty(window, 'Audio', { value: AudioPreviewStub });
    localStorage.setItem('lycansync.entrance-sound.v1.preview-user', JSON.stringify({
      name: 'hello.wav', mimeType: 'audio/wav', dataUrl: 'data:audio/wav;base64,AAAA',
    }));
  });
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.goto('/');
  if (!await page.locator('.settings-view').isVisible()) {
    await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect(page.locator('.sound-settings')).toContainText('格式：audio/wav · 文件大小：3 字节');
  await page.getByRole('button', { name: '试听' }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __previewCounts?: { plays: number; pauses: number };
  }).__previewCounts?.plays)).toBe(1);
  await page.getByRole('button', { name: '语音与音频', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __previewCounts?: { plays: number; pauses: number };
  }).__previewCounts?.pauses)).toBe(1);
  await page.getByRole('button', { name: '返回应用' }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __previewCounts?: { plays: number; pauses: number };
  }).__previewCounts?.pauses)).toBe(1);
});

import { expect, test, type Locator } from '@playwright/test';

async function selectPersonalPresence(menu: Locator, label: string) {
  await menu.getByRole('group', { name: '在线状态', exact: true }).getByRole('button', { name: label, exact: true }).click();
}

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';
const friendId = 'a1ae7096-049b-46ed-8e62-4f3dd0e7f80d';
const secondId = 'b2ae7096-049b-46ed-8e62-4f3dd0e7f80d';
const user = { id: '2d983469-4442-44f5-b5a8-f3819f16a611', nickname: '维克罗德', avatar: '',
  signature: '一起开黑，慢慢来。', administrator: true, createdAt: '2026-09-01T00:00:00Z' };
const members = [
  { userId: user.id, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: user.createdAt },
  { userId: friendId, nickname: '阿岚', avatar: '', role: 'MEMBER', joinedAt: user.createdAt },
  { userId: secondId, nickname: '小满', avatar: '', role: 'MEMBER', joinedAt: user.createdAt },
];
const group = { id: groupId, name: '周末开黑', description: '资料卡布局检查', avatar: '', role: 'OWNER',
  memberCount: members.length, createdAt: user.createdAt, updatedAt: user.createdAt, members };

test.beforeEach(async ({ page }) => {
  // 所有业务请求都停在本地模拟，不连接真实服务器或设备。
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
  await page.route('**/api/auth/options', route => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', route => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }));
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
  await page.route('**/api/rtc/room-occupancies', route => route.fulfill({ json: [] }));
  await page.route('**/api/rtc/voice-time', route => route.fulfill({ json: { seconds: 0 } }));
  await page.route('**/api/rtc/room-summary*', route => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: [], hasMore: false } });
    if (url.pathname.endsWith('/presence-changes')) return new Promise<void>(() => {});
    if (url.pathname.endsWith('/presences')) return route.fulfill({ json: members.map(member => ({ userId: member.userId,
      status: 'ONLINE', lastSeenAt: null, activityType: member.userId === friendId ? 'GAME' : null,
      activityName: member.userId === friendId ? '最终幻想14' : null,
      activityStartedAt: member.userId === friendId ? new Date(Date.now() - 600_000).toISOString() : null })) });
    if (url.pathname.endsWith('/profile')) return route.fulfill({ json: {
      userId: url.pathname.split('/').at(-2), signature: '今晚一起玩游戏。', sharedVoiceSeconds: 0,
    } });
    return route.fulfill({ status: 404 });
  });
});

test('底部整块资料打开菜单，编辑沿用设置且返回原入口，不改底部布局', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('.group-conversation > .personal-card');
  const bounds = await footer.boundingBox();
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(user.signature);
  await expect(menu.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(1);
  await expect(menu.getByRole('group', { name: '在线状态', exact: true })).toHaveCount(1);
  expect(await footer.boundingBox()).toEqual(bounds);
  await page.screenshot({ path: test.info().outputPath('personal-menu.png') });
  await menu.getByRole('button', { name: '编辑个人资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await expect(page.locator('.group-conversation > .personal-card').getByRole('button', { name: '个人菜单', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  const settingsIdentity = page.getByLabel('个人状态与返回应用', { exact: true });
  await settingsIdentity.getByRole('button', { name: '个人菜单', exact: true }).click();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: '语音与音频', exact: true }).click();
  await expect(page.getByRole('heading', { name: '语音与音频', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await settingsIdentity.getByRole('button', { name: '个人菜单', exact: true }).click();
  await menu.getByRole('button', { name: '编辑个人资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('settings-identity-menu.png') });
});

test('成员悬浮按需读资料与共同连麦，移入卡片保持，Esc 关闭且缓存避免重复读取', async ({ page }) => {
  let requests = 0;
  await page.route(`**/api/groups/${groupId}/members/${friendId}/profile`, route => {
    requests++;
    return route.fulfill({ json: { userId: friendId, signature: '准备打团。', sharedVoiceSeconds: 151200 } });
  });
  await page.goto('/');
  expect(requests).toBe(0);
  const friend = page.getByRole('button', { name: '查看 阿岚 的资料', exact: true });
  await friend.hover();
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await expect(card).toContainText('准备打团。');
  await expect(card.locator('.profile-voice-time')).toHaveText('一起开黑的时间已经有 42 小时了');
  await expect(card).toContainText('最终幻想14');
  await expect(card.locator('.profile-popover-status')).toHaveCount(0);
  await expect(friend.locator('.member-activity')).toHaveText(/^正在玩\s*最终幻想14$/);
  const directoryBounds = await page.locator('.members-directory').boundingBox();
  const cardBounds = await card.boundingBox();
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(directoryBounds!.x - 6);
  const elapsed = await card.locator('.profile-popover-activity').innerText();
  await expect.poll(() => card.locator('.profile-popover-activity').innerText(), { timeout: 2500 }).not.toBe(elapsed);
  await card.hover();
  await expect(card).toBeVisible();
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('member-profile.png') });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(friend).toBeFocused();
  await page.mouse.move(400, 200);
  await friend.hover();
  await expect(card).toBeVisible();
  expect(requests).toBe(1);
  await page.evaluate(() => {
    const starts: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const element = record.target as HTMLElement;
        if (element.matches?.('.profile-popover.profile-popover-enter-active')) {
          starts.push(element.querySelector('.profile-popover-identity strong')?.textContent ?? '');
        }
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    (window as unknown as { profileEntrances: string[] }).profileEntrances = starts;
  });
  await page.getByRole('button', { name: '查看 小满 的资料', exact: true }).hover();
  await expect.poll(() => page.evaluate(() => (window as unknown as { profileEntrances: string[] }).profileEntrances)).toContain('小满');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('小满');
  await card.hover();
  await page.screenshot({ path: test.info().outputPath('member-profile-switched.png') });
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await expect(card).toHaveCount(0);
  await friend.hover();
  await expect(page.getByRole('dialog', { name: '个人菜单', exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('共同连麦读取失败不冒充无记录，重试无记录时隐藏，自己无记录也隐藏', async ({ page }) => {
  let failed = true;
  await page.route(`**/api/groups/${groupId}/members/${friendId}/profile`, route => failed
    ? route.fulfill({ status: 503, json: { detail: '成员资料暂时无法读取' } })
    : route.fulfill({ json: { userId: friendId, signature: '准备打团。', sharedVoiceSeconds: 0 } }));
  await page.goto('/');
  await page.getByRole('button', { name: '查看 阿岚 的资料', exact: true }).hover();
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card.locator('.profile-voice-time')).toHaveCount(0);
  failed = false;
  await card.getByRole('button', { name: '重试', exact: true }).click();
  await expect(card.locator('.profile-voice-time')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `查看 ${user.nickname} 的资料`, exact: true }).click();
  await expect(card).toContainText(user.signature);
  await expect(card.locator('.profile-voice-time')).toHaveCount(0);
});

test('签名读取失败可以在卡片重试，旧请求不能覆盖新成员', async ({ page }) => {
  let attempts = 0;
  await page.route(`**/api/groups/${groupId}/members/${friendId}/profile`, async route => {
    if (++attempts === 1) return route.fulfill({ status: 503, json: { detail: '签名暂时不可用' } });
    await new Promise(resolve => setTimeout(resolve, 700));
    try { await route.fulfill({ json: { userId: friendId, signature: '旧成员的迟到签名' } }); }
    catch { /* 切换成员已取消请求。 */ }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '查看 阿岚 的资料', exact: true }).hover();
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await expect(card).toContainText('签名暂时不可用');
  await card.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: '查看 小满 的资料', exact: true }).click();
  await expect(card).toContainText('小满');
  await expect(card).toContainText('今晚一起玩游戏。');
  await page.waitForTimeout(800);
  await expect(card).not.toContainText('旧成员的迟到签名');
});

test('窄窗口卡片保持在可视区，自己的成员卡不请求补充资料', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 640 });
  let requests = 0;
  page.on('request', request => { if (request.url().endsWith('/profile')) requests++; });
  await page.goto('/');
  await page.getByRole('button', { name: `查看 ${user.nickname} 的资料`, exact: true }).click();
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await expect(card).toContainText(user.signature);
  expect(requests).toBe(0);
  const bounds = (await card.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(440);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '个人菜单', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '个人菜单', exact: true })).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('personal-menu-narrow.png') });
});

test('个人面板固定在个人栏上方，切换状态不移动，窄窗可滚动并支持键盘', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '个人菜单', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu).toHaveCSS('opacity', '1');
  const original = (await menu.boundingBox())!;
  const footer = (await page.locator('.group-conversation > .personal-card').boundingBox())!;
  expect(original.y + original.height).toBeCloseTo(footer.y - 8, 0);
  expect(original.x + original.width).toBeCloseTo(Math.min(footer.x + footer.width, page.viewportSize()!.width - 8), 0);
  const statusTrigger = menu.getByRole('group', { name: '在线状态', exact: true });
  const nameBefore = await trigger.locator('[data-identity-name]').boundingBox();
  await selectPersonalPresence(menu, '隐身');
  await expect(statusTrigger.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await trigger.locator('[data-identity-name]').boundingBox()).toEqual(nameBefore);
  expect(await menu.boundingBox()).toEqual(original);
  await statusTrigger.getByRole('button', { name: '隐身', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(statusTrigger.getByRole('button', { name: '在线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await menu.boundingBox()).toEqual(original);
  await page.setViewportSize({ width: 440, height: 320 });
  await expect.poll(async () => {
    const bounds = await menu.boundingBox();
    return Boolean(bounds && bounds.x >= 7 && bounds.y >= 7
      && bounds.x + bounds.width <= 433 && bounds.y + bounds.height <= 313);
  }).toBe(true);
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await menu.getByRole('button', { name: '退出登录', exact: true }).scrollIntoViewIfNeeded();
  await expect(menu.getByRole('button', { name: '退出登录', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('personal-menu-resized.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('迟到的语音时长使个人面板平滑向上伸展，右边与底边保持固定', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/rtc/voice-time', async route => {
    await pending;
    await route.fulfill({ json: { seconds: 90000 } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu).toHaveCSS('opacity', '1');
  const before = (await menu.boundingBox())!;
  const samples = menu.evaluate(async element => {
    const frames = [];
    for (let frame = 0; frame < 36; frame++) {
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      frames.push({ height: rect.height, bottom: rect.bottom, right: rect.right,
        actionsBottom: element.querySelector('.personal-menu-actions')!.getBoundingClientRect().bottom });
    }
    return frames;
  });
  release();
  await expect(menu).toContainText('累计已与朋友开黑了 25 小时');
  const frames = await samples;
  const after = (await menu.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(frames.some(frame => frame.height > before.height + 1 && frame.height < after.height - 1)).toBe(true);
  for (const frame of frames) {
    expect(frame.bottom).toBeCloseTo(before.y + before.height, 0);
    expect(frame.right).toBeCloseTo(before.x + before.width, 0);
    expect(frame.actionsBottom).toBeCloseTo(before.y + before.height - 13, 0);
  }
  await page.screenshot({ path: test.info().outputPath('personal-menu-stable.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await menu.evaluate(element => getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) === 0))).toBe(true);
  expect(errors).toEqual([]);
});

test('个人菜单退出登录复用认证流程', async ({ page }) => {
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', route => { logoutRequests++; return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await page.getByRole('dialog', { name: '个人菜单', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '退出当前账号？', exact: true });
  await expect(confirmation).toBeVisible();
  expect(logoutRequests).toBe(0);
  await expect(confirmation).toContainText('保留本机凭据');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeFocused();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await page.getByRole('dialog', { name: '个人菜单', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
  await confirmation.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect(logoutRequests).toBe(0);
  await expect(page.getByRole('checkbox', { name: '记住账号', exact: true })).toBeChecked();
  await expect(confirmation).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('account-preview.png') });
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '记住账号', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeVisible();
});

test('账号设置退出也需确认，Esc 取消保留当前页面且不注销', async ({ page }) => {
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', route => { logoutRequests++; return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const exit = page.locator('.account-settings').getByRole('button', { name: '退出登录', exact: true });
  await exit.click();
  const confirmation = page.getByRole('dialog', { name: '退出当前账号？', exact: true });
  await expect(page.locator('.dialog-backdrop')).toHaveCSS('opacity', '1');
  expect(logoutRequests).toBe(0);
  await page.screenshot({ path: test.info().outputPath('logout-confirmation.png') });
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await expect(exit).toBeFocused();
  expect(logoutRequests).toBe(0);
});

test('清除凭据有独立确认，取消保留账号，确认后才撤销', async ({ page }) => {
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', route => { logoutRequests++; return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await page.getByRole('dialog', { name: '个人菜单', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('dialog', { name: '退出当前账号？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByText('更多', { exact: true }).click();
  const clear = page.getByRole('button', { name: '清除本机登录凭据', exact: true });
  await clear.click();
  const confirmation = page.getByRole('dialog', { name: '从此设备移除账号？', exact: true });
  await expect(confirmation).toContainText('再次登录需要已设置的服主恢复密码');
  expect(logoutRequests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(clear).toBeFocused();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await clear.click();
  await confirmation.getByRole('button', { name: '清除登录信息', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(logoutRequests).toBe(1);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0);
});

test('个人菜单沿语音菜单方向展开收起，减少动态效果时跳过位移', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeVisible();
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    const enter = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const menu = document.querySelector<HTMLElement>('.profile-popover.is-personal')!;
      getComputedStyle(menu).transform;
      return menu.getAnimations().flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes())
        .filter(frame => frame.transform).map(frame => new DOMMatrixReadOnly(String(frame.transform)).m42);
    });
    expect(enter.includes(4), JSON.stringify(enter)).toBe(reducedMotion === 'no-preference');
    const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
    await expect(menu).toHaveCSS('opacity', '1');
    await expect(menu).toHaveCSS('transform', 'none');
    const leave = await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const menu = document.querySelector<HTMLElement>('.profile-popover.is-personal');
      if (menu) getComputedStyle(menu).transform;
      return { inert: menu?.inert ?? true, transforms: menu?.getAnimations()
        .flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes())
        .filter(frame => frame.transform).map(frame => new DOMMatrixReadOnly(String(frame.transform)).m42) ?? [] };
    });
    expect(leave.inert).toBe(true);
    expect(leave.transforms.includes(4), JSON.stringify(leave.transforms)).toBe(reducedMotion === 'no-preference');
    await expect(page.locator('.profile-popover.is-personal')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeFocused();
  }
});

test('头像只给卡片头部提供暗色调，快速开关后菜单仍可操作', async ({ page }) => {
  const avatar = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgb(236, 73, 62)';
    context.fillRect(0, 0, 24, 24);
    return canvas.toDataURL('image/png');
  });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { ...user, avatar } }));
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '个人菜单', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu.locator('.profile-popover-banner')).toHaveCSS('background-color', 'rgb(73, 38, 41)');
  await page.keyboard.press('Escape');
  await trigger.click();
  await menu.getByRole('button', { name: '语音与音频', exact: true }).click();
  await expect(page.getByRole('heading', { name: '语音与音频', exact: true })).toBeVisible();
});

test('设置身份菜单选择隐身与主界面同步，首个心跳不短暂在线，切回在线可继续使用', async ({ page }) => {
  const heartbeats: Array<{ status: string; activity: unknown }> = [];
  await page.route('**/api/presence/heartbeat', route => {
    heartbeats.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const trigger = page.getByRole('button', { name: '个人菜单', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  const statusTrigger = menu.getByRole('group', { name: '在线状态', exact: true });
  await selectPersonalPresence(menu, '隐身');
  await expect.poll(() => heartbeats.at(-1)?.status).toBe('OFFLINE');
  await expect(menu.locator('.profile-popover-identity .personal-avatar')).toHaveAttribute('aria-label', '隐身');
  await expect(statusTrigger.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('invisible-menu.png') });
  heartbeats.length = 0;
  await page.reload();
  await expect.poll(() => heartbeats.length).toBeGreaterThan(0);
  expect(heartbeats.every(heartbeat => heartbeat.status === 'OFFLINE' && heartbeat.activity === null)).toBe(true);
  await trigger.click();
  await selectPersonalPresence(menu, '在线');
  await expect.poll(() => heartbeats.at(-1)?.status).toBe('ONLINE');
  await expect(menu.locator('.profile-popover-identity .personal-avatar')).toHaveAttribute('aria-label', '在线');
});

test('状态同步失败在菜单内提示，重试不退出账号或清除选择', async ({ page }) => {
  let fail = false;
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: fail ? 503 : 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  const statusTrigger = menu.getByRole('group', { name: '在线状态', exact: true });
  fail = true;
  await selectPersonalPresence(menu, '隐身');
  await expect(menu.getByRole('alert')).toContainText('尚未同步');
  await expect(statusTrigger.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  fail = false;
  await selectPersonalPresence(menu, '隐身');
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(menu.locator('.profile-popover-identity .personal-avatar')).toHaveAttribute('aria-label', '隐身');
});

test('快捷键录入松开后保存，冲突保持原设置，取消不会丢失绑定', async ({ page }) => {
  await page.addInitScript(() => {
    window.lycanAudioShortcuts = {
      begin: async () => 'mock-owner',
      readHold: async () => false, onHold: () => () => {},
      configure: async (_owner, bindings) => { if (bindings.microphone === 'Ctrl+K') throw new Error('occupied'); },
      activate: async () => {}, capture: async () => {}, end: async () => {}, onAction: () => () => {}, onError: () => () => {},
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  await page.getByRole('dialog', { name: '个人菜单', exact: true }).getByRole('button', { name: '快捷键', exact: true }).click();
  const recorder = page.getByRole('button', { name: '设置麦克风静音／恢复快捷键', exact: true });
  await expect(recorder).toHaveText('未设置');
  const bindingWidth = (await recorder.boundingBox())!.width;
  await recorder.click();
  await expect(recorder).toHaveAttribute('aria-pressed', 'true');
  expect((await recorder.boundingBox())!.width).toBe(bindingWidth);
  await recorder.press('Control+m');
  await expect(recorder).toHaveText('Ctrl+M');
  expect((await recorder.boundingBox())!.width).toBe(bindingWidth);
  expect((await page.getByRole('button', { name: '设置停止／恢复收听快捷键', exact: true }).boundingBox())!.width).toBe(bindingWidth);
  await recorder.click();
  await recorder.press('Control+k');
  await expect(page.getByRole('alert')).toContainText('占用');
  await expect(recorder).toHaveText('Ctrl+M');
  await recorder.click();
  await recorder.press('Escape');
  await expect(recorder).toHaveText('Ctrl+M');
  await page.screenshot({ path: test.info().outputPath('shortcut-settings.png') });
  await page.getByRole('button', { name: '清除麦克风静音／恢复快捷键', exact: true }).click();
  await expect(recorder).toHaveText('未设置');
  const beforeMode = await recorder.boundingBox();
  await page.getByRole('group', { name: '发言模式', exact: true }).getByRole('button', { name: /^按键说话/ }).click();
  await expect(page.locator('.shortcut-settings [role="alert"]')).toHaveText('请先为按键发言设置快捷键');
  await expect(page.getByRole('group', { name: '发言模式', exact: true }).getByRole('button', { name: '自由发言', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await recorder.boundingBox())!.y).toBe(beforeMode!.y);
  await expect(page.locator('.shortcut-settings')).not.toContainText('等待按住快捷键');
  const talk = page.getByRole('button', { name: '设置按键说话快捷键', exact: true });
  await expect(page.getByText('建议搭配 Ctrl、Alt 或 Shift，减少与打字、游戏按键冲突。')).toBeVisible();
  await talk.click();
  await page.keyboard.down(';');
  await expect(talk).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`lycansync.audio-shortcuts.v1.${id}`)!).pushToTalk, user.id)).toBe('');
  await page.keyboard.up(';');
  await expect(talk).toHaveText(';');
  await expect(talk).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.shortcut-settings [role="alert"]')).toHaveCount(0);
  await page.getByRole('group', { name: '发言模式', exact: true }).getByRole('button', { name: /^按键说话/ }).click();
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  await expect(page.getByRole('group', { name: '发言模式', exact: true }).getByRole('button', { name: /^按键说话/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '设置按键说话快捷键', exact: true })).toHaveText(';');
  await page.screenshot({ path: test.info().outputPath('push-to-talk-settings.png') });
  await page.getByRole('group', { name: '发言模式', exact: true }).getByRole('button', { name: '自由发言', exact: true }).click();
});

test('共享与录制入口合并设置，默认画质与共享偏好重开后保持', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'lycanDesktop', { value: {
      getAutoLogin: async () => ({ enabled: true, manualEntryRequired: false }),
      getAccessLink: async () => null, onAccessLink: () => () => {},
      getUpdateState: async () => ({ phase: 'ready', supported: false, version: 'test', message: '' }),
      runStartupUpdate: async () => ({ phase: 'ready', supported: false, version: 'test', message: '' }),
      onUpdateState: () => () => {}, getWindowVisibility: async () => true, onWindowVisibility: () => () => {},
      isMaximized: async () => false, onMaximizedChange: () => () => {}, onViewerClosed: () => () => {}, onClose: () => () => {},
      getSystemIdleState: async () => ({ state: 'active', idleSeconds: 0 }),
      prepareCapture: async () => {}, getProcessMetrics: async () => ({ cpuPercent: 0, memoryMb: 0 }),
      getCurrentActivity: async () => null, onActivityChange: () => () => {},
      getNativeMediaCapabilities: async () => ({ screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' } }),
      setMicrophoneEchoOutput: async () => ({ changed: false }),
      getRecordingSettings: async () => ({ directory: 'test-recordings', applicationAudio: true, microphone: false, friends: false,
        videoHeight: 1080, videoFps: 60, replaySeconds: 60, replayEnabled: localStorage.getItem('test.replayEnabled') === 'true' }),
      configureReplay: async (settings: { enabled?: boolean }) => {
        localStorage.setItem('test.replayEnabled', String(settings.enabled));
        return { directory: 'test-recordings', applicationAudio: true, microphone: false, friends: false,
          videoHeight: 1080, videoFps: 60, replaySeconds: 60, replayEnabled: settings.enabled };
      },
      getRecordingStatus: async () => ({ holdingResources: false, phase: 'idle', recordingId: null, startedAt: null,
        bytes: 0, error: null, saved: false, continuing: false, applicationAudio: true }),
      getRecordingLibrary: async () => {
        const reads = Number(localStorage.getItem('test.libraryReads') ?? 0) + 1;
        localStorage.setItem('test.libraryReads', String(reads));
        if (reads === 1) throw new Error('test read failure');
        return { items: [], hasMore: false };
      },
      onRecordingState: () => () => {},
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '共享与录制', exact: true }).click();
  await expect(page.getByRole('heading', { name: '共享与录制', exact: true })).toBeVisible();
  const presets = page.getByRole('group', { name: '共享画质' });
  await presets.getByRole('button', { name: '高帧率', exact: true }).click();
  await page.getByRole('checkbox', { name: '共享声音', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: /隐藏共享画面中的光标/ }).check();
  const replay = page.getByRole('checkbox', { name: /开启即时回放/ });
  await expect(replay).toBeEnabled();
  await replay.check();
  await expect(page.getByText('已开启，等待共享画面', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '共享与录制', exact: true }).click();
  await expect(presets.getByRole('button', { name: '高帧率', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: '共享声音', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /隐藏共享画面中的光标/ })).toBeChecked();
  await expect(page.getByRole('heading', { name: '录制内容', exact: true })).toBeVisible();
  await expect(page.locator('.settings-recording-page h2')).toHaveText(['共享画面', '共享录制', '文件与画质', '即时回放', '录像管理']);
  await expect(replay).toBeEnabled();
  await expect(replay).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('test.replayEnabled'))).toBe('true');
  await expect(page.getByRole('heading', { name: '当前录像', exact: true })).toHaveCount(0);
  await expect(page.locator('.settings-recording-page').getByRole('button', { name: '开始录制', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lycansync.screen-share-quality')!).quality)).toBe('highFrameRate');
  await page.setViewportSize({ width: 1280, height: 820 });
  const shareTogglePositions = await page.locator('.settings-toggle input[type="checkbox"]:visible').evaluateAll(inputs => inputs.map(input => input.getBoundingClientRect().right));
  expect(shareTogglePositions).toHaveLength(6);
  expect(Math.max(...shareTogglePositions) - Math.min(...shareTogglePositions)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('sharing-and-recording.png') });
  await page.locator('.recording-file-settings').screenshot({ path: testInfo.outputPath('recording-file-settings.png') });
  await page.locator('.settings-block').filter({ has: page.getByRole('heading', { name: '即时回放', exact: true }) })
    .screenshot({ path: testInfo.outputPath('instant-replay-settings.png') });
  expect(await page.evaluate(() => localStorage.getItem('test.libraryReads'))).toBeNull();
  const managerButton = page.getByRole('button', { name: '打开本地录像管理器', exact: true });
  await managerButton.click();
  const manager = page.getByRole('dialog', { name: '本地录像管理器', exact: true });
  await expect(manager).toBeVisible();
  await expect(manager.getByText('无法读取录像列表，请检查安装目录的读写权限后重试。')).toBeVisible();
  await manager.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(manager.getByText('暂无录像记录。旧版保存的录像仍可在录像目录中找到。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('recording-library.png') });
  await page.keyboard.press('Escape');
  await expect(manager).toHaveCount(0);
  await expect(managerButton).toBeFocused();
  await managerButton.click();
  await expect(manager.getByText('暂无录像记录。旧版保存的录像仍可在录像目录中找到。')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test.libraryReads'))).toBe('3');
  await manager.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(manager).toHaveCount(0);
  await expect(managerButton).toBeFocused();
});

test('本机提示音只提供统一音量和逐项开关，重开后恢复，保留入场音效操作', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本机提示音', exact: true })).toBeVisible();
  const muted = page.getByRole('checkbox', { name: '麦克风静音', exact: true });
  await muted.uncheck();
  await page.getByRole('slider', { name: '提示音音量', exact: true }).fill('40');
  await expect(page.getByRole('checkbox', { name: '成员加入语音', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '选择音效', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '自定义音效', exact: true })).toBeVisible();
  const moreSounds = page.getByRole('button', { name: '展开其他 6 项提示音', exact: true });
  await expect(page.getByRole('checkbox', { name: '开始共享', exact: true })).toBeHidden();
  await moreSounds.click();
  const sharingSound = page.getByRole('checkbox', { name: '开始共享', exact: true });
  await expect(sharingSound).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '开始录制', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '结束录制', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '恢复收听', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '停止收听', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Google Material Design', exact: true })).toBeVisible();
  await sharingSound.uncheck();
  await expect.poll(() => page.locator('.sound-settings').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  const soundTogglePositions = await page.locator('.sound-settings input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => input.getBoundingClientRect().right));
  expect(soundTogglePositions).toHaveLength(11);
  expect(Math.max(...soundTogglePositions) - Math.min(...soundTogglePositions)).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath('call-sound-settings.png') });
  await page.getByRole('button', { name: '收起其他提示音', exact: true }).click();
  await expect(sharingSound).toBeHidden();
  await expect.poll(() => page.locator('.sound-settings').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('call-sound-settings-collapsed.png') });
  await moreSounds.click();
  await expect(sharingSound).not.toBeChecked();
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect(muted).not.toBeChecked();
  await expect(page.getByRole('slider', { name: '提示音音量', exact: true })).toHaveValue('40');
  await expect(sharingSound).toBeHidden();
  await moreSounds.click();
  await expect(sharingSound).not.toBeChecked();
});

test('Material 提示音从本地资源解码，设置试听采用确认后的八种配对', async ({ page }) => {
  // 真正解码资源和运行播放节点，但将输出定向到无声设备，不采集任何声音。
  await page.addInitScript(() => {
    const prototype = AudioContext.prototype as AudioContext & { setSinkId: (id: { type: string }) => Promise<void> };
    const setSinkId = prototype.setSinkId;
    prototype.setSinkId = function () { return setSinkId.call(this, { type: 'none' }); };
    const probe = window as unknown as { materialSoundStarts: number };
    probe.materialSoundStarts = 0;
    const createBufferSource = prototype.createBufferSource;
    prototype.createBufferSource = function () {
      const source = createBufferSource.call(this);
      const start = source.start.bind(source);
      source.start = (...args) => { start(...args); probe.materialSoundStarts++; };
      return source;
    };
  });
  const resources: string[] = [];
  page.on('response', response => {
    if (response.url().includes('/sounds/material/') && response.status() === 200) resources.push(response.url().split('/').pop()!);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await page.getByRole('button', { name: '展开其他 6 项提示音', exact: true }).click();
  const events = [
    ['成员加入语音', 'navigation_forward-selection.ogg'], ['成员离开语音', 'navigation_backward-selection.ogg'],
    ['麦克风恢复', 'navigation_forward-selection-minimal.ogg'], ['麦克风静音', 'navigation_backward-selection-minimal.ogg'],
    ['开始共享', 'navigation_selection-complete-celebration.ogg'], ['停止共享', 'alert_error-02.ogg'],
    ['开始录制', 'notification_simple-01.ogg'], ['结束录制', 'navigation-cancel.ogg'],
  ];
  for (const [label, file] of events) {
    const before = await page.evaluate(() => (window as unknown as { materialSoundStarts: number }).materialSoundStarts);
    await page.getByRole('button', { name: `试听${label}`, exact: true }).click();
    await expect.poll(() => resources.includes(file)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { materialSoundStarts: number }).materialSoundStarts)).toBe(before + 1);
    await expect(page.locator('.call-sound-settings [role="alert"]')).toHaveCount(0);
  }
  await page.getByRole('button', { name: '返回应用' }).click();
});

test('设备选择保存在本机，设备丢失明确提示且不换默认，不触发采集', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { testAudioDevices: { deviceId: string; kind: string; label: string }[] };
    state.testAudioDevices = [{ deviceId: 'mic-test', kind: 'audioinput', label: '模拟麦克风' },
      { deviceId: 'speaker-test', kind: 'audiooutput', label: '模拟扬声器' }];
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => state.testAudioDevices });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => { throw new Error('本场景不应采集设备'); } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '语音与音频', exact: true }).click();
  const microphone = page.getByRole('combobox', { name: '麦克风设备', exact: true });
  const speaker = page.getByRole('combobox', { name: '声音输出设备', exact: true });
  await microphone.selectOption('mic-test');
  await speaker.selectOption('speaker-test');
  await expect(microphone).toHaveValue('mic-test');
  await expect(speaker).toHaveValue('speaker-test');
  await page.evaluate(() => {
    (window as unknown as { testAudioDevices: unknown[] }).testAudioDevices = [];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.locator('.audio-settings')).toContainText('所选麦克风不可用');
  await expect(page.locator('.audio-settings')).toContainText('所选扬声器不可用');
  await expect(microphone).toHaveValue('mic-test');
  await expect(speaker).toHaveValue('speaker-test');
  await speaker.selectOption('default');
  await microphone.selectOption('default');
  await expect(speaker).toHaveValue('default');
  await expect(microphone).toHaveValue('default');
  await page.screenshot({ path: test.info().outputPath('audio-device-settings.png') });
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(microphone).toBeVisible();
  const bounds = await microphone.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
  await page.screenshot({ path: test.info().outputPath('audio-device-settings-narrow.png') });
});

test('上传入场音效保存规范 WAV，服务端失败保留旧音效，切栏取消未完成上传', async ({ page }) => {
  const wave = Buffer.alloc(46);
  wave.write('RIFF', 0); wave.write('WAVEfmt ', 8); wave.write('data', 36);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt16LE(16, 34); wave.writeUInt32LE(2, 40);
  let mode: 'success' | 'fail' | 'slow' = 'success';
  let complete: (() => void) | undefined;
  await page.route('**/api/audio/entrance-sound/normalize', async route => {
    expect(route.request().headers()['content-type']).toBe('application/octet-stream');
    if (mode === 'slow') await new Promise<void>(resolve => { complete = resolve; });
    if (mode === 'fail') return route.fulfill({ status: 503, json: { detail: '服务器音效处理暂不可用' } });
    await route.fulfill({ contentType: 'audio/wav', body: wave }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  const input = page.getByLabel('选择入场音效', { exact: true });
  await input.setInputFiles({ name: '打招呼.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('source') });
  await expect(page.locator('.sound-settings')).toContainText('打招呼.wav');
  const saved = await page.evaluate(() => localStorage.getItem('lycansync.entrance-sound.v1.2d983469-4442-44f5-b5a8-f3819f16a611'));
  expect(JSON.parse(saved!).normalization).toBe('rms-v1');
  mode = 'fail';
  await input.setInputFiles({ name: '失败.wav', mimeType: 'audio/wav', buffer: Buffer.from('source') });
  await expect(page.getByRole('alert')).toContainText('暂不可用');
  await expect(page.locator('.sound-settings')).toContainText('打招呼.wav');
  mode = 'slow';
  await input.setInputFiles({ name: '迟到.wav', mimeType: 'audio/wav', buffer: Buffer.from('source') });
  await expect.poll(() => Boolean(complete)).toBe(true);
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  complete!();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect(page.locator('.sound-settings')).toContainText('打招呼.wav');
  expect(await page.evaluate(() => localStorage.getItem('lycansync.entrance-sound.v1.2d983469-4442-44f5-b5a8-f3819f16a611'))).toBe(saved);
});


test('离线资料卡展示冻结的上次在线和最近游戏，在线只展示最近游戏，未知记录省略', async ({ page }) => {
  let status: 'ONLINE' | 'OFFLINE' = 'OFFLINE';
  let known = true;
  await page.route(`**/api/groups/${groupId}/presences`, route => route.fulfill({ json: members.map(member => ({
    userId: member.userId, status: member.userId === friendId ? status : 'ONLINE',
    lastSeenAt: null, activityType: null, activityName: null, activityStartedAt: null,
    lastOnlineAt: known ? new Date(Date.now() - 1800_000).toISOString() : null,
    recentGame: known ? { name: '最终幻想14', endedAt: new Date(Date.now() - 1200_000).toISOString(), playedSeconds: 3600 } : null,
  })) }));
  await page.goto('/');
  const friend = page.getByRole('button', { name: '查看 阿岚 的资料', exact: true });
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await friend.hover();
  await expect(card).toContainText('上次在线：半小时前');
  await expect(card).toContainText('不久前玩了一个多小时的 最终幻想14');
  await expect(card).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('offline-history.png') });
  status = 'ONLINE';
  await page.reload();
  await friend.hover();
  await expect(card).toContainText('不久前玩了一个多小时的 最终幻想14');
  await expect(card).not.toContainText('上次在线');
  known = false;
  status = 'OFFLINE';
  await page.reload();
  await friend.hover();
  await expect(card).toBeVisible();
  await expect(card.locator('.profile-popover-history')).toHaveCount(0);
});

test('动态和上次在线两个开关独立上报，重新打开恢复选择', async ({ page }) => {
  const heartbeats: Array<{ showActivity: boolean; showLastOnline: boolean }> = [];
  await page.route('**/api/presence/heartbeat', route => {
    heartbeats.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const game = page.getByRole('checkbox', { name: '显示动态', exact: true });
  const lastOnline = page.getByRole('checkbox', { name: '显示上次在线时间', exact: true });
  await game.uncheck();
  await expect(lastOnline).toBeChecked();
  await expect.poll(() => heartbeats.at(-1)).toMatchObject({ showActivity: false, showLastOnline: true });
  await lastOnline.uncheck();
  await game.check();
  await expect.poll(() => heartbeats.at(-1)).toMatchObject({ showActivity: true, showLastOnline: false });
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(game).toBeChecked();
  await expect(lastOnline).not.toBeChecked();
  await expect(page.locator('.settings-view')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('presence-visibility-settings.png') });
});

test('关闭动态的心跳尚未返回就退出时，离线请求仍带上最新隐私选择', async ({ page }) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const heartbeats: Array<{ status: string; showActivity: boolean; showLastOnline: boolean }> = [];
  await page.route('**/api/presence/heartbeat', async route => {
    const heartbeat = route.request().postDataJSON();
    heartbeats.push(heartbeat);
    if (heartbeat.status !== 'OFFLINE' && heartbeat.showActivity === false) await pending;
    await route.fulfill({ status: 204 }).catch(() => {});
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('checkbox', { name: '显示动态', exact: true }).uncheck();
    await expect.poll(() => heartbeats.at(-1)).toMatchObject({ status: 'ONLINE', showActivity: false });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('dialog', { name: '退出当前账号？', exact: true })
      .getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect.poll(() => heartbeats.at(-1)).toMatchObject({ status: 'OFFLINE', showActivity: false, showLastOnline: true });
  } finally { release!(); }
});

test('自己语音记录在卡片底部，资料预览仅在保存成功后更新，清空成功才显示默认签名', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/rtc/voice-time', route => route.fulfill({ json: { seconds: 460800 } }));
  let savedSignature = '';
  let failSave = false;
  let releaseSave: (() => void) | undefined;
  await page.route('**/api/auth/me', async route => {
    if (route.request().method() === 'PUT') {
      await new Promise<void>(resolve => { releaseSave = resolve; });
      if (failSave) return route.fulfill({ status: 503, json: { detail: '签名保存失败' } });
      savedSignature = route.request().postDataJSON().signature;
    }
    await route.fulfill({ json: { ...user, signature: savedSignature } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu.locator('.profile-voice-time')).toHaveText('累计已与朋友开黑了 128 小时');
  await expect(menu).toContainText('这只狼暂时没留下什么话。');
  await menu.getByRole('button', { name: '编辑个人资料', exact: true }).click();
  const preview = page.getByRole('region', { name: '资料卡预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.locator('.profile-voice-time')).toHaveText('累计已与朋友开黑了 128 小时');
  const statusSelect = page.getByRole('group', { name: '在线状态', exact: true });
  await expect(statusSelect.getByRole('button', { name: '在线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const mode of ['invisible', 'online']) {
    const heartbeat = page.waitForRequest(request => request.url().endsWith('/api/presence/heartbeat')
      && request.postDataJSON().status === (mode === 'invisible' ? 'OFFLINE' : 'ONLINE'));
    await statusSelect.getByRole('button', { name: mode === 'invisible' ? '隐身' : '在线', exact: true }).click();
    await heartbeat;
    await expect(statusSelect.getByRole('button', { name: mode === 'invisible' ? '隐身' : '在线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  const card = await preview.boundingBox();
  const controls = await page.locator('.activity-settings-controls').boundingBox();
  expect(card!.x + card!.width).toBeLessThan(controls!.x);
  const signature = page.getByRole('textbox', { name: '个性签名', exact: true });
  await signature.fill('新的签名预览');
  await expect(preview).toContainText('这只狼暂时没留下什么话。');
  await signature.blur();
  await expect.poll(() => !!releaseSave).toBe(true);
  await expect(preview).not.toContainText('新的签名预览');
  releaseSave!(); releaseSave = undefined;
  await expect(preview).toContainText('新的签名预览');
  for (const failed of [true, false]) {
    failSave = failed;
    await signature.fill('');
    await expect(preview).toContainText('新的签名预览');
    await signature.blur();
    await expect.poll(() => !!releaseSave).toBe(true);
    await expect(preview).toContainText('新的签名预览');
    releaseSave!(); releaseSave = undefined;
    if (failed) {
      await expect(signature).toHaveValue('新的签名预览');
      await expect(preview).toContainText('新的签名预览');
      await expect(page.locator('#profile-signature-feedback')).toContainText('签名保存失败');
    } else {
      await expect(preview).toContainText('这只狼暂时没留下什么话。');
      expect(savedSignature).toBe('');
      await expect(signature).toHaveValue('');
    }
  }
  await page.screenshot({ path: test.info().outputPath('activity-profile-preview.png') });
  await page.setViewportSize({ width: 800, height: 760 });
  const narrowCard = await preview.boundingBox();
  const narrowControls = await page.locator('.activity-settings-controls').boundingBox();
  expect(narrowCard!.y + narrowCard!.height).toBeLessThan(narrowControls!.y);
});

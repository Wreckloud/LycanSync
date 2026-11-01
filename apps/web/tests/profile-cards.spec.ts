import { expect, test } from '@playwright/test';

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
      userId: url.pathname.split('/').at(-2), signature: '今晚一起玩游戏。',
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
  await expect(menu.getByRole('button', { name: '隐身', exact: true })).toHaveCount(0);
  expect(await footer.boundingBox()).toEqual(bounds);
  await page.screenshot({ path: test.info().outputPath('personal-menu.png') });
  await menu.getByRole('button', { name: '编辑个人资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test('成员悬浮按需读签名，移入卡片保持，Esc 关闭且缓存避免重复读取', async ({ page }) => {
  let requests = 0;
  await page.route(`**/api/groups/${groupId}/members/${friendId}/profile`, route => {
    requests++;
    return route.fulfill({ json: { userId: friendId, signature: '准备打团。' } });
  });
  await page.goto('/');
  expect(requests).toBe(0);
  const friend = page.getByRole('button', { name: '查看 阿岚 的资料', exact: true });
  await friend.hover();
  const card = page.getByRole('dialog', { name: '成员资料', exact: true });
  await expect(card).toContainText('准备打团。');
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

test('已展开资料卡随窗口与内容尺寸变化保持在可视区', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await expect(menu).toHaveCSS('opacity', '1');
  await page.setViewportSize({ width: 440, height: 640 });
  await menu.getByRole('button', { name: '在线状态', exact: true }).click();
  await expect(menu.getByRole('button', { name: '隐身', exact: true })).toBeVisible();
  await expect.poll(async () => {
    const bounds = await menu.boundingBox();
    return Boolean(bounds && bounds.x >= 7 && bounds.y >= 7
      && bounds.x + bounds.width <= 433 && bounds.y + bounds.height <= 633);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('personal-menu-resized.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeFocused();
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
  await expect(page.getByRole('checkbox', { name: '自动登录', exact: true })).toBeChecked();
  await expect(confirmation).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('account-preview.png') });
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '自动登录', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeVisible();
});

test('账号设置退出也需确认，Esc 取消保留当前页面且不注销', async ({ page }) => {
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', route => { logoutRequests++; return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const exit = page.locator('.account-session').getByRole('button', { name: '退出登录', exact: true });
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
  await expect(confirmation).toContainText('服务器维护者协助恢复');
  expect(logoutRequests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(clear).toBeFocused();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await clear.click();
  await confirmation.getByRole('button', { name: '清除凭据', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(logoutRequests).toBe(1);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0);
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

test('个人菜单选择隐身后恢复偏好，首个心跳不短暂在线，切回在线可继续使用', async ({ page }) => {
  const heartbeats: Array<{ status: string; activity: unknown }> = [];
  await page.route('**/api/presence/heartbeat', route => {
    heartbeats.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '个人菜单', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await menu.getByRole('button', { name: '在线状态', exact: true }).click();
  await menu.getByRole('button', { name: '隐身', exact: true }).click();
  await expect.poll(() => heartbeats.at(-1)?.status).toBe('OFFLINE');
  await expect(menu.locator('.profile-popover-identity .personal-avatar')).toHaveAttribute('aria-label', '隐身');
  await expect(menu.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('invisible-menu.png') });
  heartbeats.length = 0;
  await page.reload();
  await expect.poll(() => heartbeats.length).toBeGreaterThan(0);
  expect(heartbeats.every(heartbeat => heartbeat.status === 'OFFLINE' && heartbeat.activity === null)).toBe(true);
  await trigger.click();
  await menu.getByRole('button', { name: '在线状态', exact: true }).click();
  await menu.getByRole('button', { name: '在线', exact: true }).click();
  await expect.poll(() => heartbeats.at(-1)?.status).toBe('ONLINE');
  await expect(menu.locator('.profile-popover-identity .personal-avatar')).toHaveAttribute('aria-label', '在线');
});

test('状态同步失败在菜单内提示，重试不退出账号或清除选择', async ({ page }) => {
  let fail = false;
  await page.route('**/api/presence/heartbeat', route => route.fulfill({ status: fail ? 503 : 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: '个人菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '个人菜单', exact: true });
  await menu.getByRole('button', { name: '在线状态', exact: true }).click();
  fail = true;
  await menu.getByRole('button', { name: '隐身', exact: true }).click();
  await expect(menu.getByRole('alert')).toContainText('尚未确认同步');
  await expect(menu.getByRole('button', { name: '隐身', exact: true })).toHaveAttribute('aria-pressed', 'true');
  fail = false;
  await menu.getByRole('button', { name: '隐身', exact: true }).click();
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
  await recorder.click();
  await expect(recorder).toHaveAttribute('aria-pressed', 'true');
  await recorder.press('Control+m');
  await expect(recorder).toHaveText('Ctrl+M');
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
  await page.getByRole('radio', { name: '按键说话', exact: true }).check();
  await expect(page.locator('.shortcut-settings')).toContainText('设置前保持静音');
  const talk = page.getByRole('button', { name: '设置按键说话快捷键', exact: true });
  await talk.click();
  await talk.press('F2');
  await expect(talk).toHaveText('F2');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  await expect(page.getByRole('radio', { name: '按键说话', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '设置按键说话快捷键', exact: true })).toHaveText('F2');
  await page.screenshot({ path: test.info().outputPath('push-to-talk-settings.png') });
  await page.getByRole('radio', { name: '自由发言', exact: true }).check();
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
  await page.screenshot({ path: test.info().outputPath('call-sound-settings.png') });
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await expect(muted).not.toBeChecked();
  await expect(page.getByRole('slider', { name: '提示音音量', exact: true })).toHaveValue('40');
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

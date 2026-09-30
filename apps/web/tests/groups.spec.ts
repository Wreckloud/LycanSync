import { expect, test, type Route } from '@playwright/test';

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';
const userId = '2d983469-4442-44f5-b5a8-f3819f16a611';
const friendId = 'a1ae7096-049b-46ed-8e62-4f3dd0e7f80d';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function holdPresencePoll(route: Route) {
  const query = new URL(route.request().url()).searchParams;
  if (!query.has('serverInstanceId')) {
    return route.fulfill({ json: {
      serverInstanceId: 'e5965682-9948-41b0-b9cf-c12eeb927e53', version: 0, changed: true,
    } });
  }
  return new Promise<void>(() => {});
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/rtc/room-occupancies', (route) => route.fulfill({ json: [] }));
});

test('创建群组只预览，并直接显示所有已注册账号的头像', async ({ page }) => {
  const user = { id: userId, nickname: '群主', avatar: '', administrator: true };
  const members = [
    { userId, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' },
    { userId: friendId, nickname: '朋友', avatar, role: 'MEMBER', joinedAt: '2026-09-12T01:00:00Z' },
  ];
  const group = { id: groupId, name: '周末开黑', description: '晚上一起玩', avatar: '', role: 'OWNER',
    memberCount: 2, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', members };
  let created = false;
  let tokenRequests = 0;
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/token', (route) => { tokenRequests++; return route.fulfill({ status: 503 }); });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/groups/${groupId}/presence-changes`) return holdPresencePoll(route);
    if (path === '/api/groups' && route.request().method() === 'GET') {
      return route.fulfill({ json: created ? [{ ...group, members: undefined }] : [] });
    }
    if (path === '/api/groups' && route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ name: '周末开黑', description: '晚上一起玩', avatar: '' });
      created = true;
      return route.fulfill({ status: 201, json: group });
    }
    if (path === `/api/groups/${groupId}` && route.request().method() === 'GET') {
      return route.fulfill({ json: group });
    }
    if (path === `/api/groups/${groupId}/messages`) return route.fulfill({ json: { messages: [], hasMore: false } });
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.getByText('还没有群组，点击左侧的 + 创建一个开黑小队。')).toBeVisible();
  const createGroupButton = page.getByRole('button', { name: '创建群组' });
  await createGroupButton.hover();
  await expect(page.getByRole('tooltip')).toHaveText('创建群组');
  const tooltipBox = await page.getByRole('tooltip').boundingBox();
  const buttonBox = await createGroupButton.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThan(buttonBox!.x + buttonBox!.width);
  expect(Math.abs(tooltipBox!.y + tooltipBox!.height / 2 - buttonBox!.y - buttonBox!.height / 2)).toBeLessThanOrEqual(2);
  await createGroupButton.click();
  await page.getByLabel('群组名称').fill('周末开黑');
  await page.getByLabel('群组描述（可选）').fill('晚上一起玩');
  await page.getByRole('dialog', { name: '创建群组' }).getByRole('button', { name: '确定' }).click();
  await expect(page.getByRole('heading', { name: '周末开黑' })).toBeVisible();
  expect(tokenRequests).toBe(0);

  await expect(page.getByRole('complementary', { name: '群组成员' })).toContainText('成员 · 2');
  await expect(page.locator('.group-member-row').filter({ hasText: '朋友' }).locator('img')).toHaveAttribute('src', avatar);
  await expect(page.getByRole('button', { name: '添加群组成员' })).toHaveCount(0);
  expect(tokenRequests).toBe(0);
});

test('创建群组时可选择头像，群组栏显示裁剪后的图片', async ({ page }) => {
  const user = { id: userId, nickname: '群主', avatar: '', administrator: true };
  let createdAvatar = '';
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const group = { id: groupId, name: '头像小队', description: '', avatar: createdAvatar, role: 'OWNER',
      memberCount: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
      members: [{ userId, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' }] };
    if (path === `/api/groups/${groupId}/presence-changes`) return holdPresencePoll(route);
    if (path === '/api/groups' && route.request().method() === 'POST') {
      createdAvatar = route.request().postDataJSON().avatar;
      return route.fulfill({ status: 201, json: { ...group, avatar: createdAvatar } });
    }
    if (path === '/api/groups') return route.fulfill({ json: createdAvatar ? [{ ...group, members: undefined }] : [] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (path === `/api/groups/${groupId}/messages`) return route.fulfill({ json: { messages: [], hasMore: false } });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '创建群组' }).click();
  await page.getByLabel('上传群组头像').setInputFiles({
    name: 'group.png', mimeType: 'image/png', buffer: Buffer.from(avatar.split(',')[1], 'base64'),
  });
  const cropDialog = page.getByRole('dialog', { name: '调整群组头像' });
  await expect(cropDialog.getByAltText('待裁剪头像')).toHaveJSProperty('naturalWidth', 1);
  await cropDialog.getByRole('button', { name: '应用头像' }).click();
  await expect(page.locator('.group-avatar-preview img')).toHaveJSProperty('naturalWidth', 256);
  await page.getByLabel('群组名称').fill('头像小队');
  await page.getByRole('dialog', { name: '创建群组' }).getByRole('button', { name: '确定' }).click();
  expect(createdAvatar).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('.group-rail-avatar')).toHaveAttribute('src', createdAvatar);
  const railButtons = page.locator('.group-rail > button');
  await expect(railButtons.nth(1)).toHaveAttribute('aria-label', '创建群组');
  await expect(railButtons.nth(2)).toHaveAttribute('aria-label', '个人设置');
  await expect(page.getByRole('heading', { name: '头像小队' })).toHaveCSS('user-select', 'none');
  await expect(page.locator('.message-list')).toHaveCSS('user-select', 'none');
  await expect(page.getByLabel('消息内容')).toHaveCSS('cursor', 'text');
});

test('启动、窗口激活和成员变化时自动更新群组，无需刷新按钮', async ({ page }) => {
  const user = { id: userId, nickname: '群主', avatar: '', administrator: true };
  const members = [
    { userId, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' },
    { userId: friendId, nickname: '朋友', avatar, role: 'MEMBER', joinedAt: '2026-09-12T01:00:00Z' },
  ];
  let visible = false;
  let memberCount = 2;
  await page.clock.install();
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const group = { id: groupId, name: '周末开黑', description: '', avatar: '', role: 'OWNER', memberCount,
      createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
    if (path === `/api/groups/${groupId}/presence-changes`) return holdPresencePoll(route);
    if (path === '/api/groups') return route.fulfill({ json: visible ? [group] : [] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: { ...group, members } });
    if (path === `/api/groups/${groupId}/messages`) return route.fulfill({ json: { messages: [], hasMore: false } });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await expect(page.getByText('还没有群组，点击左侧的 + 创建一个开黑小队。')).toBeVisible();
  await expect(page.getByRole('button', { name: /刷新/ })).toHaveCount(0);
  visible = true;
  await page.clock.fastForward(600);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: '周末开黑' })).toBeVisible();
  await expect(page.locator('.group-member-row')).toHaveCount(2);
  await expect(page.locator('.group-member-name').first()).toHaveCSS('font-size', '15px');
  memberCount = 3;
  members.push({ userId: '4e602970-b857-431e-8b44-0aa92818c887', nickname: '新朋友', avatar: '', role: 'MEMBER', joinedAt: '2026-09-13T00:00:00Z' });
  await page.clock.fastForward(30_000);
  await expect(page.locator('.group-member-row')).toHaveCount(3);
  members[1].nickname = '新昵称';
  await page.clock.fastForward(600);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.group-member-row').filter({ hasText: '新昵称' })).toBeVisible();
});

test('离线成员稳定后置，语音状态不混入活动展示', async ({ page }) => {
  const user = { id: userId, nickname: '群主', avatar: '', administrator: true };
  const awayId = '4e602970-b857-431e-8b44-0aa92818c887';
  const offlineId = 'a093dddf-70a3-4bb1-a43b-b3ac5c437cc6';
  const members = [
    { userId, nickname: '群主', avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' },
    { userId: friendId, nickname: '语音朋友', avatar, role: 'MEMBER', joinedAt: '2026-09-12T01:00:00Z' },
    { userId: offlineId, nickname: '离线朋友', avatar, role: 'MEMBER', joinedAt: '2026-09-12T01:30:00Z' },
    { userId: awayId, nickname: '游戏中', avatar: '', role: 'MEMBER', joinedAt: '2026-09-12T02:00:00Z' },
  ];
  const group = { id: groupId, name: '周末开黑', description: '', avatar: '', role: 'OWNER', memberCount: 4,
    createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', members };
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 1,
    participants: [{ participantIdentity: `user-${friendId}`, displayName: '语音朋友' }] } }));
  await page.route('**/api/rtc/room-occupancies', (route) => route.fulfill({
    json: [{ groupId, participantCount: 1 }],
  }));
  await page.route('**/api/groups**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/groups/${groupId}/presence-changes`) return holdPresencePoll(route);
    if (path === '/api/groups') return route.fulfill({ json: [{ ...group, members: undefined }] });
    if (path === `/api/groups/${groupId}/presences`) return route.fulfill({ json: [
      { userId, status: 'ONLINE', lastSeenAt: '2026-09-25T10:00:00Z', activityType: null, activityName: null, activityStartedAt: null },
      { userId: friendId, status: 'OFFLINE', lastSeenAt: '2026-09-24T10:15:00Z', activityType: null, activityName: null, activityStartedAt: null },
      { userId: offlineId, status: 'OFFLINE', lastSeenAt: null, activityType: null, activityName: null, activityStartedAt: null },
      { userId: awayId, status: 'AWAY', activityType: 'GAME', activityName: 'Core Keeper',
        lastSeenAt: '2026-09-25T10:00:00Z', activityStartedAt: new Date(Date.now() - 70_000).toISOString() },
    ] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (path === `/api/groups/${groupId}/messages`) return route.fulfill({ json: { messages: [], hasMore: false } });
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.locator('.group-member-name')).toHaveText(['群主群主', '游戏中', '语音朋友', '离线朋友']);
  await expect(page.getByLabel('群组成员').getByText('语音中', { exact: true })).toHaveCount(0);
  await expect(page.locator('.group-member-row').nth(1)).toContainText('正在玩 Core Keeper');
  await expect(page.locator('.group-member-row').nth(1).locator('.status-dot')).toHaveClass(/AWAY/);
  await expect(page.locator('.group-member-row').nth(2).locator('.status-dot')).toHaveCount(0);
  await page.locator('.group-member-row').nth(2).hover();
  await expect(page.getByRole('tooltip')).toContainText('最后在线：');
  await expect(page.getByRole('tooltip')).toContainText('2026');
  await page.locator('.group-member-row').nth(3).hover();
  await expect(page.getByRole('tooltip')).toHaveText('最后在线：暂无记录');
  await expect(page.locator('.group-member-avatar').first()).toHaveCSS('width', '32px');
  await expect(page.locator('.group-member-name').first()).toHaveCSS('font-size', '15px');
  await expect(page.locator('.member-activity').first()).toHaveCSS('font-size', '13px');
  await expect(page.locator('.group-call-badge')).toBeVisible();
  await expect(page.locator('.group-call-badge')).toHaveCSS('width', '20px');
  await expect(page.locator('.group-call-badge')).toHaveCSS('top', '-5px');
});

test('群成员状态长轮询变化后立即刷新完整快照', async ({ page }) => {
  const user = { id: userId, nickname: '群主', avatar: '', administrator: true };
  const members = [
    { userId, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' },
    { userId: friendId, nickname: '朋友', avatar: '', role: 'MEMBER', joinedAt: '2026-09-12T01:00:00Z' },
  ];
  const group = { id: groupId, name: '通知小队', description: '', avatar: '', role: 'OWNER', memberCount: 2,
    createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', members };
  const serverInstanceId = 'e5965682-9948-41b0-b9cf-c12eeb927e53';
  let version = 0;
  let friendStatus = 'OFFLINE';
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  const pollStartedPromise = new Promise<void>((resolve) => { pollStarted = resolve; });
  const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
  let heldPoll = false;

  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/rtc/room-occupancies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/groups**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/groups') return route.fulfill({ json: [{ ...group, members: undefined }] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (path === `/api/groups/${groupId}/presences`) return route.fulfill({ json: [
      { userId, status: 'ONLINE', lastSeenAt: new Date().toISOString(), activityType: null, activityName: null, activityStartedAt: null },
      { userId: friendId, status: friendStatus, lastSeenAt: new Date().toISOString(), activityType: null, activityName: null, activityStartedAt: null },
    ] });
    if (path === `/api/groups/${groupId}/presence-changes`) {
      const query = new URL(route.request().url()).searchParams;
      if (!query.has('serverInstanceId')) {
        return route.fulfill({ json: { serverInstanceId, version, changed: true } });
      }
      if (Number(query.get('version')) < version) {
        return route.fulfill({ json: { serverInstanceId, version, changed: true } });
      }
      if (!heldPoll) {
        heldPoll = true;
        pollStarted();
        await pollGate;
        return route.fulfill({ json: { serverInstanceId, version, changed: true } });
      }
      return new Promise<void>(() => {});
    }
    if (path === `/api/groups/${groupId}/messages`) return route.fulfill({ json: { messages: [], hasMore: false } });
    return route.fulfill({ status: 404 });
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '通知小队' })).toBeVisible();
    await expect(page.locator('.group-member-row').filter({ hasText: '朋友' })).toHaveCount(1);
    await expect(page.locator('.group-member-row').filter({ hasText: '朋友' }).locator('.status-dot')).toHaveCount(0);
    await pollStartedPromise;

    version = 1;
    friendStatus = 'AWAY';
    releasePoll();

    await expect(page.locator('.group-member-row').filter({ hasText: '朋友' }).locator('.status-dot')).toHaveClass(/AWAY/);
    await expect(page.locator('.group-member-row').filter({ hasText: '朋友' })).toContainText('朋友');
  } finally {
    releasePoll();
  }
});

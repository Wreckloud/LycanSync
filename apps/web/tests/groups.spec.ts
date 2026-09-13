import { expect, test } from '@playwright/test';

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';
const userId = '2d983469-4442-44f5-b5a8-f3819f16a611';
const friendId = 'a1ae7096-049b-46ed-8e62-4f3dd0e7f80d';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  await page.route('**/api/rtc/token', (route) => { tokenRequests++; return route.fulfill({ status: 503 }); });
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.getByText('还没有群组，点击左侧的 + 创建一个开黑小队。')).toBeVisible();
  await page.getByRole('button', { name: '创建群组' }).click();
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
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const group = { id: groupId, name: '头像小队', description: '', avatar: createdAvatar, role: 'OWNER',
      memberCount: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
      members: [{ userId, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' }] };
    if (path === '/api/groups' && route.request().method() === 'POST') {
      createdAvatar = route.request().postDataJSON().avatar;
      return route.fulfill({ status: 201, json: { ...group, avatar: createdAvatar } });
    }
    if (path === '/api/groups') return route.fulfill({ json: createdAvatar ? [{ ...group, members: undefined }] : [] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
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
  await expect(page.locator('.message-list')).toHaveCSS('user-select', 'text');
  await expect(page.getByLabel('消息内容')).toHaveCSS('cursor', 'default');
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
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const group = { id: groupId, name: '周末开黑', description: '', avatar: '', role: 'OWNER', memberCount,
      createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
    if (path === '/api/groups') return route.fulfill({ json: visible ? [group] : [] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: { ...group, members } });
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
  await page.clock.fastForward(15_000);
  await expect(page.locator('.group-member-row')).toHaveCount(3);
  members[1].nickname = '新昵称';
  await page.clock.fastForward(600);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.group-member-row').filter({ hasText: '新昵称' })).toBeVisible();
});

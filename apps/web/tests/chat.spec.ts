import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/rtc/room-occupancies', (route) => route.fulfill({ json: [] }));
});

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';
const user = { id: '2d983469-4442-44f5-b5a8-f3819f16a611', nickname: '群主', avatar: '', administrator: true };
const group = { id: groupId, name: '周末开黑', description: '', avatar: '', role: 'OWNER', memberCount: 1,
  createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
  members: [{ userId: user.id, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' }] };

test('文本消息使用统一 multipart 接口发送，并按日期分组且仅允许消息正文复制', async ({ page }) => {
  const messages: Record<string, unknown>[] = [
    { id: '19b81ea9-04d8-45f7-9407-808c13a51fd0', senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: '第一天', createdAt: '2026-09-13T04:00:00Z', attachment: null },
    { id: '9350a7c7-5391-44f8-8b26-27f548c88793', senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: '第二天', createdAt: '2026-09-14T04:00:00Z', attachment: null },
    { id: '6ec8f0bc-3be7-4529-968f-a498f035f984', senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: '连续消息', createdAt: '2026-09-14T04:02:00Z', attachment: null },
    { id: 'f6c5ae06-c726-47d5-a4ed-96f73cd20899', senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: '间隔后的消息', createdAt: '2026-09-14T04:08:00Z', attachment: null },
  ];
  await page.addInitScript(() => {
    Object.defineProperty(window, 'lycanDesktop', { value: {
      clearSession: async () => undefined,
      minimize: () => undefined,
      isMaximized: async () => false,
      getProcessMetrics: async () => ({ cpuPercent: 0, memoryMb: 0 }),
      getSystemIdleState: async () => ({ state: 'active', idleSeconds: 0 }),
      getCurrentActivity: async () => null,
      onActivityChange: () => () => undefined,
      toggleMaximize: () => undefined,
      onMaximizedChange: () => () => undefined,
      close: () => undefined,
      finishClose: () => undefined,
      openExternal: async (url: string) => { document.documentElement.dataset.externalUrl = url; },
      selectSource: () => undefined,
      onSources: () => () => undefined,
      onClose: () => () => undefined,
    } });
  });
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/groups') return route.fulfill({ json: [group] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (path === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages, hasMore: false } });
    }
    if (path === `/api/groups/${groupId}/messages` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      if (!String(headers['content-type']).includes('multipart/form-data')) {
        throw new Error('文本消息必须使用 multipart/form-data 发送：' + JSON.stringify(headers));
      }
      if (!String(request.postData()).includes('晚上见')) throw new Error('消息文本未包含在 multipart 请求中');
      const message = { id: '6eff1bc9-1f63-4bb1-ad77-698c3bdc9c6c', senderUserId: user.id,
        senderNickname: user.nickname, type: 'TEXT', content: '晚上见 https://example.com/docs。', createdAt: '2026-09-14T12:00:00Z', attachment: null };
      messages.push(message);
      return route.fulfill({ status: 201, json: message });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const composer = page.getByLabel('消息内容');
  await composer.fill('晚上见');
  await composer.press('Enter');
  await expect(page.locator('.chat-message-content').last()).toHaveText('晚上见 https://example.com/docs。');
  await expect(page.locator('.chat-date-divider')).toHaveText(['2026年9月13日', '2026年9月14日']);
  await expect(page.locator('.chat-message-meta')).toHaveCount(4);
  await expect(page.locator('.chat-message.is-grouped')).toHaveCount(1);
  await expect(page.locator('.chat-message-meta time').nth(1)).toHaveText('9月14日 12:00');
  const link = page.getByRole('link', { name: 'https://example.com/docs' });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await link.click();
  await expect(page.locator('html')).toHaveAttribute('data-external-url', 'https://example.com/docs');
  await expect(page.locator('.message-list')).toHaveCSS('user-select', 'none');
  await expect(page.locator('.chat-message-content').first()).toHaveCSS('user-select', 'text');
});

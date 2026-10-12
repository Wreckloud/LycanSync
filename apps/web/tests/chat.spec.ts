import { expect, test, type Page } from '@playwright/test';
import type { ChatMessage } from '../src/chat/chatApi';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/presence/heartbeat', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/rtc/room-occupancies', (route) => route.fulfill({ json: [] }));
});

const groupId = '01b08c29-d1e5-4bca-987f-64946541e93b';
const user = { id: '2d983469-4442-44f5-b5a8-f3819f16a611', nickname: '群主', avatar: '', administrator: true };
const group = { id: groupId, name: '周末开黑', description: '', avatar: '', role: 'OWNER', memberCount: 1,
  createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
  members: [{ userId: user.id, nickname: user.nickname, avatar: '', role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' }] };

function chatMessage(number: number, prefix = 'A'): ChatMessage {
  return { id: `${prefix}${String(number).padStart(2, '0')}`, senderUserId: user.id,
    senderNickname: user.nickname, type: 'TEXT', content: `${prefix}消息 ${number}`,
    createdAt: new Date(Date.UTC(2026, 8, 14, 0, 0, number)).toISOString(), attachment: null };
}

function imageMessage(number: number, attachmentId: string, width = 1600, height = 900, prefix = 'A'): ChatMessage {
  return { ...chatMessage(number, prefix), type: 'IMAGE', content: '',
    attachment: { id: attachmentId, contentType: 'image/png', width, height, byteSize: 68 } };
}

function fileMessage(id: string, attachmentId: string, fileName: string, content = ''): ChatMessage {
  return { id, senderUserId: user.id, senderNickname: user.nickname, type: 'FILE', content,
    createdAt: '2026-09-14T12:00:00Z', attachment: {
      id: attachmentId, contentType: 'application/octet-stream', byteSize: 3, fileName,
    } };
}

async function mockChatShell(page: Page) {
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
}

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
      onClose: () => () => undefined,
    } });
  });
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
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
      if (String(request.postData()).includes('触发错误')) {
        return route.fulfill({ status: 500, json: { code: 'CHAT_SEND_FAILED', detail: '消息发送失败' } });
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

  const composerBoundsBeforeError = await page.locator('.composer').boundingBox();
  await composer.fill('触发错误');
  await composer.press('Enter');
  const chatError = page.getByRole('alert');
  await expect(chatError).toHaveText('消息发送失败');
  const composerBoundsAfterError = await page.locator('.composer').boundingBox();
  const errorBounds = await chatError.boundingBox();
  expect(composerBoundsAfterError).toEqual(composerBoundsBeforeError);
  expect(errorBounds!.y + errorBounds!.height).toBeLessThanOrEqual(composerBoundsAfterError!.y);
});

test('触顶只取一页旧消息，与新消息轮询并行，去重并保持阅读位置', async ({ page }) => {
  await mockChatShell(page);
  const initial = Array.from({ length: 30 }, (_, index) => chatMessage(index + 31));
  const older = Array.from({ length: 29 }, (_, index) => chatMessage(index + 2));
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const beforeCursors: string[] = [];
  await page.route('**/api/groups**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      const before = url.searchParams.get('beforeMessageId');
      if (before) {
        beforeCursors.push(before);
        await historyGate;
        return route.fulfill({ json: { messages: [...older, initial[0]], hasMore: true } });
      }
      if (url.searchParams.get('afterMessageId')) {
        return route.fulfill({ json: { messages: [initial.at(-1), chatMessage(61)], hasMore: false } });
      }
      return route.fulfill({ json: { messages: initial, hasMore: true } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const list = page.locator('.message-list');
  await expect(page.locator('[data-message-id="A60"]')).toHaveCount(1);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => beforeCursors).toEqual(['A31']);
  await list.dispatchEvent('wheel', { deltaY: -100 });
  expect(beforeCursors).toEqual(['A31']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-message-id="A61"]')).toHaveCount(1);
  const anchor = page.locator('[data-message-id="A31"]');
  const anchorTop = (await anchor.boundingBox())!.y;
  releaseHistory();
  await expect(page.locator('[data-message-id="A02"]')).toHaveCount(1);
  await expect(page.locator('.chat-message')).toHaveCount(60);
  await expect(page.locator('.chat-message').first()).toHaveAttribute('data-message-id', 'A02');
  await expect(page.locator('.chat-message').last()).toHaveAttribute('data-message-id', 'A61');
  expect(beforeCursors).toEqual(['A31']);
  expect(Math.abs((await anchor.boundingBox())!.y - anchorTop)).toBeLessThanOrEqual(2);
});

test('空频道恢复后更新历史分页状态，带游标轮询不清除它', async ({ page }) => {
  await mockChatShell(page);
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(window, 'setTestVisibility', {
      value: (state: DocumentVisibilityState) => {
        visibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });
  const latest = Array.from({ length: 30 }, (_, index) => chatMessage(index + 31));
  const older = Array.from({ length: 30 }, (_, index) => chatMessage(index + 1));
  let messagesAvailable = false;
  let emptyCursorRequests = 0;
  let releaseSecondEmptyPoll!: () => void;
  const secondEmptyPollGate = new Promise<void>((resolve) => { releaseSecondEmptyPoll = resolve; });
  let afterCursors = 0;
  const beforeCursors: string[] = [];
  await page.route('**/api/groups**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      const before = url.searchParams.get('beforeMessageId');
      if (before) {
        beforeCursors.push(before);
        return route.fulfill({ json: { messages: older, hasMore: false } });
      }
      if (url.searchParams.has('afterMessageId')) {
        afterCursors++;
        return route.fulfill({ json: { messages: [chatMessage(61)], hasMore: false } });
      }
      emptyCursorRequests++;
      if (emptyCursorRequests === 2) {
        await secondEmptyPollGate;
        try { await route.fulfill({ json: { messages: [], hasMore: false } }); }
        catch { /* The request is canceled when the tab becomes hidden. */ }
        return;
      }
      return route.fulfill({ json: { messages: messagesAvailable ? latest : [], hasMore: messagesAvailable } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  // The next scheduled poll proves the initial empty response has been handled by the component.
  await expect.poll(() => emptyCursorRequests).toBe(2);
  await page.evaluate(() => (window as unknown as Window & { setTestVisibility: (state: DocumentVisibilityState) => void })
    .setTestVisibility('hidden'));
  releaseSecondEmptyPoll();
  messagesAvailable = true;
  await page.evaluate(() => (window as unknown as Window & { setTestVisibility: (state: DocumentVisibilityState) => void })
    .setTestVisibility('visible'));
  await expect(page.locator('[data-message-id="A60"]')).toHaveCount(1);
  await expect.poll(() => emptyCursorRequests).toBe(3);
  await expect.poll(() => afterCursors).toBe(1);
  await expect(page.locator('[data-message-id="A61"]')).toBeVisible();
  const list = page.locator('.message-list');
  await list.evaluate((element) => { element.scrollTop = 0; });
  await list.dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('[data-message-id="A01"]')).toHaveCount(1);
  expect(beforeCursors).toEqual(['A31']);
});

test('历史图片接近列表可视区才加载，窄窗口保留比例且来回滚动不重复请求', async ({ page }) => {
  await mockChatShell(page);
  await page.setViewportSize({ width: 360, height: 760 });
  const initial = [imageMessage(31, 'offscreen-wide', 1600, 400),
    ...Array.from({ length: 29 }, (_, index) => chatMessage(index + 32))];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let imageRequests = 0;
  await page.route('**/api/groups**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/attachments/offscreen-wide`) {
      imageRequests++;
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : initial, hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const list = page.locator('.message-list');
  const article = page.locator('[data-message-id="A31"]');
  const frame = article.locator('.chat-image-frame');
  await expect(page.locator('[data-message-id="A60"]')).toHaveCount(1);
  const listBounds = await list.boundingBox();
  const offscreenBounds = await frame.boundingBox();
  expect(offscreenBounds!.y + offscreenBounds!.height).toBeLessThan(listBounds!.y - 180);
  expect(imageRequests).toBe(0);

  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => imageRequests).toBe(1);
  await expect(article.getByAltText('群主 发送的图片')).toHaveJSProperty('naturalWidth', 1);
  const imageBounds = await frame.boundingBox();
  const bodyBounds = await article.locator('.chat-message-body').boundingBox();
  expect(imageBounds!.width).toBeLessThanOrEqual(420);
  expect(imageBounds!.width).toBeLessThanOrEqual(bodyBounds!.width + 1);
  expect(imageBounds!.height).toBeLessThanOrEqual(340);
  expect(Math.abs(imageBounds!.width / imageBounds!.height - 4)).toBeLessThan(0.03);

  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect(article.getByAltText('群主 发送的图片')).toBeVisible();
  expect(imageRequests).toBe(1);
});

test('切换群组会取消未完成的图片请求并释放已创建的 Blob URL', async ({ page }) => {
  await mockChatShell(page);
  await page.addInitScript(() => {
    const urls = { created: [] as string[], revoked: [] as string[] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.revoked.push(url);
      revoke(url);
    };
    Object.defineProperty(window, '__chatImageUrls', { value: urls });
  });
  const otherGroup = { ...group, id: 'f45d69f7-ea7d-4a4f-b0bb-b17d91b78dc2', name: '第二群组' };
  const initial = [chatMessage(1), imageMessage(2, 'loaded-image'), imageMessage(3, 'pending-image')];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let releasePending!: () => void;
  const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
  let finishPendingHandler!: () => void;
  const pendingHandler = new Promise<void>((resolve) => { finishPendingHandler = resolve; });
  let pendingStarted = false;
  let pendingAborted = false;
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/attachments/pending-image')) pendingAborted = true;
  });
  await page.route('**/api/groups**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group, otherGroup] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${otherGroup.id}`) return route.fulfill({ json: otherGroup });
    if (url.pathname === `/api/groups/${otherGroup.id}/messages`) {
      return route.fulfill({ json: { messages: [chatMessage(1, 'B')], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/attachments/loaded-image`) {
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    if (url.pathname === `/api/groups/${groupId}/attachments/pending-image`) {
      pendingStarted = true;
      await pendingGate;
      try { await route.fulfill({ contentType: 'image/png', body: png }); }
      catch { /* The image request is canceled when the old group is unmounted. */ }
      finally { finishPendingHandler(); }
      return;
    }
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      return route.fulfill({ json: { messages: initial, hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.locator('.chat-image-frame')).toHaveCount(2);
  await expect(page.getByAltText('群主 发送的图片')).toHaveCount(1);
  await expect(page.getByAltText('群主 发送的图片')).toHaveJSProperty('naturalWidth', 1);
  await expect.poll(() => pendingStarted).toBe(true);
  const createdUrls = await page.evaluate(() =>
    (window as unknown as Window & { __chatImageUrls: { created: string[] } }).__chatImageUrls.created);
  expect(createdUrls).toHaveLength(1);

  await page.getByRole('button', { name: /第二群组，单击预览/ }).click();
  await expect(page.locator('[data-message-id="B01"]')).toHaveCount(1);
  await expect.poll(() => pendingAborted).toBe(true);
  const revokedUrls = await page.evaluate(() =>
    (window as unknown as Window & { __chatImageUrls: { revoked: string[] } }).__chatImageUrls.revoked);
  expect(revokedUrls).toContain(createdUrls[0]);
  releasePending();
  await pendingHandler;
});

test('图片加载失败只在用户重试时再次请求', async ({ page }) => {
  await mockChatShell(page);
  const image = imageMessage(1, 'retry-image');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let imageRequests = 0;
  await page.route('**/api/groups**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : [image], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/attachments/retry-image`) {
      imageRequests++;
      return imageRequests === 1 ? route.fulfill({ status: 503 })
        : route.fulfill({ contentType: 'image/png', body: png });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const retry = page.getByRole('button', { name: '图片加载失败，点击重试' });
  await expect(retry).toBeVisible();
  await page.waitForTimeout(2200);
  expect(imageRequests).toBe(1);
  await retry.click();
  await expect(page.getByAltText('群主 发送的图片')).toHaveJSProperty('naturalWidth', 1);
  expect(imageRequests).toBe(2);
});

test('历史请求失败可重试，到底后不再请求更早消息', async ({ page }) => {
  await mockChatShell(page);
  const initial = Array.from({ length: 30 }, (_, index) => chatMessage(index + 31));
  const older = Array.from({ length: 30 }, (_, index) => chatMessage(index + 1));
  let historyRequests = 0;
  await page.route('**/api/groups**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      if (url.searchParams.has('beforeMessageId')) {
        historyRequests++;
        return historyRequests === 1
          ? route.fulfill({ status: 503, json: { code: 'TEMPORARY', detail: '历史读取失败' } })
          : route.fulfill({ json: { messages: older, hasMore: false } });
      }
      return route.fulfill({ json: { messages: initial, hasMore: true } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const list = page.locator('.message-list');
  await expect(page.locator('[data-message-id="A60"]')).toHaveCount(1);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator('.chat-error')).toHaveText('历史读取失败');
  expect(historyRequests).toBe(1);
  await list.dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('[data-message-id="A01"]')).toHaveCount(1);
  await expect(page.locator('.chat-error')).toHaveCount(0);
  await list.evaluate((element) => { element.scrollTop = 0; });
  await list.dispatchEvent('wheel', { deltaY: -100 });
  expect(historyRequests).toBe(2);
});

test('切换群组时取消旧群组的历史与轮询请求，迟到响应不会串入新群组', async ({ page }) => {
  await mockChatShell(page);
  const otherGroup = { ...group, id: 'f45d69f7-ea7d-4a4f-b0bb-b17d91b78dc2', name: '第二群组' };
  const initial = Array.from({ length: 30 }, (_, index) => chatMessage(index + 31));
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  let releasePoll!: () => void;
  const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
  let historySettled!: () => void;
  const historyFinished = new Promise<void>((resolve) => { historySettled = resolve; });
  let historyRequests = 0;
  let pollRequests = 0;
  let pollFinishedCount = 0;
  await page.route('**/api/groups**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group, otherGroup] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${otherGroup.id}`) return route.fulfill({ json: otherGroup });
    if (url.pathname === `/api/groups/${otherGroup.id}/messages`) {
      return route.fulfill({ json: { messages: [chatMessage(1, 'B')], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      if (url.searchParams.has('beforeMessageId')) {
        historyRequests++;
        await historyGate;
        try { await route.fulfill({ json: { messages: [chatMessage(30)], hasMore: false } }); }
        catch { /* The request may already be canceled by the group switch. */ }
        finally { historySettled(); }
        return;
      }
      if (url.searchParams.has('afterMessageId')) {
        pollRequests++;
        await pollGate;
        try { await route.fulfill({ json: { messages: [chatMessage(61)], hasMore: false } }); }
        catch { /* The request may already be canceled by the group switch. */ }
        finally { pollFinishedCount++; }
        return;
      }
      return route.fulfill({ json: { messages: initial, hasMore: true } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.locator('[data-message-id="A60"]')).toHaveCount(1);
  const list = page.locator('.message-list');
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => historyRequests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => pollRequests).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: /第二群组，单击预览/ }).click();
  await expect(page.locator('[data-message-id="B01"]')).toHaveCount(1);
  releaseHistory();
  releasePoll();
  await historyFinished;
  await expect.poll(() => pollFinishedCount).toBe(pollRequests);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator('.chat-message')).toHaveCount(1);
  await expect(page.locator('[data-message-id^="A"]')).toHaveCount(0);
});

test('加号多选按原始字节和顺序发送，图片作为文件并只在第一条附带文字', async ({ page }) => {
  await mockChatShell(page);
  const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const uploaded: { name: string; bytes: Buffer; content: string }[] = [];
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      const content = Buffer.from(headers['x-message-content'] ?? '', 'base64url').toString('utf8');
      uploaded.push({ name, bytes: request.postDataBuffer()!, content });
      const message = fileMessage(`F${uploaded.length}`, String(headers['x-upload-id']), name, content);
      message.attachment!.byteSize = request.postDataBuffer()!.length;
      return route.fulfill({ status: 201, json: message });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.getByLabel('消息内容').fill('附在第一条');
  await page.locator('input[type="file"]').setInputFiles([
    { name: '原图.png', mimeType: 'image/png', buffer: originalPng },
    { name: '资料.dat', mimeType: 'application/x-custom', buffer: Buffer.from([9, 8, 7]) },
  ]);
  await expect(page.locator('.composer-attachment')).toHaveCount(2);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-message-id="F2"]')).toHaveCount(1);
  expect(uploaded.map((item) => item.name)).toEqual(['原图.png', '资料.dat']);
  expect(uploaded.map((item) => [...item.bytes])).toEqual([[...originalPng], [9, 8, 7]]);
  expect(uploaded.map((item) => item.content)).toEqual(['附在第一条', '']);
  await expect(page.locator('.chat-file-card')).toHaveCount(2);
});

test('批量文件失败后重试只再次发送失败项', async ({ page }) => {
  await mockChatShell(page);
  const requests = new Map<string, number>();
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      const count = (requests.get(name) ?? 0) + 1;
      requests.set(name, count);
      if (name === 'second.bin' && count === 1) {
        return route.fulfill({ status: 503, json: { code: 'TEMPORARY', detail: '上传失败' } });
      }
      const message = fileMessage(`F-${name}`, String(headers['x-upload-id']), name);
      return route.fulfill({ status: 201, json: message });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'first.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) },
    { name: 'second.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([2]) },
  ]);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('上传失败')).toBeVisible();
  expect(requests.get('first.bin')).toBe(1);
  expect(requests.get('second.bin')).toBe(1);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-message-id="F-second.bin"]')).toHaveCount(1);
  expect(requests.get('first.bin')).toBe(1);
  expect(requests.get('second.bin')).toBe(2);
});

test('首个文件发送期间移除后续文件后不会再上传该文件', async ({ page }) => {
  await mockChatShell(page);
  const uploaded: string[] = [];
  let firstUploadStarted = false;
  let secondUploadStarted = false;
  let releaseFirstUpload!: () => void;
  let releaseSecondUpload!: () => void;
  let finishFirstUpload!: () => void;
  let finishSecondUpload!: () => void;
  const firstUploadGate = new Promise<void>((resolve) => { releaseFirstUpload = resolve; });
  const secondUploadGate = new Promise<void>((resolve) => { releaseSecondUpload = resolve; });
  const firstUploadFinished = new Promise<void>((resolve) => { finishFirstUpload = resolve; });
  const secondUploadFinished = new Promise<void>((resolve) => { finishSecondUpload = resolve; });

  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      uploaded.push(name);
      if (name === 'first.bin') {
        firstUploadStarted = true;
        await firstUploadGate;
        try { await route.fulfill({ status: 201, json: fileMessage('F-first', 'first-attachment', name) }); }
        catch { /* The page may close while the request is being completed. */ }
        finally { finishFirstUpload(); }
        return;
      }
      secondUploadStarted = true;
      await secondUploadGate;
      try { await route.fulfill({ status: 201, json: fileMessage('F-second', 'second-attachment', name) }); }
      catch { /* The page may close while the request is being completed. */ }
      finally { finishSecondUpload(); }
      return;
    }
    return route.fulfill({ status: 404 });
  });

  try {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'first.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) },
      { name: 'second.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([2]) },
    ]);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect.poll(() => uploaded).toEqual(['first.bin']);
    await page.getByRole('button', { name: '移除 second.bin' }).click();

    releaseFirstUpload();
    await expect(page.locator('[data-message-id="F-first"]')).toHaveCount(1);
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    expect(uploaded).toEqual(['first.bin']);
    await firstUploadFinished;
  } finally {
    releaseFirstUpload();
    releaseSecondUpload();
    if (firstUploadStarted) await firstUploadFinished;
    if (secondUploadStarted) await secondUploadFinished;
  }
});

test('混合拖入按原顺序逐项压缩图片并原样发送其他文件', async ({ page }) => {
  await mockChatShell(page);
  const order: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'POST') {
      order.push('image');
      const message: ChatMessage = { ...chatMessage(1), type: 'IMAGE', content: '说明',
        attachment: { id: 'image-attachment', contentType: 'image/png', width: 1, height: 1, byteSize: png.length } };
      return route.fulfill({ status: 201, json: message });
    }
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      order.push(Buffer.from(headers['x-file-name'], 'base64url').toString('utf8'));
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      return route.fulfill({ status: 201, json: fileMessage('F-mixed', 'file-attachment', name) });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.getByLabel('消息内容').fill('说明');
  await page.locator('.chat-panel').evaluate((panel, encodedPng) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(encodedPng), (character) => character.charCodeAt(0))],
      'first.png', { type: 'image/png' }));
    transfer.items.add(new File([new Uint8Array([4, 5, 6])], 'second.bin', { type: 'application/x-test' }));
    panel.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, png.toString('base64'));
  await expect(page.locator('.composer-attachment')).toHaveCount(2);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-message-id="F-mixed"]')).toHaveCount(1);
  expect(order).toEqual(['image', 'second.bin']);
  await expect(page.locator('.chat-message-content').last()).toHaveText('说明');
});

test('图片响应丢失后重试沿用消息 ID，界面只显示一条', async ({ page }) => {
  await mockChatShell(page);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const requestIds: string[] = [];
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'POST') {
      const messageId = request.postData()?.match(/name="messageId"\r?\n\r?\n([^\r\n]+)/u)?.[1];
      if (!messageId) throw new Error('图片请求缺少 messageId');
      requestIds.push(messageId);
      if (requestIds.length === 1) {
        return route.fulfill({ status: 503, json: { code: 'UNKNOWN_ERROR', detail: '响应丢失' } });
      }
      const message: ChatMessage = { ...imageMessage(1, 'image-attachment'), id: messageId, content: '说明' };
      return route.fulfill({ status: 201, json: message });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.getByLabel('消息内容').fill('说明');
  await page.locator('.chat-panel').evaluate((panel, encodedPng) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(encodedPng), (character) => character.charCodeAt(0))],
      'screen.png', { type: 'image/png' }));
    panel.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, png.toString('base64'));
  await expect(page.locator('.composer-attachment')).toHaveCount(1);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('alert')).toHaveText('响应丢失');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
  await expect(page.locator(`[data-message-id="${requestIds[0]}"]`)).toHaveCount(1);
  await expect(page.locator('.chat-message')).toHaveCount(1);
});

test('取消文件上传后可重新发送且不会重复创建成功消息', async ({ page }) => {
  await mockChatShell(page);
  let uploadRequests = 0;
  let releaseUpload!: () => void;
  let finishUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploadFinished = new Promise<void>((resolve) => { finishUpload = resolve; });
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      uploadRequests++;
      if (uploadRequests === 1) {
        await uploadGate;
        try { await route.fulfill({ status: 201, json: fileMessage('F-canceled', 'attachment', 'cancel.bin') }); }
        catch { /* The request is canceled by the composer. */ }
        finally { finishUpload(); }
        return;
      }
      return route.fulfill({ status: 201, json: fileMessage('F-retried', 'attachment', 'cancel.bin') });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([5, 6, 7]),
  });
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => uploadRequests).toBe(1);
  await page.getByRole('button', { name: '取消文件上传' }).click();
  await expect(page.getByText('已取消，可继续发送')).toBeVisible();
  releaseUpload();
  await uploadFinished;
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-message-id="F-retried"]')).toHaveCount(1);
  expect(uploadRequests).toBe(2);
  await expect(page.locator('[data-message-id="F-canceled"]')).toHaveCount(0);
});

test('文件下载分块写入保存目标，不创建整文件 Blob', async ({ page }) => {
  await mockChatShell(page);
  const downloadBytes = [0, 4, 8, 255];
  await page.addInitScript(() => {
    const saved = { name: '', chunks: [] as number[][] };
    Object.defineProperty(window, '__savedChatFile', { value: saved });
    Object.defineProperty(window, 'showSaveFilePicker', { value: async ({ suggestedName }: { suggestedName: string }) => {
      saved.name = suggestedName;
      return { createWritable: async () => ({
        write: async (chunk: Uint8Array) => { saved.chunks.push([...chunk]); },
        close: async () => undefined,
        abort: async () => undefined,
      }) };
    } });
  });
  await page.route('**/api/groups**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      return route.fulfill({ json: { messages: [fileMessage('F-download', 'download-id', '保存文件.dat')], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/files/download-id`) {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(downloadBytes) });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '下载文件' }).click();
  await expect(page.getByRole('button', { name: '下载文件' })).toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as Window & {
    __savedChatFile: { name: string; chunks: number[][] };
  }).__savedChatFile);
  expect(saved.name).toBe('保存文件.dat');
  expect(saved.chunks.flat()).toEqual(downloadBytes);
});

test('切换群组会取消未完成的文件上传并清空旧群组队列', async ({ page }) => {
  await mockChatShell(page);
  const otherGroup = { ...group, id: 'f45d69f7-ea7d-4a4f-b0bb-b17d91b78dc2', name: '第二群组' };
  let releaseUpload!: () => void;
  let finishUpload!: () => void;
  let uploadRequests = 0;
  let uploadAborted = false;
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploadFinished = new Promise<void>((resolve) => { finishUpload = resolve; });
  page.on('requestfailed', (request) => {
    if (request.url().endsWith(`/api/groups/${groupId}/files`)) uploadAborted = true;
  });
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group, otherGroup] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${otherGroup.id}`) return route.fulfill({ json: otherGroup });
    if (url.pathname === `/api/groups/${groupId}/messages` || url.pathname === `/api/groups/${otherGroup.id}/messages`) {
      return route.fulfill({ json: { messages: url.pathname.includes(otherGroup.id) ? [chatMessage(1, 'B')] : [], hasMore: false } });
    }
    if (url.pathname.startsWith(`/api/groups/${groupId}/files/requests/`)) return route.fulfill({ status: 204 });
    if (url.pathname === `/api/groups/${groupId}/files`) {
      uploadRequests++;
      await uploadGate;
      try { await route.fulfill({ status: 201, json: fileMessage('F-old', 'attachment', 'old.bin') }); }
      catch { /* The group change aborts this upload. */ }
      finally { finishUpload(); }
      return;
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'old.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2]),
  });
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => uploadRequests).toBe(1);
  await page.getByRole('button', { name: /第二群组，单击预览/ }).click();
  await expect(page.locator('[data-message-id="B01"]')).toHaveCount(1);
  await expect.poll(() => uploadAborted).toBe(true);
  releaseUpload();
  await uploadFinished;
  await expect(page.locator('.composer-attachment')).toHaveCount(0);
  await expect(page.locator('[data-message-id="F-old"]')).toHaveCount(0);
});

import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { ChatMessage } from '../src/chat/chatApi';

test.beforeEach(async ({ page }) => {
  // 未提供模拟的业务请求明确失败，不能落到 Vite 的真实服务器代理。
  await page.route(url => url.pathname.startsWith('/api/'), (route) => route.fulfill({ status: 503, json: { detail: '未提供的测试接口' } }));
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

async function mockFileDeclaration(route: Route) {
  if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
  if (route.request().method() === 'GET') return route.fulfill({ json: [] });
  const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
  const body = route.request().postDataJSON();
  const pending = fileMessage(id, id, Buffer.from(body.encodedName, 'base64url').toString('utf8'), body.content);
  pending.attachment!.transferStatus = 'PENDING';
  return route.fulfill({ json: pending });
}

async function mockChatShell(page: Page) {
  await page.route('**/api/chat/upload-limits', route => route.fulfill({ json: { maxFileBytes: 512 * 1024 ** 2, maxStorageBytes: 10 * 1024 ** 3 } }));
  await page.route('**/api/auth/options', (route) => route.fulfill({ json: { mode: 'invite', qqAvailable: false } }));
  await page.route('**/api/system/initialization', (route) => route.fulfill({ json: { initialized: true } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/rtc/room-summary*', (route) => route.fulfill({ json: { participantCount: 0, participants: [] } }));
}

test('跨消息复制完整记录和附件说明，单段文字仍按选区复制', async ({ page }) => {
  await mockChatShell(page);
  const records = [chatMessage(1), chatMessage(2), imageMessage(3, 'image'),
    fileMessage('A04', 'video', '合练.mp4', '第二局'), fileMessage('A05', 'notes', '战术.txt'),
    { ...chatMessage(6), senderUserId: 'friend', senderNickname: '队友' }];
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname.endsWith(groupId)) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: {
      messages: url.searchParams.has('afterMessageId') ? [] : records, hasMore: false } });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await expect(page.locator('article[data-message-id]')).toHaveCount(records.length);
  await expect(page.locator('[inert] .message-list')).toHaveCount(0);
  async function copy() {
    await page.evaluate(() => {
      // 使用真实快捷键的派发目标，在内存剪贴板中检查结果。
      document.addEventListener('copy', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const clipboardData = new DataTransfer();
        const handled = !event.target!.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
        document.body.dataset.copied = handled ? clipboardData.getData('text/plain') : window.getSelection()!.toString();
      }, { capture: true, once: true });
    });
    await page.keyboard.press('Control+c');
    return page.locator('body').getAttribute('data-copied');
  }
  const first = '[data-message-id="A02"] .chat-message-content';
  const last = '[data-message-id="A06"] .chat-message-content';
  const textBox = async (selector: string) => page.locator(selector).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, middle: box.top + box.height / 2, bottom: element.getBoundingClientRect().bottom };
  });
  const drag = async (x: number, y: number, endX: number, endY: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 12 });
    await page.mouse.up();
  };
  await page.locator(first).scrollIntoViewIfNeeded();
  const start = await textBox(first), end = await textBox(last);
  for (const [x, y] of [[end.right - 1, end.middle], [end.right + 24, end.middle], [end.right + 24, end.bottom + 3]]) {
    await drag(x, y, end.left, end.middle);
    expect((await page.evaluate(() => getSelection()!.toString())).trim()).toBe('A消息 6');
    await page.mouse.click(end.left, end.middle);
  }
  await drag(end.right + 24, end.middle, start.left + 4, start.middle);
  const transcript = await copy();
  const entries = transcript!.split('\n\n');
  expect(entries.map(entry => entry.slice(entry.indexOf('\n') + 1))).toEqual([
    'A消息 2', '[图片]', '第二局\n[视频] 合练.mp4', '[文件] 战术.txt', 'A消息 6']);
  expect(entries[0]).toMatch(/^群主  .*2026.*:\d{2}:02\n/);
  expect(entries.at(-1)).toMatch(/^队友  .*:\d{2}:06\n/);
  await page.mouse.click(end.left, end.middle);
  await drag(end.right - 1, end.middle, end.right - 7, end.middle);
  expect(await copy()).toBe('6');
  const name = await textBox('[data-message-id="A06"] .chat-message-meta strong');
  await drag(name.right + 3, name.middle, name.left, name.middle);
  expect((await copy())?.trim()).toBe('队友');
});

test('长文本输入和清空平滑伸缩，发送后随输入框收起完整抵达最新消息', async ({ page }) => {
  await mockChatShell(page);
  await page.setViewportSize({ width: 1000, height: 720 });
  const initial = Array.from({ length: 65 }, (_, index) => chatMessage(index + 1));
  let outgoing = '';
  let sent = 65;
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) {
      if (route.request().method() === 'POST') return route.fulfill({ json: { ...chatMessage(++sent), content: outgoing } });
      return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : initial, hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const list = page.locator('.message-list');
  const input = page.getByRole('textbox', { name: '消息内容', exact: true });
  await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  for (const content of ['长文本内容测试。'.repeat(180), Array.from({ length: 35 }, (_, index) => `第 ${index + 1} 行：发送完成后显示到最后一行。`).join('\n'), '短消息']) {
    outgoing = content;
    const heights = await input.evaluate(async (element, text) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const heights: number[] = [];
      for (let frame = 0; frame < 18; frame++) {
        await new Promise(requestAnimationFrame);
        heights.push(textarea.closest('.composer-content')!.getBoundingClientRect().height);
      }
      return heights;
    }, content);
    if (content.length > 100) expect(heights.some(height => height > 42 && height < 122)).toBe(true);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(input).toHaveCSS('height', '42px');
    await expect(list.locator('.chat-message-content').last()).toHaveText(content);
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.locator('.chat-jump')).toHaveCount(0);
  }
});

test('文字等待固定在正文正下方，窄窗连发不遮字或回弹', async ({ page }) => {
  await mockChatShell(page);
  await page.setViewportSize({ width: 680, height: 790 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let confirm!: () => void;
  const gate = new Promise<void>(resolve => { confirm = resolve; });
  await page.route('**/api/groups**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/groups') return route.fulfill({ json: [group] });
    if (path.endsWith(groupId)) return route.fulfill({ json: group });
    if (path.endsWith('/messages')) {
      if (route.request().method() === 'POST') {
        const form = await new Response(new Uint8Array(route.request().postDataBuffer()!), {
          headers: { 'Content-Type': route.request().headers()['content-type'] },
        }).formData();
        await gate;
        return route.fulfill({ json: { ...chatMessage(1), id: form.get('messageId'), content: form.get('content'), createdAt: new Date().toISOString() } });
      }
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息内容' });
  const content = page.locator('.chat-message-content');
  const label = page.locator('.chat-send-pending');
  try {
    await input.fill('最后一行附上链接\nhttps://example.com');
    await input.press('Enter');
    const fullLine = await content.evaluate(el => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = getComputedStyle(el).font;
      return '字'.repeat(Math.floor(el.clientWidth / context.measureText('字').width));
    });
    await input.fill(fullLine);
    await input.press('Enter');
    await expect(label).toHaveCount(2);
    const heights = await content.evaluateAll(rows => rows.map(row => row.clientHeight));
    const first = (await label.first().boundingBox())!;
    const bodies = await content.evaluateAll(rows => rows.map(row => {
      const { x, y, height } = row.getBoundingClientRect();
      return { x, y, height };
    }));
    for (const [index, body] of bodies.entries()) {
      const hint = (await label.nth(index).boundingBox())!;
      expect(hint.x).toBeCloseTo(body.x, 0);
      expect(hint.y).toBeCloseTo(body.y + body.height, 0);
    }
    expect(first.y + first.height).toBeLessThanOrEqual(bodies[1].y);
    confirm();
    await expect(label).toHaveCount(0);
    expect(await content.evaluateAll(rows => rows.map(row => row.clientHeight))).toEqual(heights);
    expect((await content.last().boundingBox())!.y).toBe(bodies[1].y);
  } finally { confirm(); }
});

test('首次加载、读取失败和空会话分开反馈，重试共用当前读取流程', async ({ page }) => {
  await mockChatShell(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/groups**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/groups') return route.fulfill({ json: [group] });
    if (path === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (path.endsWith('/messages')) {
      if (++requests === 1) {
        await gate;
        return route.fulfill({ status: 503, json: { detail: '消息暂时无法读取' } });
      }
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  try {
    await expect(page.getByText('还没有消息', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '正在准备群聊…' })).toBeVisible();
    await expect(page.getByText('还没有消息', { exact: true })).toHaveCount(0);
    release();
    await expect(page.locator('.chat-read-error')).toHaveText('消息暂时无法读取');
    await expect(page.locator('.chat-error')).toHaveCount(0);
    await page.getByRole('button', { name: '重新读取消息', exact: true }).click();
    await expect(page.getByText('还没有消息', { exact: true })).toBeVisible();
    await expect(page.locator('.chat-read-error')).toHaveCount(0);
    expect(requests).toBeGreaterThanOrEqual(2);
  } finally { release(); }
});

test('向下返回历史才显示回到最新；新消息定位未读且不丢草稿', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockChatShell(page);
  const initial = Array.from({ length: 80 }, (_, index) => chatMessage(index + 1));
  let newMessage = false;
  let readError = false;
  await page.route('**/api/groups**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/presences') || url.pathname.endsWith('/presence-changes')) {
      if (readError) return route.fulfill({ status: 503 });
      if (url.pathname.endsWith('/presences')) return route.fulfill({ json: [{ userId: user.id, status: 'ONLINE' }] });
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ json: { serverInstanceId: 'chat-test', version: 1, detailVersion: 1, changed: false } });
    }
    if (url.pathname.endsWith('/messages')) {
      if (readError) return route.fulfill({ status: 503, json: { detail: '消息同步失败' } });
      return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId')
        ? newMessage ? [{ ...chatMessage(81), senderUserId: 'friend' }] : [] : initial, hasMore: false } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const list = page.locator('.message-list');
  await expect(page.locator('[data-message-id="A80"]')).toHaveCount(1);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('先保留这条草稿');
  const original = await input.elementHandle();
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.chat-jump')).toHaveCount(0);
  await list.evaluate(element => { element.scrollTop = 20; });
  await expect(page.locator('.chat-jump')).toHaveCount(0);
  await list.evaluate(element => { element.scrollTop = 100; });
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.chat-jump')).toHaveCount(0);
  newMessage = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-message-id="A81"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '1 条新消息 · 跳转到未读', exact: true })).toBeVisible();
  expect(await list.evaluate(element => element.scrollTop)).toBe(0);
  const composerBounds = await page.locator('.composer').boundingBox();
  readError = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.chat-sync-status')).toContainText('消息同步失败');
  await expect(page.locator('.chat-sync-status')).toHaveCount(1);
  await expect(page.locator('.members-directory .group-error, .members-directory [role="status"]')).toHaveCount(0);
  expect(await page.locator('.composer').boundingBox()).toEqual(composerBounds);
  await expect(page.locator('.chat-error')).toHaveCount(0);
  for (const width of [640, 420]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('textbox', { name: '消息内容' })).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath('chat-feedback-narrow.png') });
  readError = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.chat-sync-status')).toHaveCount(0);
  await list.evaluate(element => {
    const scroll = element.scrollTo.bind(element);
    element.scrollTo = ((options: ScrollToOptions) => {
      element.dataset.scrollBehavior = options.behavior;
      // 将平滑滚动停在中途，确定性验证已点击但尚未抵达的状态。
      if (options.behavior !== 'smooth') scroll(options);
    }) as typeof element.scrollTo;
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: '1 条新消息 · 跳转到未读', exact: true }).click();
  await expect(list).toHaveAttribute('data-scroll-behavior', 'smooth');
  await expect(page.locator('.chat-jump')).toContainText('1 条新消息');
  await list.evaluate(element => { element.scrollTop = 200; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(list).toHaveAttribute('data-scroll-behavior', 'auto');
  await expect(page.locator('.chat-jump')).toContainText('1 条新消息');
  await page.getByRole('button', { name: '1 条新消息 · 跳转到未读', exact: true }).click();
  await expect(list).toHaveAttribute('data-scroll-behavior', 'auto');
  await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(1);
  await expect(page.locator('.chat-jump')).toHaveCount(0);
  await expect(input).toHaveValue('先保留这条草稿');
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
});

test('文本消息使用统一 multipart 接口发送，并按日期分组且仅允许消息正文复制', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-30T04:00:00Z'));
  let readFailure = true;
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
      getAutoLogin: async () => ({ enabled: true, manualEntryRequired: false }),
      getAccessLink: async () => null,
      onAccessLink: () => () => undefined,
      getUpdateState: async () => ({ phase: 'ready', supported: false, version: 'test', message: '测试不检查更新' } satisfies StartupUpdateState),
      runStartupUpdate: async () => ({ phase: 'ready', supported: false, version: 'test', message: '测试不检查更新' } satisfies StartupUpdateState),
      onUpdateState: () => () => undefined,
      minimize: () => undefined,
      getWindowVisibility: async () => true,
      onWindowVisibility: () => () => undefined,
      onViewerClosed: () => () => undefined,
      focusViewerWindow: async () => undefined,
      isMaximized: async () => false,
      prepareCapture: async () => undefined,
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
      getRecordingSettings: async () => ({ directory: 'test-recordings', applicationAudio: true, microphone: false, friends: false }),
      getRecordingStatus: async () => ({ holdingResources: false, phase: 'idle', recordingId: null, startedAt: null,
        bytes: 0, error: null, saved: false, continuing: false, applicationAudio: true }),
      onRecordingState: () => () => undefined,
    } });
  });
  await page.route('**/api/chat/upload-limits', route => route.fulfill({ json: { maxFileBytes: 512 * 1024 ** 2, maxStorageBytes: 10 * 1024 ** 3 } }));
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
      if (readFailure) return route.fulfill({ status: 503, json: { detail: '群聊读取暂时失败' } });
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
  await expect(page.locator('.chat-read-error')).toHaveText('群聊读取暂时失败');
  readFailure = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.chat-read-error')).toHaveCount(0);
  // 消息已返回不代表登录过渡已解除交互限制。
  await expect(page.locator('.app-content')).not.toHaveAttribute('inert');
  const composer = page.getByLabel('消息内容');
  await composer.fill('晚上见');
  await expect(composer).toHaveValue('晚上见');
  await composer.press('Enter');
  await expect(page.locator('.chat-message-content').last()).toHaveText('晚上见 https://example.com/docs。');
  await expect(page.locator('.chat-date-divider')).toHaveText(['2026年9月13日', '2026年9月14日']);
  await expect(page.locator('.chat-message-meta')).toHaveCount(4);
  await expect(page.locator('.chat-message.is-grouped')).toHaveCount(1);
  await expect(page.locator('.chat-message-meta time').nth(1)).toHaveText('9月14日 周一 12:00');
  const link = page.getByRole('link', { name: 'https://example.com/docs' });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await link.click();
  await expect(page.locator('html')).toHaveAttribute('data-external-url', 'https://example.com/docs');
  await expect(page.locator('.message-list')).toHaveCSS('user-select', 'none');
  await expect(page.locator('.chat-message-content').first()).toHaveCSS('user-select', 'text');

  const composerBoundsBeforeError = await page.locator('.composer').boundingBox();
  await composer.fill('触发错误');
  await composer.press('Enter');
  const chatError = page.locator('.chat-message').getByRole('alert');
  await expect(chatError).toHaveText('消息发送失败');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(chatError).toHaveText('消息发送失败');
  const composerBoundsAfterError = await page.locator('.composer').boundingBox();
  const errorBounds = await chatError.boundingBox();
  expect(composerBoundsAfterError).toEqual(composerBoundsBeforeError);
  expect(errorBounds!.y + errorBounds!.height).toBeLessThanOrEqual(composerBoundsAfterError!.y);
});

test('空缓存进入十万序号群聊只取最近一页，连续上翻十页保持输入可用', async ({ page }) => {
  await mockChatShell(page);
  const pages: number[] = [];
  let firstBytes = 0;
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname.endsWith(groupId)) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) {
      if (url.searchParams.has('afterMessageId')) return route.fulfill({ json: { messages: [], hasMore: false } });
      const cursor = url.searchParams.get('beforeMessageId');
      const end = cursor ? Number(cursor.slice(1)) - 1 : 100000;
      const body = JSON.stringify({ messages: Array.from({ length: 30 }, (_, i) => chatMessage(end - 29 + i)), hasMore: true });
      if (!cursor) firstBytes = Buffer.byteLength(body);
      pages.push(end);
      return route.fulfill({ contentType: 'application/json', body });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const list = page.locator('.message-list');
  const rows = list.locator('[data-message-id]');
  await expect(rows).toHaveCount(30);
  expect(pages).toEqual([100000]);
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await composer.fill('保留输入');
  const openedAt = await page.evaluate(() => Math.round(performance.now()));
  for (let i = 1; i <= 10; i++) {
    await list.evaluate(el => { el.scrollTop = 0; });
    await list.dispatchEvent('wheel', { deltaY: -100 });
    await expect(rows).toHaveCount(30 * (i + 1));
  }
  expect(pages).toEqual(Array.from({ length: 11 }, (_, i) => 100000 - 30 * i));
  await expect(composer).toHaveValue('保留输入');
  const frames = await page.evaluate(async () => {
    const frame = () => new Promise<number>(done => requestAnimationFrame(done));
    let last = await frame();
    const intervals: number[] = [];
    for (let i = 0; i < 30; i++) {
      document.querySelector('.message-list')!.scrollBy(0, 28);
      const time = await frame(); intervals.push(time - last); last = time;
    }
    return intervals.sort((a, b) => a - b)[28];
  });
  console.log('合成聊天首屏与上翻', { firstBytes, openedAt, rows: await rows.count(), scrollP95Ms: frames });
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
  await list.dispatchEvent('wheel', { deltaY: -100 });
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
  const afterCursors: string[] = [];
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
      const after = url.searchParams.get('afterMessageId');
      if (after) {
        afterCursors.push(after);
        if (after === 'A60') return route.fulfill({ json: { messages: [chatMessage(61)], hasMore: false } });
        // 已到最新游标时保持等待，不用重复返回同一消息冒充长轮询。
        if (after === 'A61') return new Promise<void>(() => {});
        throw new Error(`意外的消息轮询游标：${after}`);
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
  await expect.poll(() => afterCursors).toEqual(['A60', 'A61']);
  await expect(page.locator('[data-message-id="A61"]')).toBeVisible();
  const list = page.locator('.message-list');
  await list.evaluate((element) => { element.scrollTop = 0; });
  await list.dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('[data-message-id="A01"]')).toHaveCount(1);
  expect(beforeCursors).toEqual(['A31']);
});

test('历史图片先加载缩略图，点击原图后保留比例且来回滚动不重复请求', async ({ page }) => {
  await mockChatShell(page);
  await page.setViewportSize({ width: 360, height: 760 });
  const initial = [imageMessage(31, 'offscreen-wide', 1600, 400),
    ...Array.from({ length: 29 }, (_, index) => chatMessage(index + 32))];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let imageRequests = 0;
  let thumbnailRequests = 0;
  await page.route('**/api/groups**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/attachments/offscreen-wide`) {
      imageRequests++;
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    if (url.pathname === `/api/groups/${groupId}/attachments/offscreen-wide/thumbnail`) {
      thumbnailRequests++;
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
  expect(thumbnailRequests).toBe(0);

  await list.evaluate((element) => { element.scrollTop = 0; });
  const preview = article.getByAltText('群主 发送的图片');
  await expect(preview).toHaveJSProperty('naturalWidth', 1);
  expect(thumbnailRequests).toBe(1);
  expect(imageRequests).toBe(0);
  await article.getByRole('button', { name: '查看图片' }).click();
  const hd = page.getByRole('button', { name: /^查看原图/ });
  await expect(hd).toBeVisible();
  expect(imageRequests).toBe(0);
  await hd.click();
  await expect(page.getByRole('button', { name: '已显示原图' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  expect(imageRequests).toBe(1);
  await expect(article.getByRole('button', { name: '查看图片' })).toBeVisible();
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
  const frames = page.locator('.chat-image-frame');
  await expect(frames).toHaveCount(2);
  for (const frame of await frames.all()) await frame.getByRole('button', { name: '加载原图' }).click();
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
  await page.getByRole('button', { name: '加载原图' }).click();
  const retry = page.getByRole('button', { name: '图片加载失败，点击重试' });
  await expect(retry).toBeVisible();
  await page.waitForTimeout(2200);
  expect(imageRequests).toBe(1);
  await retry.click();
  await expect(page.getByAltText('群主 发送的图片')).toHaveJSProperty('naturalWidth', 1);
  expect(imageRequests).toBe(2);
});

test('反复放大已加载图片复用原始内容，关闭后仅保留列表预览 URL', async ({ page }) => {
  await mockChatShell(page);
  await page.addInitScript(() => {
    const live = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); live.add(url); return url; };
    URL.revokeObjectURL = url => { live.delete(url); revoke(url); };
    Object.defineProperty(window, '__liveImageUrls', { value: live });
  });
  const image = imageMessage(1, 'reused-image');
  image.attachment!.fileName = '合影.png';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let imageRequests = 0;
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages`) {
      return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : [image], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/attachments/reused-image`) {
      imageRequests++;
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '加载原图' }).click();
  await expect(page.getByAltText('群主 发送的图片')).toHaveJSProperty('naturalWidth', 1);
  const liveUrls = () => page.evaluate(() =>
    (window as unknown as { __liveImageUrls: Set<string> }).__liveImageUrls.size);
  await expect(page.getByText('合影.png', { exact: true })).toHaveCount(0);
  for (let cycle = 0; cycle < 12; cycle++) {
    const target = page.getByRole('button', { name: '查看图片', exact: true });
    await expect(target).toHaveCSS('cursor', 'pointer');
    await target.click();
    await expect(page.locator('.pswp__img').last()).toHaveJSProperty('naturalWidth', 1);
    await page.locator('.pswp__button--close').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(liveUrls).toBe(1);
  }
  console.log(JSON.stringify({ imagePreviewCycles: 12, imageRequests, liveUrlsAfterClose: await liveUrls() }));
  expect(imageRequests).toBe(1);
});

test('没有封面的群聊音视频使用紧凑文件行，名称可打开查看器', async ({ page }) => {
  await mockChatShell(page);
  const unfinished = fileMessage('A03', 'failed', '未完成.mp4');
  unfinished.attachment!.transferStatus = 'FAILED';
  const fileName = 'LycanSync-diagnostics-1795345026223.json';
  const pendingFile = fileMessage('A04', 'pending-file', fileName);
  pendingFile.attachment!.transferStatus = 'PENDING';
  const items = [fileMessage('A01', 'clip', '片段.mp4'), fileMessage('A02', 'sound', '录音.ogg'), unfinished,
    pendingFile, fileMessage('A05', 'completed-file', fileName)];
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : items, hasMore: false } });
    if (url.pathname.endsWith('/thumbnail')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 503 });
  });
  await page.goto('/');
  const row = page.locator('[data-message-id="A01"] .chat-file-card');
  const failed = page.locator('[data-message-id="A03"] .chat-transfer-media');
  await expect(failed.getByText('上传未完成')).toBeVisible();
  await expect(failed.getByRole('button')).toHaveCount(0);
  const pendingCard = page.locator('[data-message-id="A04"] .chat-file-card');
  const completedCard = page.locator('[data-message-id="A05"] .chat-file-card');
  const bar = pendingCard.getByRole('progressbar', { name: '文件上传进度' });
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveAttribute('value');
  await expect(pendingCard.getByRole('button')).toHaveCount(0);
  await expect(completedCard.getByRole('button', { name: '下载文件' })).toBeVisible();
  const before = (await pendingCard.boundingBox())!, after = (await completedCard.boundingBox())!;
  expect([before.width, before.height]).toEqual([after.width, after.height]);
  const details = (await pendingCard.locator('.chat-file-details').boundingBox())!;
  expect((await bar.boundingBox())!.y).toBeGreaterThanOrEqual(details.y + details.height);
  await expect(row).toBeVisible();
  await expect(row.locator('.chat-file-icon')).toHaveCount(0);
  for (const [name, target] of [
    ['片段.mp4', page.getByRole('button', { name: '预览 片段.mp4' })],
    ['录音.ogg', page.getByText('录音.ogg', { exact: true })],
  ] as const) {
    await expect(target).toHaveCSS('cursor', 'pointer');
    await target.click();
    await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
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
  await expect(page.locator('.chat-history-error')).toHaveText('历史读取失败');
  expect(historyRequests).toBe(1);
  await page.locator('.chat-history-state').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('[data-message-id="A01"]')).toHaveCount(1);
  await expect(page.locator('.chat-history-error')).toHaveCount(0);
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

test('服主修改单文件上限后，选中文件立即按新限额提示', async ({ page }) => {
  await mockChatShell(page);
  let limits = { maxFileBytes: 512 * 1024 ** 2, maxStorageBytes: 10 * 1024 ** 3 };
  let uploads = 0;
  await page.route('**/api/chat/upload-limits', route => {
    if (route.request().method() === 'PUT') limits = route.request().postDataJSON();
    return route.fulfill({ json: limits });
  });
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname.endsWith(groupId)) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: [], hasMore: false } });
    if (url.pathname.includes('/files')) uploads++;
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '服主管理', exact: true }).click();
  await page.getByRole('button', { name: '高级配置', exact: true }).click();
  const fileLimit = page.getByLabel('单个文件上限（MiB）');
  await expect(fileLimit).toHaveValue('512');
  await fileLimit.fill('1');
  await page.getByRole('button', { name: '保存限额' }).click();
  await expect.poll(() => limits.maxFileBytes).toBe(1024 ** 2);
  await page.locator('form').filter({ has: fileLimit }).screenshot({ path: test.info().outputPath('file-upload-settings.png') });
  await page.reload();
  const picker = page.locator('input[type=file]');
  const alert = page.locator('.composer').getByRole('alert');
  const rejected = { name: '超限.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 ** 2) };
  const accepted = { name: '笔记.txt', mimeType: 'text/plain', buffer: Buffer.from('示例') };
  const draft = page.getByRole('textbox', { name: '消息内容' });
  await draft.fill('一起看这个文件');
  await picker.setInputFiles(rejected);
  await expect(alert).toContainText('超过单文件上限 1 MiB');
  await expect(page.getByRole('button', { name: '移除 超限.bin' })).toHaveCount(0);
  await picker.setInputFiles(accepted);
  await expect(alert).toHaveCount(0);
  await picker.setInputFiles([rejected, { ...rejected, name: '视频.bin' }]);
  await expect(alert).toContainText('超限.bin');
  await expect(alert).toContainText('视频.bin');
  await expect(alert).toHaveCount(0, { timeout: 7000 });
  await expect(draft).toHaveValue('一起看这个文件');
  await expect(page.getByRole('button', { name: '移除 笔记.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled();
  expect(uploads).toBe(0);
});

test('加号多选可勾选原件并按顺序发送，图片作为文件并只在第一条附带文字', async ({ page }) => {
  await mockChatShell(page);
  // 流式 fetch 在路由拦截器中没有 postData；仅旁读本用例两个小文件的流副本。
  await page.addInitScript(() => {
    const bodies: Record<string, number[]> = {};
    Object.assign(window, { __chatUploadBodies: bodies });
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/files') && init?.body instanceof ReadableStream) {
        const [forward, copy] = init.body.tee();
        const bytes = new Uint8Array(await new Response(copy).arrayBuffer());
        if (bytes.byteLength > 1024) throw new Error('测试只允许旁读小文件');
        bodies[new Headers(init.headers).get('X-Upload-Id')!] = [...bytes];
        init = { ...init, body: forward };
      }
      return originalFetch(input, init);
    };
  });
  const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const uploaded: { id: string; name: string; bytes: Buffer; content: string }[] = [];
  await page.route('**/api/groups**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === `/api/groups/${groupId}`) return route.fulfill({ json: group });
    if (url.pathname === `/api/groups/${groupId}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: [], hasMore: false } });
    }
    if (url.pathname.includes('/files/transfers')) return mockFileDeclaration(route);
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      const content = Buffer.from(headers['x-message-content'] ?? '', 'base64url').toString('utf8');
      const bytes = Buffer.from(await page.evaluate((id) =>
        (window as unknown as { __chatUploadBodies: Record<string, number[]> }).__chatUploadBodies[id]!, String(headers['x-upload-id'])));
      uploaded.push({ id: String(headers['x-upload-id']), name, bytes, content });
      const message = fileMessage(headers['x-file-message'], String(headers['x-upload-id']), name, content);
      message.attachment!.byteSize = bytes.length;
      return route.fulfill({ status: 201, json: message });
    }
    const preview = uploaded.find(item => url.pathname === `/api/groups/${groupId}/files/${item.id}`);
    if (preview && request.method() === 'GET') return route.fulfill({ body: preview.bytes });
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.locator('.app-content')).not.toHaveAttribute('inert');
  await page.getByLabel('消息内容').fill('附在第一条');
  await expect(page.getByLabel('消息内容')).toHaveValue('附在第一条');
  await page.locator('input[type="file"]').setInputFiles([
    { name: '原图.png', mimeType: 'image/png', buffer: originalPng },
    { name: '资料.dat', mimeType: 'application/x-custom', buffer: Buffer.from([9, 8, 7]) },
  ]);
  await expect(page.locator('.composer-attachment')).toHaveCount(2);
  const preview = page.getByRole('button', { name: '预览 原图.png', exact: true });
  await preview.hover();
  await expect(preview).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(preview.getByText('原图.png')).toHaveCSS('text-decoration-line', 'underline');
  await expect(page.locator('.composer-attachment').first()).toHaveCSS('height', '28px');
  for (const target of [preview.locator('img'), preview.getByText('原图.png')]) {
    await target.click();
    await expect(page.locator('.chat-photo-viewer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.chat-photo-viewer')).toHaveCount(0);
  }
  await page.locator('.composer-attachment').first().getByLabel('发送原文件').check();
  await page.locator('.composer').screenshot({ path: test.info().outputPath('compact-attachments.png') });
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.chat-file-media')).toHaveCount(2);
  await expect.poll(() => uploaded.map((item) => item.name)).toEqual(['原图.png', '资料.dat']);
  expect(uploaded.map((item) => [...item.bytes])).toEqual([[...originalPng], [9, 8, 7]]);
  expect(uploaded.map((item) => item.content)).toEqual(['附在第一条', '']);
  await expect(page.locator('.chat-file-media')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '查看图片', exact: true })).toBeVisible();
  await expect(page.locator('.chat-message').first().getByText('原图.png', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看图片', exact: true }).click();
  await expect(page.locator('.chat-photo-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  const ordinaryFile = page.locator('.chat-message').last();
  await expect(ordinaryFile.getByRole('button', { name: /预览/ })).toHaveCount(0);
  await expect(ordinaryFile.getByRole('button', { name: '下载文件' })).toBeVisible();
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
    if (url.pathname.includes('/files/transfers')) return mockFileDeclaration(route);
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      const headers = await request.allHeaders();
      const name = Buffer.from(headers['x-file-name'], 'base64url').toString('utf8');
      const count = (requests.get(name) ?? 0) + 1;
      requests.set(name, count);
      if (name === 'second.bin' && count === 1) {
        return route.fulfill({ status: 503, json: { code: 'TEMPORARY', detail: '上传失败' } });
      }
      const message = fileMessage(headers['x-file-message'], String(headers['x-upload-id']), name);
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
  await expect(page.getByRole('alert').filter({ hasText: '上传失败' })).toBeVisible();
  expect(requests.get('first.bin')).toBe(1);
  expect(requests.get('second.bin')).toBe(1);
  await page.locator('.chat-message').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.chat-file-card').filter({ hasText: 'second.bin' }).getByRole('button', { name: '下载文件' })).toBeVisible();
  expect(requests.get('first.bin')).toBe(1);
  expect(requests.get('second.bin')).toBe(2);
});

test('慢速录像先展示封面，两个客户端都按原顺序看到随后文字与完成的文件', async ({ page, context }) => {
  const peer = await context.newPage();
  const messages: ChatMessage[] = [];
  const video = readFileSync(new URL('./fixtures/chat-clip.webm', import.meta.url));
  let thumbnail: string | undefined;
  let previewRequests = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await page.addInitScript(() => {
    const stream = File.prototype.stream;
    File.prototype.stream = function () {
      if (this.name !== '录像.webm') return stream.call(this);
      const split = Math.ceil(this.size / 2);
      const file = this;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({ async start(controller) {
        controller.enqueue(new Uint8Array(await file.slice(0, split).arrayBuffer()));
        await new Promise<void>(resolve => window.addEventListener('resume-test-upload', () => resolve(), { once: true }));
        controller.enqueue(new Uint8Array(await file.slice(split).arrayBuffer()));
        controller.close();
      } });
    };
    // Playwright 截获请求时不消耗流。让测试传输层读完小样本，再交给模拟服务端。
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/files') && init?.method === 'POST' && init.body instanceof ReadableStream) {
        return originalFetch(input, { ...init, body: await new Response(init.body).blob() });
      }
      return originalFetch(input, init);
    };
  });
  for (const tab of [page, peer]) {
    await tab.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 503, json: { detail: '未模拟接口' } }));
    await tab.route('**/api/presence/heartbeat', route => route.fulfill({ status: 204 }));
    await tab.route('**/api/rtc/room-occupancies', route => route.fulfill({ json: [] }));
    await mockChatShell(tab);
    if (tab === peer) await tab.route('**/api/auth/me', route => route.fulfill({ json: { ...user, id: 'peer', nickname: '成员' } }));
    await tab.route('**/api/groups**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
      if (url.pathname.endsWith('/presences')) return route.fulfill({ json: [] });
      if (url.pathname.endsWith('/presence-changes')) return new Promise<void>(() => {});
      if (url.pathname.endsWith(groupId)) return route.fulfill({ json: group });
      if (url.pathname.endsWith('/messages') && request.method() === 'GET') {
        const cursor = messages.findIndex(message => message.id === url.searchParams.get('afterMessageId'));
        return route.fulfill({ json: { messages: messages.slice(cursor + 1), hasMore: false } });
      }
      if (url.pathname.includes('/files/transfers/')) {
        const id = url.pathname.split('/').at(-1)!;
        thumbnail = request.postDataJSON().thumbnail;
        const message = fileMessage(id, id, '录像.webm');
        message.attachment!.byteSize = video.length;
        message.createdAt = new Date().toISOString();
        message.attachment!.transferStatus = 'PENDING';
        messages.push(message);
        return route.fulfill({ json: message });
      }
      if (url.pathname.endsWith('/files/transfers')) return route.fulfill({ json: messages.slice(0, 1) });
      if (url.pathname.endsWith('/thumbnail')) return thumbnail
        ? route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(thumbnail, 'base64') }) : route.fulfill({ status: 204 });
      if (request.method() === 'GET' && url.pathname.endsWith('/files/' + messages[0]?.id)) {
        previewRequests++;
        return route.fulfill({ contentType: 'video/webm', body: video });
      }
      if (url.pathname.endsWith('/files') && request.method() === 'POST') {
        expect(request.headers()['x-optimize-video']).toBeUndefined();
        await gate;
        delete messages[0].attachment!.transferStatus;
        return route.fulfill({ json: messages[0] });
      }
      if (url.pathname.endsWith('/messages') && request.method() === 'POST') {
        const message = { ...chatMessage(messages.length), createdAt: new Date().toISOString(), content: '后发文字 ' + messages.length };
        messages.push(message);
        return route.fulfill({ json: message });
      }
      return route.fulfill({ status: 404 });
    });
    await tab.goto('/');
  }
  try {
    await page.locator('input[type=file]').setInputFiles({ name: '录像.webm', mimeType: 'video/webm', buffer: video });
    await expect(page.locator('.composer-attachment canvas')).toBeVisible();
    await expect(page.locator('.composer-attachment').getByLabel('发送原文件')).toHaveCount(0);
    await page.locator('.composer').screenshot({ path: test.info().outputPath('video-send.png') });
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(peer.getByText('文件上传中…')).toBeVisible();
    await expect(peer.locator('.chat-inline-media img')).toBeVisible();
    await expect(page.locator('.chat-transfer-media').getByText('50%', { exact: true })).toBeVisible();
    await expect(page.locator('.chat-media-transfer-footer')).not.toContainText('%');
    await expect(page.getByRole('button', { name: '取消发送' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: '文件上传进度' })).toHaveAttribute('value', '50');
    await page.evaluate(() => window.dispatchEvent(new Event('resume-test-upload')));
    await expect(page.getByText('正在完成发送…')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: '正在完成发送…' })).not.toHaveAttribute('value');
    const pending = peer.locator('.chat-transfer-media');
    await expect(pending.getByRole('button')).toHaveCount(0);
    for (const client of [page, peer]) {
      const frame = client.locator('.chat-transfer-media .chat-inline-media');
      const footer = await frame.locator('.chat-media-transfer-footer').boundingBox();
      const track = await frame.locator('.chat-media-progress').boundingBox();
      const bounds = await frame.boundingBox();
      expect(footer!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(footer!.y).toBeGreaterThan(bounds!.y);
      expect(Math.abs(footer!.y + footer!.height - track!.y)).toBeLessThan(0.1);
      expect(Math.abs(track!.y + track!.height - bounds!.y - bounds!.height)).toBeLessThan(0.1);
    }
    for (const content of ['后发文字 1', '后发文字 2']) {
      await page.getByLabel('消息内容').fill(content);
      await page.getByLabel('消息内容').press('Enter');
    }
    await expect(peer.locator('.chat-message').last()).toContainText('后发文字 2');
    for (const tab of [page, peer]) await expect(tab.locator('.chat-message').first().locator('.chat-inline-media')).toHaveAttribute('aria-label', '录像.webm');
    const card = page.locator('.chat-inline-media').first();
    await expect.poll(() => card.evaluate(frame => {
      const canvas = frame.querySelector('canvas');
      return canvas ? Math.abs(frame.clientWidth - canvas.clientWidth) : Infinity;
    })).toBeLessThan(2);
    await card.screenshot({ path: test.info().outputPath('video-card.png') });
    await page.locator('.chat-panel').screenshot({ path: test.info().outputPath('background-upload.png') });
    finish();
    for (const tab of [page, peer]) {
      await expect(tab.locator('.chat-message').first().getByRole('button', { name: '播放视频' })).toBeVisible();
      await expect(tab.locator('.chat-message')).toHaveCount(3);
    }
    expect(previewRequests).toBe(0);
    // 第一遍只交付一半原片，检查真实字节进度，并让第二遍正常播放。
    await peer.evaluate(id => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const result = await original(input, init);
        if (!String(input).endsWith('/files/' + id)) return result;
        window.fetch = original;
        const bytes = new Uint8Array(await result.arrayBuffer());
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        } }), { headers: result.headers });
      };
    }, messages[0].id);
    await peer.getByRole('button', { name: '播放视频' }).click();
    await expect.poll(() => previewRequests).toBe(1);
    await expect(peer.getByRole('progressbar', { name: '媒体加载进度' })).toHaveAttribute('value', '50');
    await peer.locator('.chat-inline-media').screenshot({ path: test.info().outputPath('video-loading.png') });
    await peer.getByLabel('消息内容').fill('视频加载时继续输入');
    await peer.getByRole('button', { name: '取消加载视频' }).click();
    await expect(peer.getByRole('button', { name: '播放视频' })).toBeVisible();
    await peer.getByRole('button', { name: '播放视频' }).click();
    await expect(peer.getByRole('dialog', { name: '录像.webm' })).toBeVisible();
    await peer.keyboard.press('Escape');
    await expect(peer.getByRole('dialog', { name: '录像.webm' })).toHaveCount(0);
    const requestsBeforeReopen = previewRequests;
    await peer.getByRole('button', { name: '播放视频' }).click();
    const reopened = peer.getByRole('dialog', { name: '录像.webm' });
    await expect(reopened).toBeVisible();
    const player = reopened.locator('video');
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await player.evaluate((video: HTMLVideoElement) => { video.currentTime = video.duration / 2; });
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    expect(previewRequests).toBe(requestsBeforeReopen);
  } finally { finish(); await peer.close(); }
});

test('旧视频缓存无法播放且兼容转换失败时，重试取回可播放的原片', async ({ page }) => {
  await mockChatShell(page);
  const clip = readFileSync(new URL('./fixtures/chat-clip.webm', import.meta.url));
  const message = fileMessage('clip-message', 'clip', '短片.webm');
  message.attachment!.byteSize = clip.length;
  let downloads = 0, conversions = 0, finish = false;
  await page.route('**/api/groups**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/groups') return route.fulfill({ json: [group] });
    if (url.pathname === '/api/groups/' + groupId) return route.fulfill({ json: group });
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: url.searchParams.has('afterMessageId') ? [] : [message], hasMore: false } });
    if (url.pathname.endsWith('/thumbnail')) return route.fulfill({ status: 204 });
    if (url.pathname.endsWith('/preview')) {
      if (route.request().method() === 'POST') conversions++;
      return route.fulfill({ json: { status: conversions === 0 ? 'absent' : finish ? 'failed' : 'processing', message: finish ? '视频转换未能完成。' : null } });
    }
    if (url.pathname.endsWith('/files/clip')) {
      downloads++;
      return route.fulfill({ contentType: 'video/webm', body: clip });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const open = page.getByRole('button', { name: '预览 短片.webm' });
  await expect(open).toBeVisible();
  await page.evaluate(async ({ groupId, userId, size }) => {
    const modulePath = '/src/cache/localCache.ts';
    const { createAccountCache } = await import(modulePath);
    const cache = createAccountCache(userId);
    cache.allowGroups([groupId]);
    await cache.write('video', groupId, new Blob([new Uint8Array(size)]), 'clip');
    cache.dispose();
  }, { groupId, userId: user.id, size: clip.length });
  await page.setViewportSize({ width: 960, height: 600 });
  await open.click();
  const viewer = page.getByRole('dialog', { name: '短片.webm' });
  const convert = viewer.getByRole('button', { name: '转码播放' });
  await expect(convert).toBeVisible();
  expect(conversions).toBe(0);
  await viewer.screenshot({ path: test.info().outputPath('video-offer.png') });
  await convert.click();
  await expect(viewer.getByText('正在生成兼容版…')).toBeVisible();
  await viewer.screenshot({ path: test.info().outputPath('video-processing.png') });
  finish = true;
  await expect(viewer.getByRole('button', { name: '重试转码' })).toBeVisible();
  const retry = viewer.getByRole('button', { name: '重试原片', exact: true });
  await expect(retry).toBeVisible();
  expect(downloads).toBe(0);
  await retry.click();
  await expect.poll(() => downloads).toBe(1);
  const player = page.getByRole('dialog', { name: '短片.webm' }).locator('video');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await open.click();
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  expect([downloads, conversions]).toEqual([1, 1]);
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
    if (url.pathname.includes('/files/transfers')) return mockFileDeclaration(route);
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
      return route.fulfill({ status: 201, json: fileMessage(headers['x-file-message'], 'file-attachment', name) });
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
  await expect(page.locator('.chat-file-card').filter({ hasText: 'second.bin' })).toHaveCount(1);
  await expect.poll(() => order).toEqual(['image', 'second.bin']);
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
  await page.locator('.chat-message').getByRole('button', { name: '重试上传', exact: true }).click();
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
    if (url.pathname.includes('/files/transfers')) return mockFileDeclaration(route);
    if (url.pathname === `/api/groups/${groupId}/files` && request.method() === 'POST') {
      uploadRequests++;
      if (uploadRequests === 1) {
        await uploadGate;
        try { await route.fulfill({ status: 201, json: fileMessage('F-canceled', 'attachment', 'cancel.bin') }); }
        catch { /* The request is canceled by the composer. */ }
        finally { finishUpload(); }
        return;
      }
      return route.fulfill({ status: 201, json: fileMessage(request.headers()['x-file-message'], 'attachment', 'cancel.bin') });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await expect(page.getByText('还没有消息', { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([5, 6, 7]),
  });
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => uploadRequests).toBe(1);
  const file = page.locator('.chat-file-card').filter({ hasText: 'cancel.bin' });
  await expect(file.getByRole('progressbar')).toBeVisible();
  await file.getByRole('button', { name: '取消上传' }).click();
  await expect(file.getByText('已取消上传')).toBeVisible();
  await expect(file.getByRole('progressbar')).toHaveCount(0);
  releaseUpload();
  await uploadFinished;
  await page.locator('.chat-message').getByRole('button', { name: '重试', exact: true }).click();
  await expect(file.getByRole('button', { name: '下载文件' })).toBeVisible();
  expect(uploadRequests).toBe(2);
  await expect(page.locator('[data-message-id="F-canceled"]')).toHaveCount(0);
});

test('文件下载分块写入保存目标，不创建整文件 Blob', async ({ page }) => {
  await mockChatShell(page);
  let startCount = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
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
      if (route.request().method() === 'POST') return route.fulfill({ json: { ...chatMessage(2), content: '下载时发言' } });
      const message = fileMessage('F-download', 'download-id', '保存文件.dat');
      message.attachment!.byteSize = downloadBytes.length;
      return route.fulfill({ json: { messages: [message], hasMore: false } });
    }
    if (url.pathname === `/api/groups/${groupId}/files/download-id`) {
      startCount++;
      await gate;
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(downloadBytes) });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('/');
  const save = page.getByRole('button', { name: '下载文件' });
  await expect(save).toBeVisible();
  expect(startCount).toBe(0);
  await save.click();
  try {
    await expect.poll(() => startCount).toBe(1);
    await page.getByLabel('消息内容').fill('下载时发言');
    await page.getByLabel('消息内容').press('Enter');
    await expect(page.locator('.chat-message-content').filter({ hasText: '下载时发言' })).toBeVisible();
  } finally { finish(); }
  await expect(page.getByRole('button', { name: '下载文件' })).toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as Window & {
    __savedChatFile: { name: string; chunks: number[][] };
  }).__savedChatFile);
  expect(saved.name).toBe('保存文件.dat');
  expect(saved.chunks.flat()).toEqual(downloadBytes);
});

test('切换群组后旧群上传继续，新群输入框可使用', async ({ page }) => {
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
    if (url.pathname.includes('/files/transfers')) return mockFileDeclaration(route);
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
  await expect(page.getByLabel('消息内容')).toBeEnabled();
  releaseUpload();
  await uploadFinished;
  expect(uploadAborted).toBe(false);
  await expect(page.locator('.composer-attachment')).toHaveCount(0);
  await expect(page.locator('[data-message-id="F-old"]')).toHaveCount(0);
});

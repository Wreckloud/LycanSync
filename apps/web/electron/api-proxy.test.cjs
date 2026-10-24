const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function proxyFixture(overrides = {}) {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const policyStart = main.indexOf('const apiRoutePolicies =');
  const policyEnd = main.indexOf('app.setName(', policyStart);
  const serveStart = main.indexOf('async function serveApplication(');
  const serveEnd = main.indexOf('function configurePermissions(', serveStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart && serveStart >= 0 && serveEnd > serveStart);
  const forwarded = [];
  // 沿用主进程入口隔离测试：执行正式策略与代理函数，不启动客户端、读取真实会话或连接服务器。
  const serve = runInNewContext(`${main.slice(policyStart, policyEnd)}\n${main.slice(serveStart, serveEnd)}; serveApplication`, {
    URL, Headers, Request, Response, Buffer, AbortSignal,
    backend: new URL('https://example.test'),
    sessionToken: 'test-session',
    trustedUrl: (url) => url.startsWith('lycan://app/'),
    loadSession: async () => 'test-session',
    saveSession: async () => {},
    clearSession: async () => {},
    net: { fetch: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json({ id: 'test-group' }, { status: 201 });
    } },
    ...overrides,
  });
  return { serve, forwarded };
}

test('群组创建允许 2 MiB 裁剪图的 Base64 和文本，转发保持认证', async () => {
  const { serve, forwarded } = proxyFixture();
  const body = JSON.stringify({ name: '小队', description: '一起开黑',
    avatar: 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024).toString('base64') });
  assert.ok(Buffer.byteLength(body) > 4096);
  const response = await serve(new Request('lycan://app/api/groups', { method: 'POST', body }));
  assert.equal(response.status, 201);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, 'https://example.test/api/groups');
  assert.equal(forwarded[0].options.body.toString(), body);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
});

test('文件上传按流构造真实请求，保留认证和元数据，不先读取全部内容', async () => {
  let outgoing;
  let forwardedBody;
  const { serve } = proxyFixture({ net: { fetch: async (url, options) => {
    forwardedBody = options.body;
    // Electron fetchWithSession 同样先构造 Request；这里不运行 Electron 或访问网络。
    outgoing = new Request(url, options);
    return Response.json({ id: 'uploaded' }, { status: 201 });
  } } });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  const request = new Request('lycan://app/api/groups/11111111-1111-4111-8111-111111111111/files', {
    method: 'POST', body: stream, duplex: 'half', headers: {
      'Content-Type': 'application/octet-stream', 'X-File-Name': 'ZmlsZS5iaW4', 'X-File-Size': '3',
      'X-Upload-Id': '22222222-2222-4222-8222-222222222222', 'X-Message-Content': 'aGk',
    },
  });
  const response = await serve(request);
  assert.equal(response.status, 201);
  assert.equal(forwardedBody, request.body);
  assert.equal(request.bodyUsed, false);
  assert.equal(outgoing.headers.get('Authorization'), 'Bearer test-session');
  assert.equal(outgoing.headers.get('X-File-Size'), '3');
  assert.equal(outgoing.headers.get('X-Upload-Id'), '22222222-2222-4222-8222-222222222222');
  assert.equal(outgoing.headers.get('X-Message-Content'), 'aGk');
  assert.deepEqual([...new Uint8Array(await outgoing.arrayBuffer())], [1, 2, 3]);
});

test('页面取消会传给正在等待的上传请求，不产生伪造成功', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let forwardedSignal;
  const { serve } = proxyFixture({ net: { fetch: async (url, options) => {
    new Request(url, options);
    forwardedSignal = options.signal;
    started();
    return new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  } } });
  const request = new Request('lycan://app/api/groups/11111111-1111-4111-8111-111111111111/files', {
    method: 'POST', body: new ReadableStream({}), duplex: 'half', signal: controller.signal,
  });
  const serving = serve(request);
  await ready;
  controller.abort();
  const response = await serving;
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(response.status, 502);
});

test('下载保持响应流与文件头，消费端取消会传给源流', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  });
  const { serve } = proxyFixture({ net: { fetch: async () => new Response(stream, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': '3', 'Content-Disposition': 'attachment; filename="file.bin"',
  } }) } });
  const response = await serve(new Request('lycan://app/api/groups/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222'));
  assert.equal(response.body, stream);
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="file.bin"');
  await response.body.cancel();
  assert.equal(cancelled, true);
});

test('凭据读取失败与网络连接失败有不同反馈，不透传路径或凭据', async () => {
  const loadFailure = proxyFixture({ loadSession: async () => { throw new Error('private/session.bin'); } });
  const unreadable = await loadFailure.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(unreadable.status, 502);
  assert.deepEqual(await unreadable.json(), { message: '无法读取本机登录凭据，请清理本机登录凭据后重试。' });
  assert.equal(loadFailure.forwarded.length, 0);

  const networkFailure = proxyFixture({ net: { fetch: async () => { throw new Error('private-transport-detail'); } } });
  const disconnected = await networkFailure.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(disconnected.status, 502);
  assert.deepEqual(await disconnected.json(), { message: '无法连接业务服务，请检查网络和服务器状态。' });
});

test('兑换响应完整且本机保存成功后才返回资料，会话原文不进入页面', async () => {
  const token = 'a'.repeat(43);
  const user = { id: 'member', nickname: '行者1001', avatar: '', administrator: false };
  const saved = [];
  const { serve } = proxyFixture({ loadSession: async () => undefined,
    net: { fetch: async () => Response.json({ sessionToken: token, user }) },
    saveSession: async (value) => { saved.push(value); } });
  const response = await serve(new Request('lycan://app/api/auth/access/redeem', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 200);
  assert.deepEqual(saved, [token]);
  assert.deepEqual(await response.json(), { user });
});

test('凭据保存失败明确提示本机问题，重试仍可沿原兑换流程完成', async () => {
  const token = 'b'.repeat(43);
  let writes = 0;
  const { serve } = proxyFixture({ loadSession: async () => undefined,
    net: { fetch: async () => Response.json({ sessionToken: token,
      user: { id: 'member', nickname: '朋友', avatar: '', administrator: false } }) },
    saveSession: async () => { if (++writes === 1) throw new Error('private-session-path'); } });
  const request = () => new Request('lycan://app/api/auth/access/redeem', { method: 'POST', body: '{}' });
  const first = await serve(request());
  assert.equal(first.status, 502);
  assert.deepEqual(await first.json(), { message: '无法保存本机登录凭据，请检查数据目录权限和系统加密后重试。' });
  assert.equal((await serve(request())).status, 200);
  assert.equal(writes, 2);
});

test('无效兑换响应不写入凭据，也不伪报网络失败', async () => {
  for (const result of [null, { sessionToken: 'short' }, { sessionToken: 'c'.repeat(43) },
    { sessionToken: 'c'.repeat(43), user: { id: 'member' } }]) {
    let saved = false;
    const { serve } = proxyFixture({ loadSession: async () => undefined,
      net: { fetch: async () => Response.json(result) }, saveSession: async () => { saved = true; } });
    const response = await serve(new Request('lycan://app/api/auth/access/redeem', { method: 'POST', body: '{}' }));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { message: '登录响应无法确认，请重试或联系服主。' });
    assert.equal(saved, false);
  }
});

test('已登录时拒绝兑换，不转发也不保存新凭据', async () => {
  let saved = false;
  const { serve, forwarded } = proxyFixture({ saveSession: async () => { saved = true; } });
  const response = await serve(new Request('lycan://app/api/auth/access/redeem', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 409);
  assert.equal(forwarded.length, 0);
  assert.equal(saved, false);
});

test('当前会话401即使本机清理失败仍通知退出，旧会话401不清理新凭据', async () => {
  const expired = proxyFixture({ net: { fetch: async () => new Response(null, { status: 401 }) },
    clearSession: async () => { throw new Error('private-session-path'); } });
  const response = await expired.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-Lycan-Session-Expired'), 'true');
  assert.equal((await response.json()).code, 'LOCAL_SESSION_CLEAR_FAILED');

  let cleared = false;
  const previous = proxyFixture({ loadSession: async () => 'previous-token',
    net: { fetch: async () => new Response(null, { status: 401 }) }, clearSession: async () => { cleared = true; } });
  const oldResponse = await previous.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(oldResponse.headers.get('X-Lycan-Session-Expired'), 'false');
  assert.equal(cleared, false);
});

test('服务端退出成功但本机文件清理失败明确报告已结束会话', async () => {
  const { serve } = proxyFixture({ net: { fetch: async () => new Response(null, { status: 204 }) },
    clearSession: async () => { throw new Error('private-session-path'); } });
  const response = await serve(new Request('lycan://app/api/auth/logout', { method: 'POST' }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: 'LOCAL_SESSION_CLEAR_FAILED',
    message: '登录已结束，但无法清理本机凭据，请检查数据目录权限。' });
});

test('群组超过 3 MiB 接口预算时本地返回明确 413，不转发到后端', async () => {
  const { serve, forwarded } = proxyFixture();
  const response = await serve(new Request('lycan://app/api/groups', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024 + 1) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: 'REQUEST_TOO_LARGE', detail: '提交内容过大，请缩小图片或减少内容后重试。' });
  assert.equal(forwarded.length, 0);
});

test('个人头像沿用同一 3 MiB 接口预算', async () => {
  const { serve, forwarded } = proxyFixture();
  const body = JSON.stringify({ nickname: '小狼', avatar: 'data:image/png;base64,'
    + Buffer.alloc(2 * 1024 * 1024).toString('base64') });
  assert.equal((await serve(new Request('lycan://app/api/auth/me', { method: 'PUT', body }))).status, 201);
  assert.equal(forwarded[0].options.body.toString(), body);
  assert.equal((await serve(new Request('lycan://app/api/auth/me', { method: 'PUT', body: 'x'.repeat(3 * 1024 * 1024 + 1) }))).status, 413);
  assert.equal(forwarded.length, 1);
});

test('没有放宽其他接口的默认 4 KiB 限制或未授权路由', async () => {
  const { serve, forwarded } = proxyFixture();
  assert.equal((await serve(new Request('lycan://app/api/presence/heartbeat', { method: 'POST', body: 'x'.repeat(4097) }))).status, 413);
  assert.equal((await serve(new Request('lycan://app/api/not-allowed', { method: 'POST', body: '{}' }))).status, 404);
  assert.equal(forwarded.length, 0);
});

test('群组成员制路由严格限制路径和方法，头像编辑沿用载荷预算', async () => {
  const { serve, forwarded } = proxyFixture();
  const groupId = '11111111-1111-4111-8111-111111111111';
  const memberId = '22222222-2222-4222-8222-222222222222';
  for (const [method, path] of [
    ['POST', '/api/groups/join'], ['PUT', `/api/groups/${groupId}`],
    ['GET', `/api/groups/${groupId}/candidates?search=demo&offset=0`],
    ['POST', `/api/groups/${groupId}/members`], ['POST', `/api/groups/${groupId}/owner`],
    ['POST', `/api/groups/${groupId}/invite-code`], ['POST', `/api/groups/${groupId}/invite-code/refresh`],
    ['DELETE', `/api/groups/${groupId}/members/${memberId}`], ['DELETE', `/api/groups/${groupId}`],
    ['GET', '/api/rtc/room-occupancies'],
  ]) {
    const response = await serve(new Request('lycan://app' + path, { method, ...(['POST', 'PUT'].includes(method) ? { body: '{}' } : {}) }));
    assert.equal(response.status, 201, `${method} ${path}`);
    assert.equal(forwarded.at(-1).options.headers.Authorization, 'Bearer test-session');
  }
  for (const [method, path] of [['GET', `/api/groups/${groupId}/invite-code`],
    ['POST', `/api/groups/${groupId}/candidates`], ['DELETE', `/api/groups/${groupId}/members/not-a-uuid`]]) {
    assert.equal((await serve(new Request('lycan://app' + path, { method }))).status, 404);
  }
  assert.equal((await serve(new Request(`lycan://app/api/groups/${groupId}`, { method: 'PUT', body: 'x'.repeat(3 * 1024 * 1024 + 1) }))).status, 413);
});

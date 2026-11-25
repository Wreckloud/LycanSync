const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
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
  const context = {
    URL, Headers, Request, Response, Buffer, AbortSignal,
    backend: new URL('https://example.test'),
    sessionToken: 'test-session',
    sessionRevision: 0, sessionLoginInProgress: false, sessionClearTask: undefined,
    trustedUrl: (url) => url.startsWith('lycan://app/'),
    loadSession: async () => 'test-session',
    saveSession: async () => {},
    clearSession: async () => {},
    net: { fetch: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json({ id: 'test-group' }, { status: 201 });
    } },
    ...overrides,
  };
  const serve = runInNewContext(`${main.slice(policyStart, policyEnd)}\n${main.slice(serveStart, serveEnd)}; serveApplication`, context);
  return { serve, forwarded, context };
}

test('原生下载仅保存已授权群文件，系统取消不请求数据，成功写盘后才返回', async t => {
  const { mkdtemp, readFile, rm } = require('node:fs/promises');
  const directory = await mkdtemp(join(require('node:os').tmpdir(), 'lycan-chat-ipc-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const id = require('node:crypto').randomUUID();
  const path = '/api/groups/' + id + '/files/' + id;
  const filePath = join(directory, 'saved.json');
  const body = Buffer.from('{"test":"群文件"}');
  let requests = 0;
  const { serve, context } = proxyFixture({ net: { fetch(url, options) {
    requests++;
    assert.equal(url, 'https://example.test' + path);
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    return new Response(body);
  } } });
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const handlers = {};
  let canceled = true;
  const chatDownloads = new Map();
  runInNewContext(main.slice(main.indexOf("ipcMain.on('chat:cancel-download'"), main.indexOf("ipcMain.handle('diagnostics:process-metrics'")), Object.assign(context, {
    ipcMain: { on(name, fn) { handlers[name] = fn; }, handle(name, fn) { handlers[name] = fn; } },
    trustedSender: event => event.trusted, closing: false, chatDownloads, mainWindow: {},
    AbortController, APP_ORIGIN: 'lycan://app', serveApplication: serve, resolve, win32: require('node:path').win32,
    app: { getPath: () => directory }, dialog: { showSaveDialog: async () => ({ canceled, filePath }) },
    saveChatDownload: require('./chat-download.cjs').saveChatDownload,
  }));
  let loaded;
  const event = { trusted: true, sender: { send(channel, key, bytes) {
    assert.equal(channel, 'chat:download-progress');
    assert.equal(key, id);
    loaded = bytes;
  } } };
  const save = (sender, resource) => handlers['chat:download'](sender, id, resource, 'sample.json', body.length);
  await assert.rejects(save({ trusted: false }, path), /请求无效/);
  await assert.rejects(save(event, '/api/groups'), /请求无效/);
  assert.equal(await save(event, path), 'cancelled');
  assert.equal(requests, 0);
  canceled = false;
  assert.equal(await save(event, path), 'saved');
  assert.equal(requests, 1);
  assert.equal(loaded, body.length);
  assert.deepEqual(await readFile(filePath), body);
  assert.equal(chatDownloads.size, 0);
});

function sessionFixture(readEncrypted, overrides = {}) {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf('async function loadSession(');
  const end = main.indexOf('function trustedUrl(', start);
  const clearStart = main.indexOf("ipcMain.handle('auth:clear',");
  const clearEnd = main.indexOf('\nipcMain.handle(', clearStart + 1);
  assert.ok(start > 0 && end > start);
  const counts = { reads: 0, decryptions: 0 };
  const context = {
    sessionToken: undefined, sessionLoaded: false, sessionLoadPromise: undefined,
    sessionRevision: 0, sessionMutationPromise: Promise.resolve(), sessionClearTask: undefined,
    backend: new URL('https://example.test'), resolve,
    app: { getPath: () => 'isolated-profile' },
    readFile: async () => { counts.reads++; return readEncrypted(); },
    safeStorage: { isEncryptionAvailable: () => true,
      decryptString: value => { counts.decryptions++; return value.toString(); }, encryptString: value => Buffer.from(value) },
    loginPreferences: { set: async () => {}, clear: async () => {} }, mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {},
    returnToAccountEntry: async () => {}, trustedSender: () => true, cancelChatDownloads() {},
    audioShortcuts: { clear() {} }, screenShareWindows: { closeAll() {} },
    activityMonitor: { stop() {}, clearMappings() {} }, voiceOverlay: { clear() {} },
    ...overrides,
  };
  let clearAccount;
  context.ipcMain = { handle: (_name, callback) => { clearAccount = () => callback({}); } };
  const methods = runInNewContext(`${main.slice(start, end)}\n${main.slice(clearStart, clearEnd)}\n({ loadSession, saveSession, clearSession })`, context);
  return { ...methods, clearAccount, context, counts };
}

function encryptedTestSession(token = 'a'.repeat(43)) {
  return Buffer.from(JSON.stringify({ server: 'https://example.test', token }));
}

test('清除当前会话同步停止活动检测并清空账号映射，文件清理仍按序完成', async () => {
  const calls = [];
  const f = sessionFixture(async () => undefined, {
    activityMonitor: { stop: () => calls.push('stop'), clearMappings: () => calls.push('clear') },
    unlink: async () => { calls.push('unlink'); },
  });
  const clearing = f.clearSession();
  assert.deepEqual(calls, ['stop', 'clear']);
  await clearing;
  assert.deepEqual(calls, ['stop', 'clear', 'unlink']);
});

test('并发读取会话只读盘和解密一次，后续读取复用已加载状态', async () => {
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const f = sessionFixture(() => ready);
  const pending = Array.from({ length: 6 }, () => f.loadSession());
  complete(encryptedTestSession());
  assert.deepEqual(await Promise.all(pending), Array(6).fill('a'.repeat(43)));
  assert.equal(f.counts.reads, 1);
  assert.equal(f.counts.decryptions, 1);
  assert.equal(await f.loadSession(), 'a'.repeat(43));
  assert.equal(f.counts.reads, 1);
});

test('清除凭据后迟到的旧读取不能恢复会话，也不继续解密旧文件', async () => {
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const f = sessionFixture(() => ready);
  const pending = f.loadSession();
  await f.clearSession();
  complete(encryptedTestSession());
  assert.equal(await pending, undefined);
  assert.equal(await f.loadSession(), undefined);
  assert.equal(f.counts.decryptions, 0);
});

test('保存新会话后迟到的旧读取不能覆盖新凭据', async () => {
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const f = sessionFixture(() => ready);
  const pending = f.loadSession();
  const token = 'b'.repeat(43);
  await f.saveSession(token, 'new-account');
  complete(encryptedTestSession());
  assert.equal(await pending, token);
  assert.equal(await f.loadSession(), token);
  assert.equal(f.counts.decryptions, 0);
});

test('共享的读取失败明确返回错误，修复后可重新读取而不永久缓存失败', async () => {
  let fail;
  const broken = new Promise((_resolve, reject) => { fail = reject; });
  const f = sessionFixture(() => broken);
  const pending = Array.from({ length: 6 }, () => f.loadSession());
  fail(Object.assign(new Error('synthetic read failure'), { code: 'EIO' }));
  const results = await Promise.allSettled(pending);
  assert.equal(results.every(result => result.status === 'rejected' && /无法读取本机登录信息/.test(result.reason.message)), true);
  f.context.readFile = async () => { f.counts.reads++; return encryptedTestSession(); };
  assert.equal(await f.loadSession(), 'a'.repeat(43));
  assert.equal(f.counts.reads, 2);
});

test('清除已确认后，旧读取的迟到错误不覆盖当前未登录状态', async () => {
  let fail;
  const broken = new Promise((_resolve, reject) => { fail = reject; });
  const f = sessionFixture(() => broken);
  const pending = f.loadSession();
  await f.clearSession();
  fail(Object.assign(new Error('obsolete synthetic read failure'), { code: 'EIO' }));
  assert.equal(await pending, undefined);
  assert.equal(await f.loadSession(), undefined);
});

test('转让前验证恢复密码经桌面代理转发并保留会话，不触发转让或更换登录', async () => {
  let forwardedRequest;
  let saved = 0;
  let cleared = 0;
  const { serve } = proxyFixture({
    saveSession: async () => { saved++; },
    clearSession: async () => { cleared++; },
    net: { fetch: async (url, options) => {
      forwardedRequest = { url, options };
      return new Response(null, { status: 204 });
    } },
  });
  const path = '/api/auth/account/transfer/verify';
  const body = JSON.stringify({ password: 'test12' });
  const response = await serve(new Request('lycan://app' + path, { method: 'POST', body }));
  assert.equal(response.status, 204);
  assert.equal(forwardedRequest.url, 'https://example.test' + path);
  assert.equal(forwardedRequest.options.method, 'POST');
  assert.equal(forwardedRequest.options.headers.Authorization, 'Bearer test-session');
  assert.equal(Buffer.from(forwardedRequest.options.body).toString(), body);
  assert.equal(saved, 0);
  assert.equal(cleared, 0);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await serve(new Request('lycan://app' + path, { method }))).status, 404);
  }
  assert.equal((await serve(new Request('lycan://app' + path + '/extra', { method: 'POST', body }))).status, 404);
});

test('恢复密码验证失败返回服务器的明确错误，不当作验证成功', async () => {
  const { serve } = proxyFixture({ net: { fetch: async () => Response.json({
    code: 'INVALID_REQUEST', detail: '请先设置并输入正确的服主恢复密码',
  }, { status: 400 }) } });
  const response = await serve(new Request('lycan://app/api/auth/account/transfer/verify', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).detail, '请先设置并输入正确的服主恢复密码');
});

test('服主配置状态仅转发固定 GET 路径并附带会话，权限由后端复核', async () => {
  const { serve, forwarded } = proxyFixture();
  const path = '/api/auth/server-settings';
  const response = await serve(new Request('lycan://app' + path));
  assert.equal(response.status, 201);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, 'https://example.test' + path);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await serve(new Request('lycan://app' + path, { method }))).status, 404);
  }
  assert.equal((await serve(new Request('lycan://app' + path + '/extra'))).status, 404);
  assert.equal(forwarded.length, 1);
});

test('消息长轮询保留固定路由、认证、取消信号与长等待预算', async () => {
  const timeouts = [];
  const { serve, forwarded } = proxyFixture({ AbortSignal: {
    any: signals => AbortSignal.any(signals),
    timeout: milliseconds => { timeouts.push(milliseconds); return AbortSignal.timeout(milliseconds); },
  } });
  const controller = new AbortController();
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/messages?wait=true&requestId=1';
  await serve(new Request('lycan://app' + path, { signal: controller.signal }));
  assert.equal(timeouts.at(-1), 52_000);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
  controller.abort();
  assert.equal(forwarded[0].options.signal.aborted, true);
  await serve(new Request('lycan://app' + path.replace('?wait=true&requestId=1', '')));
  assert.equal(timeouts.at(-1), 15_000);
});

test('成员资料只开放明确的同源 GET 路径并保留认证', async () => {
  const { serve, forwarded } = proxyFixture();
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/members/22222222-2222-4222-8222-222222222222/profile';
  await serve(new Request('lycan://app' + path));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal(forwarded[0].url, 'https://example.test' + path);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await serve(new Request('lycan://app' + path, { method }))).status, 404);
  }
  assert.equal((await serve(new Request('lycan://app' + path + '/extra'))).status, 404);
  assert.equal(forwarded.length, 1);
});

test('QQ 配置仅代理认证的读取与保存，拒绝额外路径和超长请求', async () => {
  const { serve, forwarded } = proxyFixture();
  const path = 'lycan://app/api/auth/server-settings/qq';
  await serve(new Request(path));
  await serve(new Request(path, { method: 'PUT', body: JSON.stringify({ enabled: false, appId: '', appKey: '', callbackUrl: '' }) }));
  assert.equal(forwarded.length, 2);
  for (const request of forwarded) {
    assert.equal(request.options.headers.Authorization, 'Bearer test-session');
    assert.equal(request.url, 'https://example.test/api/auth/server-settings/qq');
  }
  assert.equal((await serve(new Request(path, { method: 'POST' }))).status, 404);
  assert.equal((await serve(new Request(path + '/secret'))).status, 404);
  assert.equal((await serve(new Request(path, { method: 'PUT', body: 'x'.repeat(4097) }))).status, 413);
  assert.equal(forwarded.length, 2);
});

test('音效处理只开放固定 POST，上传字节有界且返回原始音频响应', async () => {
  const { serve, forwarded } = proxyFixture({ net: { fetch: async (url, options) => {
    forwarded.push({ url, options });
    return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav', 'X-Content-Type-Options': 'nosniff' } });
  } } });
  const path = 'lycan://app/api/audio/entrance-sound/normalize';
  const result = await serve(new Request(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([4]) }));
  assert.equal(result.headers.get('Content-Type'), 'audio/wav');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2]);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal((await serve(new Request(path, { method: 'POST', body: new Uint8Array(512 * 1024 + 1) }))).status, 413);
  assert.equal((await serve(new Request(path))).status, 404);
  assert.equal((await serve(new Request(path + '/extra', { method: 'POST' }))).status, 404);
  assert.equal(forwarded.length, 1);
});

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
      'X-Optimize-Video': 'true', 'X-Upload-Id': '22222222-2222-4222-8222-222222222222', 'X-Message-Content': 'aGk',
      'X-File-Message': '33333333-3333-4333-8333-333333333333',
    },
  });
  const response = await serve(request);
  assert.equal(response.status, 201);
  assert.equal(forwardedBody, request.body);
  assert.equal(request.bodyUsed, false);
  assert.equal(outgoing.headers.get('Authorization'), 'Bearer test-session');
  assert.equal(outgoing.headers.get('X-File-Size'), '3');
  assert.equal(outgoing.headers.get('X-File-Message'), '33333333-3333-4333-8333-333333333333');
  assert.equal(outgoing.headers.get('X-Optimize-Video'), 'true');
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

test('已解压的响应不沿用压缩字节长度，仍按流交付完整内容', async () => {
  const contents = JSON.stringify({ messages: [{ content: '合成消息'.repeat(100) }] });
  for (const encoding of ['gzip', 'br', 'zstd']) {
    const source = new Response(contents, { headers: {
      'Content-Type': 'application/json', 'Content-Encoding': encoding, 'Content-Length': '80',
    } });
    const { serve } = proxyFixture({ net: { fetch: async () => source } });
    const response = await serve(new Request('lycan://app/api/groups/11111111-1111-4111-8111-111111111111/messages'));
    assert.equal(response.body, source.body);
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(response.headers.get('Content-Encoding'), null);
    assert.equal(await response.text(), contents);
  }
});

test('凭据读取失败与网络连接失败有不同反馈，不透传路径或凭据', async () => {
  const loadFailure = proxyFixture({ loadSession: async () => { throw new Error('private/session.bin'); } });
  const unreadable = await loadFailure.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(unreadable.status, 502);
  assert.deepEqual(await unreadable.json(), { message: '无法读取本机登录信息，请清除后重新登录。' });
  assert.equal(loadFailure.forwarded.length, 0);

  const networkFailure = proxyFixture({ net: { fetch: async () => { throw new Error('private-transport-detail'); } } });
  const disconnected = await networkFailure.serve(new Request('lycan://app/api/auth/me'));
  assert.equal(disconnected.status, 502);
  assert.deepEqual(await disconnected.json(), { message: '无法连接服务器，请检查网络和服务器状态。' });
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
  assert.deepEqual(await first.json(), { message: '无法保存本机登录信息，请检查数据目录的读写权限和系统加密功能后重试。' });
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
    assert.deepEqual(await response.json(), { message: '无法确认登录结果。' });
    assert.equal(saved, false);
  }
});

test('已登录时拒绝兑换，不转发也不保存新凭据', async () => {
  for (const path of ['access/redeem', 'account/recover', 'qq/exchange']) {
    let saved = false;
    const { serve, forwarded } = proxyFixture({ saveSession: async () => { saved = true; } });
    const response = await serve(new Request('lycan://app/api/auth/' + path, { method: 'POST', body: '{}' }));
    assert.equal(response.status, 409, path);
    assert.equal(forwarded.length, 0);
    assert.equal(saved, false);
  }
});

function loginResult(token = 'l'.repeat(43)) {
  return Response.json({ sessionToken: token, user: { id: 'member', nickname: '合成账号', avatar: '', administrator: false } });
}
function loginRequest(path = 'access/redeem') {
  return new Request('lycan://app/api/auth/' + path, { method: 'POST', body: '{}' });
}

test('认证等待网络期间其他入口不能并发兑换或保存', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const networkStarted = new Promise(resolve => { started = resolve; });
  let requests = 0, writes = 0;
  const f = proxyFixture({ loadSession: async () => undefined,
    net: { fetch: async () => { if (++requests === 1) { started(); await gate; } return loginResult(); } },
    saveSession: async () => { writes++; } });
  const first = f.serve(loginRequest());
  await networkStarted;
  try {
    const second = await f.serve(loginRequest('qq/exchange'));
    assert.equal(second.status, 409);
    assert.equal(requests, 1);
  } finally { release(); await first; }
  assert.equal(writes, 1);
});

test('认证等待本机写盘时仍保留唯一兑换资格', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  let writes = 0;
  const f = proxyFixture({ loadSession: async () => undefined, net: { fetch: async () => loginResult() },
    saveSession: async () => { if (++writes === 1) { started(); await gate; } } });
  const first = f.serve(loginRequest());
  await writing;
  try { assert.equal((await f.serve(loginRequest('qq/exchange'))).status, 409); }
  finally { release(); await first; }
  assert.equal(writes, 1);
});

test('清除后迟到的认证响应不再发起本机保存', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const networkStarted = new Promise(resolve => { started = resolve; });
  let writes = 0;
  const f = proxyFixture({ loadSession: async () => undefined,
    net: { fetch: async () => { started(); await gate; return loginResult(); } },
    saveSession: async () => { writes++; } });
  const pending = f.serve(loginRequest());
  await networkStarted;
  f.context.sessionRevision++;
  release();
  assert.equal((await pending).status, 409);
  assert.equal(writes, 0);
});

test('认证失败后释放资格，下一次可重新兑换', async () => {
  let requests = 0;
  const f = proxyFixture({ loadSession: async () => undefined,
    net: { fetch: async () => { if (++requests === 1) throw new Error('synthetic failure'); return loginResult(); } } });
  assert.equal((await f.serve(loginRequest())).status, 502);
  assert.equal((await f.serve(loginRequest('qq/exchange'))).status, 200);
});

test('本机保存完成时会话已清除，不再向页面确认旧登录', async () => {
  const f = proxyFixture({ loadSession: async () => undefined, net: { fetch: async () => loginResult() },
    saveSession: async () => { f.context.sessionRevision++; } });
  assert.equal((await f.serve(loginRequest())).status, 409);
});

test('显式清除的媒体收尾与偏好清理期间不开始新的认证', async () => {
  const f = proxyFixture({ loadSession: async () => undefined, sessionClearTask: Promise.resolve(),
    net: { fetch: async () => loginResult() } });
  assert.equal((await f.serve(loginRequest('qq/exchange'))).status, 409);
});

test('显式清除进入媒体收尾就失效旧认证，重复IPC共用一次完整清理', async () => {
  let release, calls = 0, preferencesCleared = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = sessionFixture(async () => undefined, {
    returnToAccountEntry: async () => { calls++; await gate; },
    loginPreferences: { set: async () => {}, clear: async () => { preferencesCleared++; } },
  });
  const first = f.clearAccount();
  const second = f.clearAccount();
  try {
    assert.ok(f.context.sessionRevision > 0);
    assert.equal(calls, 1);
    assert.ok(f.context.sessionClearTask);
  } finally { release(); await Promise.all([first, second]); }
  assert.equal(preferencesCleared, 1);
  assert.equal(f.context.sessionClearTask, undefined);
});

for (const phase of ['preferences', 'mkdir', 'write']) {
  test(`在${phase}等待期间清除，旧保存不再恢复内存或磁盘凭据`, async () => {
    let release, started, disk;
    const gate = new Promise(resolve => { release = resolve; });
    const writing = new Promise(resolve => { started = resolve; });
    const wait = async step => { if (phase === step) { started(); await gate; } };
    const f = sessionFixture(async () => undefined, {
      loginPreferences: { set: () => wait('preferences') }, mkdir: () => wait('mkdir'),
      writeFile: async (_path, bytes) => { await wait('write'); disk = bytes; },
      unlink: async () => { disk = undefined; },
    });
    const saving = f.saveSession('o'.repeat(43), 'old').then(() => null, error => error);
    await writing;
    const clearing = f.clearSession();
    assert.equal(f.context.sessionToken, undefined);
    release();
    const error = await saving;
    await clearing;
    assert.ok(error, '旧保存必须明确取消');
    assert.equal(f.context.sessionToken, undefined);
    assert.equal(disk, undefined);
  });
}

test('旧写入等待、清除与新保存按序完成，最终只保留新凭据', async () => {
  let release, started, disk, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  const f = sessionFixture(async () => undefined, {
    writeFile: async (_path, bytes) => { if (++writes === 1) { started(); await gate; } disk = bytes; },
    unlink: async () => { disk = undefined; },
  });
  const old = f.saveSession('o'.repeat(43), 'old').then(() => null, error => error);
  await writing;
  const clearing = f.clearSession();
  const renewed = f.saveSession('n'.repeat(43), 'new');
  release();
  assert.ok(await old);
  await clearing;
  await renewed;
  assert.equal(f.context.sessionToken, 'n'.repeat(43));
  assert.equal(JSON.parse(disk.toString()).token, 'n'.repeat(43));
});

test('写入失败不阻塞后续清除与新的保存', async () => {
  let writes = 0;
  const f = sessionFixture(async () => undefined, { writeFile: async () => { if (++writes === 1) throw new Error('synthetic disk failure'); } });
  await assert.rejects(f.saveSession('o'.repeat(43), 'old'));
  await f.clearSession();
  await f.saveSession('n'.repeat(43), 'new');
  assert.equal(f.context.sessionToken, 'n'.repeat(43));
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
    message: '已退出登录，但本机登录信息未能清除。请检查数据目录的读写权限。' });
});

test('服务器确认注销后，本机凭据清理失败仍通知页面结束会话', async () => {
  const { serve } = proxyFixture({ net: { fetch: async () => new Response(null, { status: 204 }) },
    clearSession: async () => { throw new Error('private-session-path'); } });
  const response = await serve(new Request('lycan://app/api/auth/account/close', { method: 'POST' }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('X-Lycan-Session-Expired'), 'true');
  assert.deepEqual(await response.json(), { code: 'LOCAL_SESSION_CLEAR_FAILED',
    message: '账号已注销。本机登录信息未能清除，请检查数据目录的读写权限。' });
});

test('群组超过 3 MiB 接口预算时本地返回明确 413，不转发到后端', async () => {
  const { serve, forwarded } = proxyFixture();
  const response = await serve(new Request('lycan://app/api/groups', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024 + 1) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: 'REQUEST_TOO_LARGE', detail: '提交的内容过大，请缩小图片或减少内容后重试。' });
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


test('服主恢复失败保留凭据，成功只在主进程保存并移除响应中的令牌', async () => {
  const token = 'r'.repeat(43);
  const saved = [];
  let cleared = false;
  let success = false;
  const { serve, forwarded } = proxyFixture({ loadSession: async () => null, sessionToken: null,
    saveSession: async (...args) => { saved.push(args); }, clearSession: async () => { cleared = true; },
    net: { fetch: async (url, options) => {
      forwarded.push({ url, options });
      return success ? Response.json({ sessionToken: token, user: { id: 'owner', nickname: '服主', avatar: '', administrator: true } })
        : Response.json({ detail: '密码错误' }, { status: 401 });
    } },
  });
  const request = () => new Request('lycan://app/api/auth/account/recover', { method: 'POST', body: '{}' });
  assert.equal((await serve(request())).status, 401);
  assert.equal(cleared, false);
  assert.equal(saved.length, 0);
  success = true;
  const result = await serve(request());
  assert.equal((await result.json()).sessionToken, undefined);
  assert.deepEqual(saved, [[token, 'owner']]);
  assert.equal(forwarded[0].options.headers.Authorization, undefined);
});

test('注销成功清除当前会话，服主恢复不能覆盖已有登录', async () => {
  let cleared = false;
  const f = proxyFixture({ clearSession: async () => { cleared = true; } });
  assert.equal((await f.serve(new Request('lycan://app/api/auth/account/recover', { method: 'POST', body: '{}' }))).status, 409);
  assert.equal(f.forwarded.length, 0);
  await f.serve(new Request('lycan://app/api/auth/account/close', { method: 'POST', body: '{}' }));
  assert.equal(cleared, true);
});


test('待使用链接的复用、复制与备注走明确的认证路由', async () => {
  const { serve, forwarded } = proxyFixture();
  const base = 'lycan://app/api/auth/access/links';
  const id = '/11111111-1111-4111-8111-111111111111';
  for (const [path, method] of [[base + '/invite', 'POST'], [base + id + '/url', 'GET'], [base + id + '/note', 'PUT']]) {
    assert.equal((await serve(new Request(path, { method }))).status, 201);
  }
  assert.equal(forwarded.length, 3);
  for (const request of forwarded) assert.equal(request.options.headers.Authorization, 'Bearer test-session');
  for (const suffix of ['/url', '/note', '/renew']) {
    assert.equal((await serve(new Request(base + id + suffix, { method: 'DELETE' }))).status, 404);
  }
  assert.equal(forwarded.length, 3);
});


test('本地录像路由不读取会话或访问服务器，关闭期间拒绝新预览', async () => {
  const library = {};
  let calls = 0;
  const serveRecordingMedia = async (request, currentLibrary) => {
    assert.equal(currentLibrary, library);
    assert.equal(request.headers.get('Range'), 'bytes=20-');
    calls++;
    return new Response('preview', { status: 206 });
  };
  const dependencies = { closing: false, recording: { library }, serveRecordingMedia,
    loadSession: () => { throw new Error('must not read credentials'); } };
  const f = proxyFixture(dependencies);
  const request = new Request('lycan://app/recordings/11111111-1111-4111-8111-111111111111', { headers: { Range: 'bytes=20-' } });
  assert.equal((await f.serve(request)).status, 206);
  assert.equal(f.forwarded.length, 0);
  assert.equal((await proxyFixture({ ...dependencies, closing: true }).serve(request)).status, 503);
  assert.equal((await f.serve(new Request('lycan://other/recordings/test'))).status, 403);
  assert.equal(calls, 1);
});


test('媒体分段请求保留 Range、认证、取消与 206 响应，不先缓冲完整文件', async () => {
  let forwarded;
  const chunk = new Uint8Array([2, 3, 4]);
  const { serve } = proxyFixture({ net: { fetch: async (url, options) => {
    forwarded = { url, options };
    return new Response(chunk, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '3',
      'Content-Range': 'bytes 2-4/1000', 'Accept-Ranges': 'bytes' } });
  } } });
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222/media';
  const controller = new AbortController();
  const response = await serve(new Request('lycan://app' + path, { headers: { Range: 'bytes=2-4' }, signal: controller.signal }));
  assert.equal(forwarded.options.headers.Range, 'bytes=2-4');
  assert.equal(forwarded.options.headers.Authorization, 'Bearer test-session');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-4/1000');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), chunk);
  controller.abort(); assert.equal(forwarded.options.signal.aborted, true);
  assert.equal((await serve(new Request('lycan://app' + path + '/extra'))).status, 404);
  assert.equal((await serve(new Request('lycan://app' + path, { method: 'DELETE' }))).status, 404);
});

test('封面接口只开放读取，完整透传无封面的 204 与范围失败 416', async () => {
  let status = 204;
  const { serve } = proxyFixture({ net: { fetch: async () => new Response(null, { status,
    headers: status === 416 ? { 'Content-Range': 'bytes */10' } : {} }) } });
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222/thumbnail';
  assert.equal((await serve(new Request('lycan://app' + path))).status, 204);
  status = 416;
  const response = await serve(new Request('lycan://app' + path.replace('thumbnail', 'media')));
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */10');
});

test('群聊图片缩略图仅代理固定 GET 路径并携带当前会话', async () => {
  const { serve, forwarded } = proxyFixture();
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/attachments/22222222-2222-4222-8222-222222222222/thumbnail';
  await serve(new Request('lycan://app' + path));
  assert.equal(new URL(forwarded[0].url).pathname, path);
  assert.equal(forwarded[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal((await serve(new Request('lycan://app' + path, { method: 'POST' }))).status, 404);
  assert.equal((await serve(new Request('lycan://app' + path + '/extra'))).status, 404);
  assert.equal(forwarded.length, 1);
});


test('兼容视频仅主动 POST 转换，状态查询与分段播放使用固定认证路由', async () => {
  const { serve, forwarded } = proxyFixture();
  const path = '/api/groups/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222/preview';
  for (const method of ['POST', 'GET']) {
    assert.equal((await serve(new Request('lycan://app' + path, { method }))).status, 201);
  }
  await serve(new Request('lycan://app' + path + '/media', { headers: { Range: 'bytes=12-34' } }));
  assert.equal(forwarded[2].options.headers.Range, 'bytes=12-34');
  assert.equal(forwarded[2].options.headers.Authorization, 'Bearer test-session');
  for (const [method, suffix] of [['DELETE', ''], ['POST', '/media'], ['GET', '/unexpected']]) {
    assert.equal((await serve(new Request('lycan://app' + path + suffix, { method }))).status, 404);
  }
});

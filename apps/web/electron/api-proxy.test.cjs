const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function proxyFixture() {
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
    net: { fetch: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json({ id: 'test-group' }, { status: 201 });
    } },
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

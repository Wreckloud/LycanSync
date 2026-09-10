import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { BrowserContext } from '@playwright/test';

// 测试专用 API 替身：身份接口固定测试账号，媒体仍连接真实本机 LiveKit。
// 不依赖开发后端、不创建真实账号，不把绕过入口编译进客户端。
const settings = Object.fromEntries(readFileSync(resolve('../../.env'), 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const key = settings.LIVEKIT_API_KEY;
const secret = settings.LIVEKIT_API_SECRET;
const liveKitPort = settings.LIVEKIT_PORT || '7990';
const liveKitHttpUrl = `http://127.0.0.1:${liveKitPort}`;
const liveKitWebSocketUrl = `ws://127.0.0.1:${liveKitPort}`;
const roomPrefix = 'lycan-sync-e2e-';
export const testUser = (nickname = '测试小狼') => ({ id: randomUUID(), nickname, avatar: '', administrator: true });

function jwt(grants: object, subject?: string, name?: string) {
  if (!key || !secret) throw new Error('媒体测试需要本机 LiveKit 配置');
  const now = Math.floor(Date.now() / 1000);
  const body = [ { alg: 'HS256', typ: 'JWT' },
    { iss: key, sub: subject, name, nbf: now - 5, exp: now + 600, video: grants } ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

export async function summary(groupId = 'pack') {
  const response = await fetch(liveKitHttpUrl + '/twirp/livekit.RoomService/ListParticipants', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt({ roomList: true, roomAdmin: true, room: roomPrefix + groupId }) },
    body: JSON.stringify({ room: roomPrefix + groupId }),
  });
  if (response.status === 404) return { participantCount: 0, participantNames: [] };
  if (!response.ok) throw new Error('LiveKit 测试摘要失败：' + response.status);
  const result = await response.json() as { participants?: { name: string }[] };
  return { participantCount: result.participants?.length ?? 0, participantNames: result.participants?.map((p) => p.name) ?? [] };
}

async function api(path: string, body: string, user: ReturnType<typeof testUser>) {
  if (path === '/api/system/initialization') return { initialized: true };
  if (path === '/api/auth/me') return user;
  if (path === '/api/auth/session') {
    return { id: user.id, nickname: user.nickname, administrator: user.administrator };
  }
  if (path.startsWith('/api/rtc/room-summary')) return summary(new URL(path, 'http://localhost').searchParams.get('groupId') ?? 'pack');
  if (path === '/api/rtc/token') {
    const { groupId } = JSON.parse(body);
    const roomName = roomPrefix + groupId;
    return { serverUrl: liveKitWebSocketUrl, roomName, participantIdentity: user.id,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      token: jwt({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true,
        canPublishSources: ['microphone', 'screen_share'], canPublishData: false, canUpdateOwnMetadata: true }, user.id, user.nickname) };
  }
  throw new Error('未提供测试 API：' + path);
}

const contexts = new WeakMap<BrowserContext, ReturnType<typeof testUser>>();
export async function installAuthenticatedRtc(context: BrowserContext) {
  if (contexts.has(context)) return;
  const user = testUser();
  contexts.set(context, user);
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    try {
      const result = await api(url.pathname + url.search, route.request().postData() ?? '', user);
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 503, json: { detail: '测试 API 失败' } }); }
  });
}
export function renameTestUser(context: BrowserContext, nickname: string) {
  const user = contexts.get(context);
  if (!user) throw new Error('请先安装测试身份');
  user.nickname = nickname;
}
export async function startDesktopApi(nickname = '测试小狼') {
  const user = testUser(nickname);
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const result = await api(request.url ?? '/', body, user);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch { response.writeHead(503); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 API 未启动');
  return { url: 'http://127.0.0.1:' + address.port, close: () => new Promise<void>((done, reject) =>
    server.close((error) => error ? reject(error) : done())) };
}

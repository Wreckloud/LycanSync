import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { BrowserContext } from '@playwright/test';

// 测试专用 API 替身：身份接口固定测试账号，媒体仍连接真实本机 LiveKit。
// 不依赖开发后端、不创建真实账号，不把绕过入口编译进客户端。
let liveKitConfiguration: { key: string; secret: string; httpUrl: string; webSocketUrl: string } | undefined;
function liveKitSettings() {
  if (liveKitConfiguration) return liveKitConfiguration;
  // 收集测试不读开发配置；显式测试凭据不能与项目密钥混用。
  const explicit = process.env.LIVEKIT_API_KEY !== undefined || process.env.LIVEKIT_API_SECRET !== undefined;
  const settings = explicit ? process.env : Object.fromEntries(readFileSync(resolve('../../.env'), 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#')).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  const key = settings.LIVEKIT_API_KEY;
  const secret = settings.LIVEKIT_API_SECRET;
  if (!key || !secret) throw new Error('媒体测试需要成对配置 LIVEKIT_API_KEY 和 LIVEKIT_API_SECRET');
  const port = process.env.LIVEKIT_PORT || settings.LIVEKIT_PORT || '7990';
  liveKitConfiguration = { key, secret, httpUrl: `http://127.0.0.1:${port}`, webSocketUrl: `ws://127.0.0.1:${port}` };
  return liveKitConfiguration;
}
const roomPrefix = 'lycan-sync-group-';
let testGroupId: string = randomUUID();
let testOtherGroupId: string = randomUUID();
export const testUser = (nickname = '测试小狼') => ({ id: randomUUID(), nickname, avatar: '', administrator: true });

export function useNewTestGroups() {
  testGroupId = randomUUID();
  testOtherGroupId = randomUUID();
}

function jwt(grants: object, subject?: string, name?: string) {
  const { key, secret } = liveKitSettings();
  const now = Math.floor(Date.now() / 1000);
  const body = [ { alg: 'HS256', typ: 'JWT' },
    { iss: key, sub: subject, name, nbf: now - 5, exp: now + 600, video: grants } ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

export async function summary(groupId: string = testGroupId) {
  const response = await fetch(liveKitSettings().httpUrl + '/twirp/livekit.RoomService/ListParticipants', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt({ roomList: true, roomAdmin: true, room: roomPrefix + groupId }) },
    body: JSON.stringify({ room: roomPrefix + groupId }),
  });
  if (response.status === 404) return { participantCount: 0, participants: [] };
  if (!response.ok) throw new Error('LiveKit 测试摘要失败：' + response.status);
  const result = await response.json() as { participants?: { identity: string; name: string }[] };
  return { participantCount: result.participants?.length ?? 0,
    participants: result.participants?.map((p) => ({ participantIdentity: p.identity, displayName: p.name })) ?? [] };
}

async function api(path: string, body: string, user: ReturnType<typeof testUser>) {
  if (path === '/api/auth/options') return { mode: 'invite', qqAvailable: false, initialized: true };
  if (path === '/api/system/initialization') return { initialized: true };
  if (path === '/api/auth/me') return user;
  if (path === '/api/auth/session') {
    return { id: user.id, nickname: user.nickname, administrator: user.administrator };
  }
  const groups = [
    { id: testGroupId, name: '开黑小队' },
    { id: testOtherGroupId, name: '周末车队' },
  ].map((group) => ({ ...group, description: '', avatar: '', role: 'OWNER', memberCount: 1,
    createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }));
  if (path === '/api/groups') return groups;
  if (path === '/api/rtc/room-occupancies') return Promise.all(groups.map(async (group) => ({
    groupId: group.id, participantCount: (await summary(group.id)).participantCount,
  })));
  if (/^\/api\/groups\/[0-9a-f-]+\/messages(?:\?.*)?$/i.test(path)) {
    return { messages: [], hasMore: false };
  }
  if (/^\/api\/groups\/[0-9a-f-]+\/presences$/i.test(path)) {
    return [{ userId: user.id, status: 'ONLINE', activityType: null,
      activityName: null, activityStartedAt: null }];
  }
  if (/^\/api\/groups\/[0-9a-f-]+\/presence-changes(?:\?.*)?$/i.test(path)) {
    const query = new URL(path, 'http://localhost').searchParams;
    if (query.has('serverInstanceId') && Number(query.get('version')) === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    return { serverInstanceId: 'e5965682-9948-41b0-b9cf-c12eeb927e53',
      version: 0, changed: !query.has('serverInstanceId') || Number(query.get('version')) !== 0 };
  }
  const group = groups.find((candidate) => path === '/api/groups/' + candidate.id);
  if (group) return { ...group, members: [{ userId: user.id, nickname: user.nickname, avatar: user.avatar,
    role: 'OWNER', joinedAt: '2026-09-12T00:00:00Z' }] };
  if (path.startsWith('/api/rtc/room-summary')) return summary(new URL(path, 'http://localhost').searchParams.get('groupId') ?? testGroupId);
  if (path === '/api/rtc/token') {
    const { groupId } = JSON.parse(body);
    const roomName = roomPrefix + groupId;
    return { serverUrl: liveKitSettings().webSocketUrl, roomName, participantIdentity: 'user-' + user.id,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      token: jwt({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true,
        canPublishSources: ['microphone', 'screen_share'], canPublishData: true, canUpdateOwnMetadata: true }, 'user-' + user.id, user.nickname) };
  }
  throw new Error('未提供测试 API：' + path);
}

const contexts = new WeakMap<BrowserContext, ReturnType<typeof testUser>>();
export async function installAuthenticatedRtc(context: BrowserContext) {
  if (contexts.has(context)) return;
  const user = testUser();
  contexts.set(context, user);
  await context.route(url => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/presence/heartbeat') {
      await route.fulfill({ status: 204 });
      return;
    }
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
export function setTestAvatar(context: BrowserContext, avatar: string) {
  const user = contexts.get(context);
  if (!user) throw new Error('请先安装测试身份');
  user.avatar = avatar;
}
export async function startDesktopApi(nickname = '测试小狼') {
  const user = testUser(nickname);
  const invitationToken = randomBytes(32).toString('base64url');
  let sessionToken: string | undefined;
  const presenceHeartbeats: { status: string; activity: unknown }[] = [];
  let resolvePresencePollStarted!: () => void;
  const presencePollStarted = new Promise<void>((resolve) => { resolvePresencePollStarted = resolve; });
  let cancelledPresencePolls = 0;
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const path = request.url ?? '/';
      if (path === '/api/auth/access/preview' || path === '/api/auth/access/redeem') {
        const access = JSON.parse(body);
        if (request.method !== 'POST' || access.token !== invitationToken
            || (path.endsWith('/redeem') && !/^[A-Za-z0-9_-]{43}$/.test(access.redemptionKey))) {
          response.writeHead(400); response.end(); return;
        }
        response.setHeader('Content-Type', 'application/json');
        if (path.endsWith('/preview')) {
          response.end(JSON.stringify({ kind: 'INVITE', status: 'PENDING', serverName: '测试服务器' }));
        } else {
          sessionToken = randomBytes(32).toString('base64url');
          response.end(JSON.stringify({ sessionToken, user }));
        }
        return;
      }
      // 桌面须先经过真实兑换和主进程会话保存，不能只给页面伪造已登录身份。
      if (!['/api/auth/options', '/api/system/initialization'].includes(path)
          && (!sessionToken || request.headers.authorization !== `Bearer ${sessionToken}`)) {
        response.writeHead(401); response.end(); return;
      }
      if (path === '/api/auth/logout') {
        sessionToken = undefined;
        response.writeHead(204); response.end(); return;
      }
      if (path === '/api/auth/account') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ administrator: user.administrator, recoveryConfigured: true }));
        return;
      }
      if (path === '/api/presence/heartbeat') {
        presenceHeartbeats.push(JSON.parse(body) as { status: string; activity: unknown });
        response.writeHead(204);
        response.end();
        return;
      }
      if (/^\/api\/groups\/[0-9a-f-]+\/presence-changes\?/i.test(path)) {
        resolvePresencePollStarted();
        await new Promise<void>((resolve) => response.once('close', resolve));
        if (!response.writableFinished) cancelledPresencePolls++;
        return;
      }
      const result = await api(path, body, user);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch { response.writeHead(503); response.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 API 未启动');
  const url = 'http://127.0.0.1:' + address.port;
  return { url, accessOffer: { server: url, token: invitationToken }, presenceHeartbeats, presencePollStarted,
    cancelledPresencePollCount: () => cancelledPresencePolls,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())) };
}

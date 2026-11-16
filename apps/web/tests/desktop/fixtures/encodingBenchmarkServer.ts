import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

export async function startEncodingBenchmarkServer() {
  const livekitUrl = process.env.LYCANSYNC_BENCHMARK_LIVEKIT_URL;
  const key = process.env.LYCANSYNC_BENCHMARK_API_KEY;
  const secret = process.env.LYCANSYNC_BENCHMARK_API_SECRET;
  if (!livekitUrl || !key || !secret) throw new Error('请指定独立测试 LiveKit 地址、API key 与 API secret');
  const signingSecret = Buffer.from(secret);
  const addressUrl = new URL(livekitUrl);
  if (!['ws:', 'wss:'].includes(addressUrl.protocol)) throw new Error('测试 LiveKit 地址必须使用 ws 或 wss');
  // 仅使用独立媒体测试实例的凭据，不读取业务服务器的部署密钥或绕过成员鉴权。
  const ca = process.env.LYCANSYNC_BENCHMARK_CA_FILE
    ? readFileSync(resolve(process.env.LYCANSYNC_BENCHMARK_CA_FILE)) : undefined;
  const room = 'lycansync-encoding-benchmark-' + randomUUID();
  function token(video: object, identity: string) {
    const now = Math.floor(Date.now() / 1000);
    const body = [{ alg: 'HS256', typ: 'JWT' },
      { iss: key, sub: identity, nbf: now - 5, exp: now + 180, video }]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return body + '.' + createHmac('sha256', signingSecret).update(body).digest('base64url');
  }
  const sdk = readFileSync(resolve('node_modules/livekit-client/dist/livekit-client.esm.mjs'));
  // 测试直接加载生产需求合并及编码更新函数，不复制另一套实现。
  const modules = new Map(['screenShareViewing', 'screenShareQuality', 'screenShareEncoding'].map((name) => {
    const source = readFileSync(resolve(`src/rtc/${name}.ts`), 'utf8');
    const script = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } })
      .outputText.replace(/(['"])livekit-client\1/g, "'/livekit.js'")
      .replace(/(['"])\.\/screenShareQuality\1/g, "'/screenShareQuality.js'");
    return [`/${name}.js`, script];
  }));
  const server = createServer((req, res) => {
    if (req.url === '/livekit.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(sdk);
    } else if (modules.has(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(modules.get(req.url!));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><script type="module">import * as sdk from "/livekit.js"; window.livekit = sdk;</script></body></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法读取测试页面端口');
  return {
    url: `http://127.0.0.1:${address.port}`, livekitUrl, room,
    publisherToken: token({ room, roomJoin: true, canPublish: true, canSubscribe: false }, 'encoding-publisher'),
    receiverToken: token({ room, roomJoin: true, canPublish: false, canSubscribe: true }, 'encoding-receiver'),
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // 仅删除本次随机房间；未创建成功时的 404 表示无需清理，其他错误必须报告。
      const url = new URL('/twirp/livekit.RoomService/DeleteRoom', livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      await new Promise<void>((resolve, reject) => {
        const req = request(url, { method: 'POST', ca, headers: {
          'Content-Type': 'application/json', Authorization: 'Bearer ' + token({ roomCreate: true }, 'encoding-cleanup'),
        } }, (res) => {
          res.resume();
          res.on('end', () => res.statusCode === 200 || res.statusCode === 404
            ? resolve() : reject(new Error('测试房间清理失败：HTTP ' + res.statusCode)));
        });
        req.setTimeout(10_000, () => req.destroy(new Error('测试房间清理超时')));
        req.on('error', reject);
        req.end(JSON.stringify({ room }));
      });
    },
  };
}

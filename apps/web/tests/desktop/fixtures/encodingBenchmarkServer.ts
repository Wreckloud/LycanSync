import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

export async function startEncodingBenchmarkServer() {
  const host = process.env.LYCANSYNC_BENCHMARK_SSH_HOST ?? 'root@192.168.150.108';
  // 服务密钥只用于签发本次房间的短时令牌，不写测试产物或输出日志。
  const settings = Object.fromEntries(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host,
    'cat /opt/lycansync-invite/.env'], { encoding: 'utf8', timeout: 10_000 }).split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  const key = settings.LIVEKIT_API_KEY;
  const secret = settings.LIVEKIT_API_SECRET;
  if (!key || !secret) throw new Error('测试服务器缺少 LiveKit 配置');
  const livekitUrl = process.env.LYCANSYNC_BENCHMARK_LIVEKIT_URL ?? 'wss://192.168.150.108:8443';
  const ca = readFileSync(resolve(process.env.LYCANSYNC_BENCHMARK_CA_FILE ?? '../../release/server/lycansync-current-local-ca.crt'));
  const room = 'lycansync-encoding-benchmark-' + randomUUID();
  function token(video: object, identity: string) {
    const now = Math.floor(Date.now() / 1000);
    const body = [{ alg: 'HS256', typ: 'JWT' },
      { iss: key, sub: identity, nbf: now - 5, exp: now + 180, video }]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
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
      const url = new URL('/twirp/livekit.RoomService/DeleteRoom', livekitUrl.replace(/^wss:/, 'https:'));
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

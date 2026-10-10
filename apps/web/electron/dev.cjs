const { spawn } = require('node:child_process');
const { resolve } = require('node:path');

async function startDesktopDev() {
  const { createServer } = await import('vite');
  const root = resolve(__dirname, '..');
  const port = Number(process.env.WEB_PORT ?? 4173);
  const server = await createServer({
    root,
    server: {
      host: '127.0.0.1', port, strictPort: true,
      ws: { protocol: 'ws', host: '127.0.0.1', clientPort: port },
    },
  });
  let client;
  let closing = false;
  async function close(exitCode = 0) {
    if (closing) return;
    closing = true;
    client?.kill();
    await server.close();
    process.exitCode = exitCode;
  }
  try {
    await server.listen();
    // 原生产物复用已有构建；界面热更新不触发 Cargo 或媒体采集。
    const env = { ...process.env, LYCANSYNC_DEV_RENDERER_URL: `http://127.0.0.1:${port}/` };
    delete env.ELECTRON_RUN_AS_NODE;
    client = spawn(require('electron'), [resolve(__dirname, 'main.cjs'), ...process.argv.slice(2)], {
      cwd: root, env, stdio: 'inherit',
    });
    client.once('error', (error) => {
      console.error('桌面开发客户端启动失败：', error.message);
      void close(1);
    });
    client.once('exit', (code) => { void close(code ?? 1); });
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    console.log(`桌面开发模式已启动，前端服务仅监听 127.0.0.1:${port}。保存 Vue/CSS 后自动更新。`);
  } catch (error) {
    await close(1);
    throw error;
  }
}

startDesktopDev().catch((error) => {
  console.error('桌面开发模式启动失败：', error.message);
  process.exitCode = 1;
});

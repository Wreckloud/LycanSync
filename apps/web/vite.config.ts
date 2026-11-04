import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const webPort = Number(process.env.WEB_PORT ?? 4173);

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => ({
  envDir: projectRoot,
  plugins: [vue()],
  build: { rollupOptions: { input: { app: 'index.html', overlay: 'overlay.html', viewer: 'viewer.html' } } },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // 私有开发地址从仓库根目录 .env.local 读取，证书仍须受系统信任。
      // 只代理业务 HTTP；音视频和信令由浏览器直接连接 LiveKit。
      // Caddy 按 Host 选择站点。不改写时仍带本机地址，虚拟机会返回空内容。
      '/api': { target: process.env.LYCANSYNC_API_URL
        ?? loadEnv(mode, projectRoot, 'LYCANSYNC_').LYCANSYNC_API_URL ?? 'http://127.0.0.1:18080', changeOrigin: true },
    },
  },
}));

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const webPort = Number(process.env.WEB_PORT ?? 4173);

export default defineConfig({
  plugins: [vue()],
  build: { rollupOptions: { input: { app: 'index.html', overlay: 'overlay.html', viewer: 'viewer.html' } } },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // 浏览器开发与桌面测试连接同一邀请服务器；证书仍须受系统信任。
      // 只代理业务 HTTP；音视频和信令由浏览器直接连接 LiveKit。
      // Caddy 按 Host 选择站点。不改写时仍带本机地址，虚拟机会返回空内容。
      '/api': { target: process.env.LYCANSYNC_API_URL ?? 'https://192.168.150.108', changeOrigin: true },
    },
  },
});
